/**
 * 多提供商 LLM 适配层
 * 统一接口，支持 OpenAI / Anthropic / Gemini / DeepSeek / 通义 / 智谱 / 豆包 / Kimi / 混元 / 文心 / Ollama / 自定义
 * - 国内厂商均走 OpenAI 兼容协议
 * - Anthropic / Gemini 走原生协议
 * - 可选联网搜索：调用前先抓取摘要注入 system prompt
 * 流式输出通过 async generator 实现
 */
import { providerRepo, usageRepo } from './repos.js';
import { fetchSearchContext } from './websearch.js';
import type { ChatCompletionMessage, Provider, ProviderKind, Usage } from '@shared/types';

// L1 修复：脱敏 provider 错误响应体，防 apiKey 前缀明文泄露到前端
// 部分网关在 4xx 响应体里回显请求的 Authorization header 或 apiKey（如 "Incorrect API key: sk-proj-ABCD..."）
// 该错误经 daemon → task:log → SSE 推送到前端，会被非授权用户看到
function sanitizeErrText(text: string): string {
  return text
    // 抹除 sk-/Bearer 形式的 key（保留前 8 字符便于定位，其余打码）
    .replace(/(sk-[a-zA-Z0-9_-]{8})[a-zA-Z0-9_-]+/g, '$1****')
    .replace(/(Bearer\s+[a-zA-Z0-9_-]{8})[a-zA-Z0-9_-]+/gi, '$1****')
    // 抹除 "key-xxx" 形式（智谱/通义等）
    .replace(/(key-[a-zA-Z0-9]{8})[a-zA-Z0-9]+/gi, '$1****')
    .slice(0, 200);
}

export interface LLMOptions {
  providerId?: string;
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 本次调用是否启用联网搜索（覆盖 provider.webSearch.enabled） */
  webSearch?: boolean;
  /** 联网搜索查询词；缺省时从最后一条 user 消息提炼 */
  searchQuery?: string;
  /**
   * 稳定 system 段（缓存友好）：
   * - 若提供，将作为独立的「可缓存 system 块」前置，Anthropic 会打 cache_control 标记
   * - 与 messages 里的 system 消息合并（稳定段在前，动态段在后）
   * - 长篇生成中 skill prompt + 项目设定 = 稳定段（跨章不变），章节锚点/最近正文 = 动态段（每章变）
   */
  systemStable?: string;
  /** 关联项目 ID（用于 token 用量归集；全局分析等无项目调用可留空） */
  projectId?: string;
  /** usage 回调：流式结束时报送本次调用的 token 用量 */
  onUsage?: (usage: Usage) => void;
  /**
   * 单次调用总耗时上限（毫秒），缺省取 WALL_TIMEOUT_MS（5 分钟）。
   * 长输出场景（如 200 章大纲生成 ~30000 tokens）可放宽到 10-15 分钟避免误杀。
   * 注意：仅在确实长输出的合法场景放宽，不要为短输出场景放宽（会掩盖真实卡死）。
   */
  wallTimeoutMs?: number;
}

// LLM 流式调用防卡死超时（守护进程长篇生成核心保护）
// ① 连接超时 CONNECT_TIMEOUT_MS：fetch 握手阶段挂起时整体中止
//    用 AbortController 实现：response.ok 后立即 clear timer，不污染流式阶段
// ② 读取超时 READ_TIMEOUT_MS：单次 reader.read() 无新数据超过阈值则中止（防服务端发一半挂起）
// ③ 总耗时超时 WALL_TIMEOUT_MS：防止服务端持续发空心跳 keep-alive 但不产出实质内容卡死
//    单章生成正常 1-3 分钟；5 分钟硬上限覆盖所有异常（含空心跳卡死）
// 注意：不可用 AbortSignal.timeout 给 fetch 当 signal —— 它是「从 signal 创建算起 N ms 后强制中止整个 fetch」，
// 包括流式读取阶段，会导致 30s 杀掉正常 1-3 分钟的章节生成
const CONNECT_TIMEOUT_MS = 30000;   // 连接建立 30s
const READ_TIMEOUT_MS = 60000;       // 单次读取 60s 无新数据 → 判定挂起，中止
const WALL_TIMEOUT_MS = 5 * 60 * 1000; // 单次 LLM 调用总耗时上限 5 分钟

// 包装 reader.read()：单次读取超时则抛 AbortError，由调用方重试或失败
async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number, wallDeadline: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 剩余 wall-clock 时间不足一次 read 超时，则用剩余时间作为 read 超时上限
  const remaining = wallDeadline - Date.now();
  const effectiveTimeout = Math.min(timeoutMs, Math.max(5000, remaining));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DOMException('流式读取超时（60s 无新数据，判定 LLM 服务挂起）', 'TimeoutError')), effectiveTimeout);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 连接阶段超时包装：fetch 握手完成（response headers 返回）后立即清除 timer
// 之后流式读取阶段由 readWithTimeout + wallDeadline 自行管理，不被 connect timer 干扰
// 关键差异：AbortSignal.timeout(N) 是「从 signal 创建起 N ms 后中止整个 fetch（含流式）」
// 而 connect-only timeout 只在 headers 未返回前生效，response.ok 后解除
async function fetchWithConnectTimeout(input: string, init: RequestInit, connectTimeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  try {
    const resp = await fetch(input, { ...init, signal: controller.signal });
    // response 已返回 → 握手完成，解除 connect timer，剩余流式阶段由 readWithTimeout 管
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    // 包装为更友好的错误信息
    if ((e as Error).name === 'AbortError') {
      throw new DOMException(`LLM 连接握手超时（${connectTimeoutMs / 1000}s 未返回 response headers）`, 'TimeoutError');
    }
    throw e;
  }
}

export interface LLMProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
}

// 解析为统一的 messages 数组 + 系统消息提取
// 若有 systemStable（缓存友好稳定段），它会作为 system 的「前缀」拼接，保证稳定段在前、动态段在后
function splitSystem(messages: ChatCompletionMessage[], systemStable?: string): { system: string; chat: ChatCompletionMessage[]; stablePrefix: string } {
  const stablePrefix = systemStable?.trim() || '';
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const chat = messages.filter(m => m.role !== 'system');
  // 稳定段在前，动态 system 在后（跨章缓存命中关键）
  const system = stablePrefix ? (sys ? `${stablePrefix}\n\n${sys}` : stablePrefix) : sys;
  return { system, chat, stablePrefix };
}

/**
 * 调用 LLM —— 非流式，返回完整文本 + token 用量
 */
export async function complete(opts: LLMOptions): Promise<{ text: string; usage: Usage }> {
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let acc = '';
  for await (const chunk of streamComplete({ ...opts, onUsage: (u) => { usage = u; } })) {
    acc += chunk;
  }
  return { text: acc, usage };
}

/**
 * 调用 LLM —— 流式，async generator 逐 token 产出
 * 流式结束后自动把本次 usage 写入 token_usage 表（projectId 可空=全局调用）
 */
export async function* streamComplete(opts: LLMOptions): AsyncGenerator<string> {
  const provider = resolveProvider(opts.providerId);
  if (!provider.apiKey && provider.kind !== 'ollama' && provider.kind !== 'kilo') {
    // Ollama 本地部署 / Kilo 公益聚合：无需 API Key
    throw new Error(`提供商 "${provider.name}" 未配置 API Key，请在模型中心设置。`);
  }

  // 联网搜索：若启用，先抓取并注入到 system
  const finalMessages = await maybeInjectWebSearch(opts, provider);

  // 串接 onUsage：内部捕获 usage 用于入库，同时透传给调用方回调
  let captured: Usage | null = null;
  // BUG-5: 累积输出文本，供 provider 未上报 usage 时按字符粗估 token 用量
  let acc = '';
  const userOnUsage = opts.onUsage;
  const optsWithUsage: LLMOptions = {
    ...opts,
    messages: finalMessages,
    onUsage: (u) => {
      captured = u;
      userOnUsage?.(u);
    },
  };

  try {
    switch (provider.kind) {
      case 'anthropic':
        for await (const c of streamAnthropic(provider, optsWithUsage)) { acc += c; yield c; }
        break;
      case 'gemini':
        for await (const c of streamGemini(provider, optsWithUsage)) { acc += c; yield c; }
        break;
      case 'openai':
      case 'deepseek':
      case 'qwen':
      case 'glm':
      case 'doubao':
      case 'kimi':
      case 'hunyuan':
      case 'ernie':
      case 'kilo':  // Kilo 公益聚合走 OpenAI 兼容协议
      case 'ollama':
      case 'custom':
      default:
        for await (const c of streamOpenAICompatible(provider, optsWithUsage)) { acc += c; yield c; }
        break;
    }
  } finally {
    // 流式结束（正常或异常）后入库 usage。best-effort，不影响主流程
    if (captured) {
      try {
        usageRepo.record({
          projectId: opts.projectId ?? null,
          providerId: provider.id,
          providerName: provider.name,
          model: opts.model,
          usage: captured,
        });
      } catch (e) { console.warn('[usage-insert] 失败', (e as Error).message); }
    } else {
      // BUG-5: 未捕获到 usage（provider 不支持 stream_options.include_usage，国产厂商/自定义网关常见）
      // 按 acc.length / 1.5 粗估 token（中文 1 token ≈ 1.5 字符），input 约为 output 的 30%（system+history）
      // model 加 ` (estimated)` 后缀标记，避免与真实 usage 混淆；acc 为本次流式累计的输出文本
      const outputTokens = Math.round(acc.length / 1.5);
      const inputTokens = Math.round(outputTokens * 0.3);
      const estimated: Usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
      try {
        usageRepo.record({
          projectId: opts.projectId ?? null,
          providerId: provider.id,
          providerName: provider.name,
          model: `${opts.model} (estimated)`,
          usage: estimated,
        });
      } catch (e) { console.warn('[usage-insert] 失败', (e as Error).message); }
      console.warn(`[usage] ${provider.name}/${opts.model} 未上报 token 用量，已按字符粗估入库（output≈${outputTokens}, input≈${inputTokens}）`);
    }
  }
}

// 决定是否联网搜索 + 注入 system（注入到「动态段」system，不污染稳定段缓存）
async function maybeInjectWebSearch(opts: LLMOptions, provider: Provider): Promise<ChatCompletionMessage[]> {
  // opts.webSearch 优先，其次 provider.webSearch.enabled
  const enabled = opts.webSearch ?? provider.webSearch.enabled;
  if (!enabled) return opts.messages;

  // 查询词：优先显式传入，否则用最后一条 user 消息
  let query = opts.searchQuery;
  if (!query) {
    const lastUser = [...opts.messages].reverse().find(m => m.role === 'user');
    query = lastUser?.content?.slice(0, 100) || '';
  }
  if (!query) return opts.messages;

  const ctx = await fetchSearchContext(query, provider.webSearch);
  if (!ctx) return opts.messages;

  // 联网结果注入到动态 system 段（不动 systemStable，保证稳定段跨调用缓存命中）
  const msgs = [...opts.messages];
  const sysIdx = msgs.findIndex(m => m.role === 'system');
  if (sysIdx >= 0) {
    msgs[sysIdx] = { role: 'system', content: `${msgs[sysIdx].content}\n\n${ctx}` };
  } else {
    // 没有动态 system 时插到稳定段之后、user 之前
    const firstUser = msgs.findIndex(m => m.role !== 'system');
    msgs.splice(firstUser < 0 ? msgs.length : firstUser, 0, { role: 'system', content: ctx });
  }
  return msgs;
}

function resolveProvider(providerId?: string): Provider {
  const p = providerId ? providerRepo.get(providerId) : providerRepo.getDefault();
  if (!p) throw new Error('未配置任何 LLM 提供商，请先在模型中心添加。');
  return p;
}

// ============ OpenAI 兼容协议（OpenAI / DeepSeek / 通义 / 智谱 / 豆包 / Kimi / 混元 / 文心 / Ollama / 自定义） ============
// OpenAI / DeepSeek 自动 prompt caching 靠前缀匹配：把稳定 system 段作为第一条 message 前置即可命中
async function* streamOpenAICompatible(provider: Provider, opts: LLMOptions): AsyncGenerator<string> {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  // 稳定段前置（OpenAI/DeepSeek 缓存按前缀匹配，稳定段在前即命中）
  const messages = opts.systemStable
    ? [{ role: 'system', content: opts.systemStable }, ...opts.messages]
    : opts.messages;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.85,
    max_tokens: opts.maxTokens ?? 4096,
    stream: true,
  };
  // 部分国产厂商支持 enable_search / web_search 开关，统一传 false（我们已自接 anysearch，避免重复抓取）
  body.enable_search = false;
  // stream_options.include_usage 仅对确认支持的厂商注入：
  //   OpenAI / DeepSeek / 通义 Qwen / Kimi / Kilo / Ollama / custom 明确支持
  //   智谱 GLM / 豆包 Doubao / 混元 Hunyuan / 文心 ERNIE 兼容层 2026 年起均支持 OpenAI 标准 stream_options
  //   R3 修复：原跳过这 4 家导致 usage 永久不入库（token 统计失真）
  //   stream_options 是 OpenAI 标准字段，不支持的厂商通常会忽略而非 400
  const USAGE_OK = new Set(['openai', 'deepseek', 'qwen', 'kimi', 'kilo', 'kkai', 'ollama', 'custom', 'glm', 'doubao', 'hunyuan', 'ernie']);
  if (USAGE_OK.has(provider.kind)) {
    body.stream_options = { include_usage: true };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Ollama 本地 / Kilo 公益无需 Authorization；其余厂商带 Bearer
  if (provider.kind !== 'ollama' && provider.kind !== 'kilo') {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const resp = await fetchWithConnectTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, CONNECT_TIMEOUT_MS);

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`LLM 请求失败 (${resp.status}): ${sanitizeErrText(errText)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reportedUsage: Usage | null = null;
  // wall-clock 截止时刻：超过则中止（防空心跳 keep-alive 卡死）
  // 大纲生成等长输出场景可通过 opts.wallTimeoutMs 放宽（缺省 5 分钟）
  const wallTimeoutMs = opts.wallTimeoutMs && opts.wallTimeoutMs > 0 ? opts.wallTimeoutMs : WALL_TIMEOUT_MS;
  const wallDeadline = Date.now() + wallTimeoutMs;

  try {
    while (true) {
      // 总耗时超时：服务端持续发空心跳但无实质内容，直接中止
      if (Date.now() > wallDeadline) {
        throw new DOMException(`LLM 调用总耗时超时（${wallTimeoutMs / 1000}s，疑似空心跳卡死或输出过长；如反复触发请降低字数/分卷或切换更快的模型）`, 'TimeoutError');
      }
      const { done, value } = await readWithTimeout(reader, READ_TIMEOUT_MS, wallDeadline);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          // 流结束前报送 usage（若有）
          if (reportedUsage) opts.onUsage?.(reportedUsage);
          return;
        }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
          // 捕获 usage（OpenAI 在流末尾的 chunk 附带，choices 为空数组）
          if (json.usage) {
            reportedUsage = {
              inputTokens: Number(json.usage.prompt_tokens ?? 0),
              outputTokens: Number(json.usage.completion_tokens ?? 0),
              totalTokens: Number(json.usage.total_tokens ?? (Number(json.usage.prompt_tokens ?? 0) + Number(json.usage.completion_tokens ?? 0))),
              cacheReadTokens: json.usage.prompt_tokens_details?.cached_tokens ? Number(json.usage.prompt_tokens_details.cached_tokens) : undefined,
            };
          }
        } catch {
          // 忽略解析错误的分片
        }
      }
    }
    // 兜底：未收到 [DONE] 但流已结束时报送
    if (reportedUsage) opts.onUsage?.(reportedUsage);
  } finally {
    // 超时或异常时主动关闭 reader，释放底层连接（防连接泄漏导致后续请求卡死）
    reader.cancel().catch(() => {});
  }
}

// ============ Gemini 原生协议（streamGenerateContent） ============
async function* streamGemini(provider: Provider, opts: LLMOptions): AsyncGenerator<string> {
  const { system, chat } = splitSystem(opts.messages, opts.systemStable);
  const url = `${provider.baseUrl.replace(/\/$/, '')}/models/${opts.model}:streamGenerateContent?alt=sse&key=${provider.apiKey}`;

  const body: Record<string, unknown> = {
    contents: chat.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: {
      temperature: opts.temperature ?? 0.85,
      maxOutputTokens: opts.maxTokens ?? 4096,
    },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const resp = await fetchWithConnectTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, CONNECT_TIMEOUT_MS);

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini 请求失败 (${resp.status}): ${sanitizeErrText(errText)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reportedUsage: Usage | null = null;
  const wallTimeoutMs = opts.wallTimeoutMs && opts.wallTimeoutMs > 0 ? opts.wallTimeoutMs : WALL_TIMEOUT_MS;
  const wallDeadline = Date.now() + wallTimeoutMs;

  try {
    while (true) {
      if (Date.now() > wallDeadline) {
        throw new DOMException(`Gemini 调用总耗时超时（${wallTimeoutMs / 1000}s）`, 'TimeoutError');
      }
      const { done, value } = await readWithTimeout(reader, READ_TIMEOUT_MS, wallDeadline);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const json = JSON.parse(data);
          const text = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || '';
          if (text) yield text;
          // Gemini：每个 chunk 可能都带 usageMetadata，最后一个为最终值
          if (json.usageMetadata) {
            reportedUsage = {
              inputTokens: Number(json.usageMetadata.promptTokenCount ?? 0),
              outputTokens: Number(json.usageMetadata.candidatesTokenCount ?? 0),
              totalTokens: Number(json.usageMetadata.totalTokenCount ?? 0),
              cacheReadTokens: json.usageMetadata.cachedContentTokenCount ? Number(json.usageMetadata.cachedContentTokenCount) : undefined,
            };
          }
        } catch { /* skip */ }
      }
    }
    if (reportedUsage) opts.onUsage?.(reportedUsage);
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ============ Anthropic 原生协议 ============
// 缓存命中关键：稳定段用 cache_control 显式标记 ephemeral，跨章调用复用
// Anthropic 要求同角色连续消息合并，这里做合并处理
async function* streamAnthropic(provider: Provider, opts: LLMOptions): AsyncGenerator<string> {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`;
  const { system, chat, stablePrefix } = splitSystem(opts.messages, opts.systemStable);

  // system 块：稳定段打 cache_control，动态段不打（缓存断点在稳定段末尾）
  let systemBlocks: any[] | undefined;
  if (system) {
    if (stablePrefix) {
      // 稳定段 + 动态段分两块，稳定段打缓存标记
      const stableText = stablePrefix;
      const dynamicText = system.slice(stablePrefix.length).replace(/^\n\n/, '');
      systemBlocks = dynamicText
        ? [
            { type: 'text', text: stableText, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: dynamicText },
          ]
        : [{ type: 'text', text: stableText, cache_control: { type: 'ephemeral' } }];
    } else {
      systemBlocks = [{ type: 'text', text: system }];
    }
  }

  // Anthropic 要求同角色连续消息合并（避免 400 错误），并控制总块数 ≤100
  const merged: { role: string; content: string | any[] }[] = [];
  for (const m of chat) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      // 合并：content 可能是 string 或 array（含 cache_control 的块）
      const lastText = typeof last.content === 'string' ? last.content : last.content.map((b: any) => b.text || '').join('');
      last.content = lastText + '\n\n' + m.content;
    } else {
      merged.push({ role, content: m.content });
    }
  }

  // 第二个 cache_control 断点：当存在稳定历史（如 daemon 传的上一章 assistant）
  // 在倒数第二条消息（assistant 历史）末尾打 cache_control，让历史前缀也缓存命中
  // 仅当历史末尾是 assistant 且后面还有 user（当前轮）时才打，避免污染单轮调用
  if (merged.length >= 2) {
    const lastIdx = merged.length - 1;
    const prevIdx = lastIdx - 1;
    if (merged[prevIdx].role === 'assistant' && merged[lastIdx].role === 'user') {
      const prevText = typeof merged[prevIdx].content === 'string'
        ? merged[prevIdx].content as string
        : (merged[prevIdx].content as any[]).map((b: any) => b.text || '').join('');
      // 历史前缀足够长才打第二个断点（太短无收益）
      if (prevText.length > 200) {
        merged[prevIdx].content = [{ type: 'text', text: prevText, cache_control: { type: 'ephemeral' } }];
      }
    }
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.85,
    stream: true,
    messages: merged,
  };
  if (systemBlocks) body.system = systemBlocks;

  const resp = await fetchWithConnectTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  }, CONNECT_TIMEOUT_MS);

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Anthropic 请求失败 (${resp.status}): ${sanitizeErrText(errText)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  const wallTimeoutMs = opts.wallTimeoutMs && opts.wallTimeoutMs > 0 ? opts.wallTimeoutMs : WALL_TIMEOUT_MS;
  const wallDeadline = Date.now() + wallTimeoutMs;

  try {
    while (true) {
      if (Date.now() > wallDeadline) {
        throw new DOMException(`Anthropic 调用总耗时超时（${wallTimeoutMs / 1000}s）`, 'TimeoutError');
      }
      const { done, value } = await readWithTimeout(reader, READ_TIMEOUT_MS, wallDeadline);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const json = JSON.parse(data);
          if (json.type === 'content_block_delta' && json.delta?.text) {
            yield json.delta.text;
          }
          // message_start：输入 token + 缓存 token
          if (json.type === 'message_start' && json.message?.usage) {
            inputTokens = Number(json.message.usage.input_tokens ?? 0);
            cacheReadTokens = Number(json.message.usage.cache_read_input_tokens ?? 0);
            cacheCreationTokens = Number(json.message.usage.cache_creation_input_tokens ?? 0);
          }
          // message_delta：累计输出 token
          if (json.type === 'message_delta' && json.usage?.output_tokens) {
            outputTokens = Number(json.usage.output_tokens);
          }
        } catch {
          // 忽略
        }
      }
    }
    // 流结束报送 usage
    if (inputTokens > 0 || outputTokens > 0) {
      opts.onUsage?.({
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens: cacheReadTokens || undefined,
        cacheCreationTokens: cacheCreationTokens || undefined,
      });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ============ 连通性测试 ============
export async function testProvider(providerId: string): Promise<{ ok: boolean; message: string }> {
  const provider = providerRepo.get(providerId);
  if (!provider) return { ok: false, message: '提供商不存在' };
  if (!provider.apiKey && provider.kind !== 'ollama' && provider.kind !== 'kilo') {
    return { ok: false, message: '未配置 API Key' };
  }
  try {
    const { text } = await complete({
      providerId,
      model: provider.models[0] || 'gpt-4o-mini',
      messages: [{ role: 'user', content: '请回复"连通"两个字。' }],
      maxTokens: 16,
    });
    return { ok: true, message: `连通成功：${text.slice(0, 40)}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ============ 模型聚合 ============
export function listModels(): { providerId: string; providerName: string; model: string }[] {
  const result: { providerId: string; providerName: string; model: string }[] = [];
  for (const p of providerRepo.list()) {
    for (const m of p.models) {
      result.push({ providerId: p.id, providerName: p.name, model: m });
    }
  }
  return result;
}

// ============ 余额查询（尽力而为：仅支持提供余额接口的厂商）============
export interface BalanceResult {
  available: boolean;     // 该厂商是否提供余额查询
  balance?: string;       // 友好展示字符串，如 "¥ 12.34"
  message?: string;       // 说明
}

export async function getBalance(providerId: string): Promise<BalanceResult> {
  const provider = providerRepo.get(providerId);
  if (!provider) return { available: false, message: '提供商不存在' };
  if (!provider.apiKey && provider.kind !== 'ollama' && provider.kind !== 'kilo') {
    return { available: false, message: '未配置 API Key' };
  }
  // Kilo 公益聚合无余额查询接口，直接提示为公益免费配额
  if (provider.kind === 'kilo') {
    return { available: true, balance: '公益免费 · 每日配额', message: 'Kilo 公益聚合无独立余额查询，每日免费额度用尽后会返回 daily_free_quota_exhausted' };
  }
  const base = provider.baseUrl.replace(/\/$/, '');
  try {
    if (provider.kind === 'deepseek') {
      // DeepSeek: GET /user/balance → 新格式 { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
      // 旧格式 { is_available, balance: { total, used } } 已弃用，兼容回退
      const r = await fetch(`${base}/user/balance`, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return { available: false, message: `查询失败 (${r.status})` };
      const j = await r.json();
      // 优先新格式 balance_infos[0]
      const info = j?.balance_infos?.[0];
      if (info) {
        const total = Number(info.total_balance ?? 0);
        const granted = Number(info.granted_balance ?? 0);
        const toppedUp = Number(info.topped_up_balance ?? 0);
        return {
          available: true,
          balance: `¥ ${total.toFixed(2)}（赠送 ¥${granted.toFixed(2)} + 充值 ¥${toppedUp.toFixed(2)}）`,
        };
      }
      // 兼容旧格式
      const total = Number(j?.balance?.total ?? 0);
      const used = Number(j?.balance?.used ?? 0);
      return { available: true, balance: `¥ ${total.toFixed(2)}（已用 ¥${used.toFixed(2)}）` };
    }
    if (provider.kind === 'glm') {
      // 智谱 GLM: GET /v1/billing/usage → { success, data: { balance, used, cache_used } }（单位 CNY）
      const r = await fetch(`${base}/billing/usage`, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return { available: false, message: `查询失败 (${r.status})` };
      const j = await r.json();
      const data = j?.data ?? j;
      const total = Number(data?.balance ?? 0);
      const used = Number(data?.used ?? 0);
      return { available: true, balance: `¥ ${total.toFixed(2)}（已用 ¥${used.toFixed(2)}）` };
    }
    if (provider.kind === 'kimi') {
      // Moonshot Kimi: GET /v1/users/me/balance → { available_balance, balance }
      const r = await fetch(`${base}/users/me/balance`, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return { available: false, message: `查询失败 (${r.status})` };
      const j = await r.json();
      const avail = Number(j?.available_balance ?? j?.balance ?? 0);
      return { available: true, balance: `¥ ${avail.toFixed(2)}` };
    }
    // OpenAI / Anthropic / Gemini / 通义 / 豆包 / 混元 / 文心 / Ollama / 自定义
    // 均无稳定的公开余额 API → 明确告知
    return {
      available: false,
      message: provider.kind === 'ollama'
        ? '本地部署，无需余额'
        : '该厂商未提供余额查询接口，请前往控制台查看',
    };
  } catch (e) {
    return { available: false, message: (e as Error).message };
  }
}

// ============ 拉取远端可用模型列表 ============
export interface FetchModelsResult {
  ok: boolean;
  models: string[];
  message?: string;
}

export async function listAvailableModels(providerId: string): Promise<FetchModelsResult> {
  const provider = providerRepo.get(providerId);
  if (!provider) return { ok: false, models: [], message: '提供商不存在' };
  if (!provider.apiKey && provider.kind !== 'ollama' && provider.kind !== 'kilo') {
    return { ok: false, models: [], message: '未配置 API Key' };
  }
  const base = provider.baseUrl.replace(/\/$/, '');
  try {
    if (provider.kind === 'anthropic') {
      // GET /v1/models with x-api-key
      const r = await fetch(`${base}/v1/models`, {
        headers: {
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return { ok: false, models: [], message: `拉取失败 (${r.status})` };
      const j = await r.json();
      const ids: string[] = (j?.data ?? []).map((m: any) => m.id).filter(Boolean);
      return { ok: true, models: ids };
    }
    if (provider.kind === 'gemini') {
      // GET /models?key=...
      const r = await fetch(`${base}/models?key=${encodeURIComponent(provider.apiKey)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return { ok: false, models: [], message: `拉取失败 (${r.status})` };
      const j = await r.json();
      const ids: string[] = (j?.models ?? [])
        .map((m: any) => (m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
      return { ok: true, models: ids };
    }
    // 其余均走 OpenAI 兼容 /models
    const headers: Record<string, string> = {};
    if (provider.kind !== 'ollama' && provider.kind !== 'kilo') headers['Authorization'] = `Bearer ${provider.apiKey}`;
    const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { ok: false, models: [], message: `拉取失败 (${r.status})` };
    const j = await r.json();
    const ids: string[] = (j?.data ?? []).map((m: any) => m.id).filter(Boolean);
    return { ok: true, models: ids };
  } catch (e) {
    return { ok: false, models: [], message: (e as Error).message };
  }
}
