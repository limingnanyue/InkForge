/**
 * 联网搜索适配层 —— 接入 AnySearch MCP（JSON-RPC 2.0 over Streamable HTTP）
 * 端点：https://api.anysearch.com/mcp
 * 匿名可用（限速），配置 API Key 可提额；返回结果摘要后注入 LLM 上下文
 *
 * 设计目标：在 LLM 调用前先抓取 5 条相关网页摘要，作为 system prompt 的「实时资料」段，
 * 让生成的剧情、设定、人物更具时效性与真实感（适合年代文、行业文、历史考据）。
 */
import type { WebSearchConfig } from '@shared/types';

const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/mcp';
const DEFAULT_MAX_RESULTS = 5;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOptions {
  query: string;
  apiKey?: string;
  maxResults?: number;
  timeoutMs?: number;
}

/**
 * 调用 anysearch MCP `search` 工具
 * 协议：JSON-RPC 2.0，工具名 "search"，参数 { query, max_results }
 */
export async function searchWeb(opts: WebSearchOptions): Promise<SearchResult[]> {
  const max = Math.min(10, Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS));
  const timeout = opts.timeoutMs ?? 12000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(ANYSEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(opts.apiKey ? { 'Authorization': `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `inkforge-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: { query: opts.query, max_results: max },
        },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      // 静默失败，不阻断主流程
      return [];
    }

    const raw = await resp.text();
    return parseSearchResponse(raw, max);
  } catch {
    // 网络异常 / 超时 / 解析失败 —— 联网搜索是「锦上添花」，失败不影响生成
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// anysearch 返回可能是 JSON-RPC 单条响应，也可能是 SSE 流（多块）；都兼容
function parseSearchResponse(raw: string, max: number): SearchResult[] {
  const candidates: any[] = [];

  // 1) 先按 SSE 事件块尝试
  const blocks = raw.split('\n\n');
  for (const block of blocks) {
    const dataLines = block.split('\n').filter(l => l.startsWith('data:'));
    for (const dl of dataLines) {
      const payload = dl.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { candidates.push(JSON.parse(payload)); } catch { /* skip */ }
    }
  }
  // 2) 若没拿到，按整体 JSON 解析
  if (candidates.length === 0) {
    try { candidates.push(JSON.parse(raw)); } catch { /* skip */ }
  }

  const out: SearchResult[] = [];
  for (const obj of candidates) {
    // JSON-RPC result.content 是 [{ type: 'text', text: '...' }] 或直接数组
    const content = obj?.result?.content ?? obj?.result;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === 'string') {
          pushIfValid(out, item);
        } else if (item?.text) {
          pushIfValid(out, item.text);
        } else if (item?.title && item?.url) {
          out.push({ title: item.title, url: item.url, snippet: item.snippet || item.summary || '' });
        }
      }
    } else if (typeof content === 'string') {
      pushIfValid(out, content);
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

function pushIfValid(out: SearchResult[], text: string): void {
  // anysearch 文本块常为 JSON 串
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      for (const it of parsed) {
        if (it?.title && it?.url) {
          out.push({ title: it.title, url: it.url, snippet: it.snippet || it.summary || it.content || '' });
        }
      }
      return;
    }
    if (parsed?.title && parsed?.url) {
      out.push({ title: parsed.title, url: parsed.url, snippet: parsed.snippet || '' });
      return;
    }
  } catch { /* 不是 JSON，按纯文本兜底 */ }
  if (text.trim()) {
    out.push({ title: text.slice(0, 60), url: '', snippet: text.slice(0, 500) });
  }
}

/**
 * 把搜索结果格式化为可注入 LLM 的「实时资料」system prompt 段
 */
export function formatSearchContext(results: SearchResult[], query: string): string {
  if (results.length === 0) return '';
  const lines = results.map((r, i) =>
    `${i + 1}. ${r.title}${r.url ? ` (${r.url})` : ''}\n   ${r.snippet.slice(0, 300)}`
  );
  return `【联网搜索 · ${query}】\n${lines.join('\n')}`;
}

/**
 * 一站式：搜索 + 格式化为 system 段
 * 供 llm.ts / engine.ts 调用
 */
export async function fetchSearchContext(
  query: string,
  cfg?: WebSearchConfig
): Promise<string> {
  if (!cfg?.enabled) return '';
  const results = await searchWeb({
    query,
    apiKey: cfg.apiKey,
    maxResults: cfg.maxResults ?? DEFAULT_MAX_RESULTS,
  });
  return formatSearchContext(results, query);
}
