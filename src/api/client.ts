/**
 * API 客户端 —— REST 调用 + SSE 流式封装
 */
import type {
  Project, Chapter, ChapterNode, AgentState, ChatMessage, Task, TaskLog,
  Provider, ExportRecord, GenerateRequest, ExportRequest, UsageStats,
  MarketScan,
} from '@shared/types';
import type { Genre, GenreCategory } from '@shared/genres';

const BASE = '/api/v1';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const json = await resp.json().catch(() => ({ ok: false, error: { message: '解析失败' } }));
  if (!json.ok) throw new Error(json.error?.message || `请求失败 (${resp.status})`);
  return json.data as T;
}

// 项目
export const api = {
  projects: {
    list: () => req<Project[]>('/projects'),
    get: (id: string) => req<Project>(`/projects/${id}`),
    create: (data: { title: string; type: Project['type']; targetWords: number; summary?: string }) =>
      req<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Project>) =>
      req<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => req(`/projects/${id}`, { method: 'DELETE' }),
    chapters: (id: string) => req<ChapterNode[]>(`/projects/${id}/chapters`),
    addChapter: (id: string, data: Partial<Chapter>) =>
      req<Chapter>(`/projects/${id}/chapters`, { method: 'POST', body: JSON.stringify(data) }),
    state: (id: string) => req<AgentState>(`/projects/${id}/state`),
    updateState: (id: string, data: Partial<AgentState>) =>
      req<AgentState>(`/projects/${id}/state`, { method: 'PATCH', body: JSON.stringify(data) }),
    // AI 生成：透传当前所选 model/providerId（不传则后端回落到 default 旗舰）
    generateSummary: (id: string, model?: string, providerId?: string) =>
      req<{ summary: string }>(`/projects/${id}/generate-summary`, { method: 'POST', body: JSON.stringify({ model, providerId }) }),
    // 封面提示词升级：支持 style（风格预设）/ bookTitle（书名覆盖）/ author（作者署名）/ tone（文风）
    generateCover: (id: string, params: {
      model?: string; providerId?: string;
      style?: string; platform?: string; bookTitle?: string; author?: string; tone?: string;
    }) =>
      req<{ cover: string }>(`/projects/${id}/generate-cover`, { method: 'POST', body: JSON.stringify(params) }),
    // H2+H3 修复(第十一轮): 封面预览图后端代理,避免前端直连第三方导致 CORS + apiKey 暴露
    // 后端拿 provider.apiKey 调 /images/generations,返回 data URL
    coverPreview: (id: string, params: { prompt: string; providerId: string; model: string }) =>
      req<{ image: string; textRendered: boolean }>(`/projects/${id}/cover-preview`, { method: 'POST', body: JSON.stringify(params) }),
    // 整书去 AI 味精修：入队守护进程批量任务，透传模型选择
    refineBook: (id: string, model?: string, providerId?: string) =>
      req<Task>(`/projects/${id}/refine-book`, { method: 'POST', body: JSON.stringify({ model, providerId }) }),
    messages: (id: string) => req<ChatMessage[]>(`/projects/${id}/messages`),
  },
  chapters: {
    update: (id: string, data: Partial<Chapter>) =>
      req<Chapter>(`/chapters/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    // M2 修复(第二十轮): ProjectDetail 编辑器顶栏「删除」按钮调用
    delete: (id: string) => req(`/chapters/${id}`, { method: 'DELETE' }),
    snapshot: (id: string) => req(`/chapters/${id}/snapshot`, { method: 'POST' }),
    generate: (id: string, prompt?: string) =>
      req<Task>(`/chapters/${id}/generate`, { method: 'POST', body: JSON.stringify({ prompt }) }),
    refine: (id: string) => req<Task>(`/chapters/${id}/refine`, { method: 'POST' }),
    // 拖拽排序：把 id 移到 targetId 之前/之后/内部，后端重算同级 order_idx
    move: (id: string, targetId: string, position: 'before' | 'after' | 'inside') =>
      req<Chapter>(`/chapters/${id}/move`, { method: 'PATCH', body: JSON.stringify({ targetId, position }) }),
  },
  chat: {
    // SSE 流式对话：正确解析 event:/data: 事件块
    stream: (params: { projectId: string; message: string; providerId?: string; model?: string; chapterId?: string; webSearch?: boolean },
      onChunk: (delta: string) => void, onMeta?: (m: { messageId: string; intent: string; webSearch?: boolean; action?: 'navigate'; target?: string; taskId?: string; daemonError?: string }) => void): { cancel: () => void; done: Promise<string> } => {
      const controller = new AbortController();
      let full = '';
      // P1 修复(BUG4): 抽取单次请求逻辑为 attempt(),供弱网重连复用。
      //   断网时 reader.read()/fetch reject,原代码无重试 → 弱网体验割裂。
      //   现策略: 未收到任何 chunk(full 为空)且非用户主动 cancel → 指数退避 1s 重试 1 次;
      //   已收到部分 chunk 不重试(避免重复内容);用户主动 cancel 不重试。
      const attempt = async (): Promise<string> => {
        const resp = await fetch(`${BASE}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: controller.signal,
        });
        // F3 修复：校验 resp.ok，4xx/5xx 时响应体是 JSON 错误而非 SSE
        // 原代码直接 resp.body!.getReader() 会把错误 JSON 当 SSE 解析，event 字段为空 → 静默跳过 → 用户看到空气泡
        if (!resp.ok || !resp.body) {
          let errMsg = `请求失败 (${resp.status})`;
          try {
            const errBody = await resp.json();
            if (errBody?.error?.message) errMsg = errBody.error.message;
            else if (errBody?.error) errMsg = typeof errBody.error === 'string' ? errBody.error : errMsg;
          } catch { /* 响应体非 JSON，用默认消息 */ }
          throw new Error(errMsg);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done: rdone, value } = await reader.read();
          if (rdone) break;
          buf += decoder.decode(value, { stream: true });
          // SSE 事件以空行分隔
          const blocks = buf.split('\n\n');
          buf = blocks.pop() || '';
          for (const block of blocks) {
            const lines = block.split('\n');
            let event = '';
            let dataLine = '';
            for (const ln of lines) {
              if (ln.startsWith('event:')) event = ln.slice(6).trim();
              // BUG-7 修复：多行 data 按 SSE 规范用 \n 拼接（原覆盖式赋值只保留最后一行导致截断）
              else if (ln.startsWith('data:')) dataLine = dataLine ? dataLine + '\n' + ln.slice(5).trim() : ln.slice(5).trim();
            }
            if (!dataLine) continue;
            try {
              const obj = JSON.parse(dataLine);
              if (event === 'meta') onMeta?.(obj);
              else if (event === 'chunk' && obj.delta) { full += obj.delta; onChunk(obj.delta); }
              else if (event === 'done' && obj.content) { full = obj.content; }
              else if (event === 'error' && obj.message) throw new Error(obj.message);
            } catch (e) {
              // BUG-7 修复：JSON.parse 失败（SyntaxError，message 含 JSON）时 continue 跳过该块，
              // 不再 throw 终止整个 while 循环；仅业务异常（如 event:error 的 message）才 throw
              if (e instanceof Error && e.message && e.message.includes('JSON')) continue;
              if (e instanceof Error && e.message) throw e;
            }
          }
        }
        return full;
      };
      const done = (async () => {
        try {
          return await attempt();
        } catch (e) {
          // P1 修复(BUG4): 弱网重连 —— 仅当未收到任何 chunk(full 为空)且非用户主动取消时,
          //   指数退避 1s 后重试 1 次。已收到部分 chunk 不重试(避免重复内容)。
          if (!full && !controller.signal.aborted) {
            await new Promise(r => setTimeout(r, 1000));
            // sleep 期间用户可能已取消,二次确认避免无谓重试
            if (controller.signal.aborted) throw e;
            return await attempt();
          }
          throw e;
        }
      })();
      return { cancel: () => controller.abort(), done };
    },
  },
  generate: {
    trigger: (data: GenerateRequest) =>
      req<{ task: Task; project: Project }>('/generate', { method: 'POST', body: JSON.stringify(data) }),
    // BUG1 修复:补 chapterWordBudget 参数,继续写作时透传到后端
    // 原签名漏掉此参数 → ProjectDetail.continueWriting 调用时丢字段 → daemon 回落 infer(取项目历史平均)
    // → 若用户在 Generate 页选了 2000 字,但项目历史章节是 2500 字,续写会用 2500 字 → 字数不一致
    // H3 修复(第十九轮): 补 chapterWordMin/Max 参数,继续写作时透传用户配置的上下限
    continue: (projectId: string, webSearch?: boolean, model?: string, providerId?: string, chapterWordBudget?: number, chapterWordMin?: number, chapterWordMax?: number) =>
      req<{ task: Task; project: Project }>('/generate/continue', { method: 'POST', body: JSON.stringify({ projectId, webSearch, model, providerId, chapterWordBudget, chapterWordMin, chapterWordMax }) }),
  },
  tasks: {
    list: (projectId?: string) => req<Task[]>(`/tasks${projectId ? `?projectId=${projectId}` : ''}`),
    // M5 修复(第二十轮): 删 get(id) 单条查询（前端零调用,Daemon 走 list + SSE 刷新）
    logs: (id: string) => req<TaskLog[]>(`/tasks/${id}/logs`),
    pause: (id: string) => req<Task>(`/tasks/${id}/pause`, { method: 'POST' }),
    resume: (id: string) => req<Task>(`/tasks/${id}/resume`, { method: 'POST' }),
    // 失败重试：保留 checkpoint 续传
    retry: (id: string) => req<Task>(`/tasks/${id}/retry`, { method: 'POST' }),
    // 查看进度并继续：paused/failed → queued
    continueTask: (id: string) => req<Task>(`/tasks/${id}/continue`, { method: 'POST' }),
    cancel: (id: string) => req(`/tasks/${id}/cancel`, { method: 'POST' }),
    daemonStatus: () => req<{ running: number; queued: number; done: number; failed: number; total: number }>('/tasks/daemon/status'),
  },
  models: {
    providers: () => req<Provider[]>('/models/providers'),
    addProvider: (data: Partial<Provider>) =>
      req<Provider>('/models/providers', { method: 'POST', body: JSON.stringify(data) }),
    updateProvider: (id: string, data: Partial<Provider>) =>
      req<Provider>(`/models/providers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteProvider: (id: string) => req(`/models/providers/${id}`, { method: 'DELETE' }),
    testProvider: (id: string) => req<{ ok: boolean; message: string }>(`/models/providers/${id}/test`, { method: 'POST' }),
    setDefault: (id: string) => req(`/models/providers/${id}/default`, { method: 'POST' }),
    // 余额查询（仅 DeepSeek / Kimi 提供接口）
    balance: (id: string) => req<{ available: boolean; balance?: string; message?: string }>(`/models/providers/${id}/balance`),
    // 拉取远端可用模型列表并写回
    fetchModels: (id: string) =>
      req<{ ok: boolean; models: string[]; fetched?: number; provider?: Provider; message?: string }>(`/models/providers/${id}/fetch-models`, { method: 'POST' }),
    // M3 修复(第二十轮): 删 list() 扁平 model 列表查询（前端零调用,Models.tsx 改用 providers() 拿带 models 数组的 provider）
  },
  exports: {
    create: (data: ExportRequest) =>
      req<{ filePath: string; fileName: string }>('/exports', { method: 'POST', body: JSON.stringify(data) }),
    list: (projectId?: string) => req<ExportRecord[]>(`/exports${projectId ? `?projectId=${projectId}` : ''}`),
    downloadUrl: (fileName: string) => `${BASE}/exports/download/${fileName}`,
    // H4 修复(第十九轮): 删除单条导出记录 + 关联文件
    deleteRecord: (id: string) => req<{ id: string }>(`/exports/${id}`, { method: 'DELETE' }),
    // H4 修复(第十九轮): 清空指定项目的全部导出记录 + 关联文件
    clearByProject: (projectId: string) => req<{ deleted: number }>(`/exports/project/${projectId}`, { method: 'DELETE' }),
    // 第二十一修复: 清空全部项目的全部导出记录 + 关联文件
    clearAll: () => req<{ deleted: number }>(`/exports`, { method: 'DELETE' }),
  },
  // 分析工具：市场风向扫榜（风向标）+ 拆书
  analyze: {
    market: (data: { genre: string; genreId?: string; webSearch?: boolean; period?: string }) =>
      req<{ content: string; genre: string; period: string; scanId: string }>('/analyze/market', { method: 'POST', body: JSON.stringify(data) }),
    teardown: (data: { title: string; summary?: string; webSearch?: boolean; focus?: string }) =>
      req<{ content: string; title: string }>('/analyze/teardown', { method: 'POST', body: JSON.stringify(data) }),
    // 风向标历史记录
    marketScanList: (genreId?: string) =>
      req<MarketScan[]>(`/analyze/market-scan${genreId ? `?genreId=${genreId}` : ''}`),
    marketScanGet: (id: string) => req<MarketScan>(`/analyze/market-scan/${id}`),
    marketScanDelete: (id: string) => req<{ deleted: boolean }>(`/analyze/market-scan/${id}`, { method: 'DELETE' }),
  },
  // 题材库：内置 + 用户自定义题材 CRUD
  genres: {
    list: () => req<Genre[]>('/genres'),
    // M6 修复(第二十轮): 删 get(id)（前端零调用,Genres.tsx + GenreSelect 都用 list() 全量缓存再本地过滤）
    create: (data: { id: string; label: string; category: GenreCategory; description?: string; emotionMap?: string }) =>
      req<Genre>('/genres', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<{ label: string; category: GenreCategory; description: string; emotionMap: string }>) =>
      req<Genre>(`/genres/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => req<{ deleted: boolean }>(`/genres/${id}`, { method: 'DELETE' }),
    // AI 补全题材说明: 联网搜索(AnySearch) + LLM 生成详细 description + emotionMap
    enrich: (id: string, params?: { model?: string; providerId?: string; webSearch?: boolean }) =>
      req<{ description: string; emotionMap: string }>(`/genres/${id}/enrich`, { method: 'POST', body: JSON.stringify(params || {}) }),
  },
  // Token 用量
  usage: {
    stats: () => req<UsageStats>('/usage/stats'),
    // M4 修复(第二十轮): 删 list(projectId?)（前端零调用,Settings.tsx 只调 stats() 拉聚合统计）
    // 后端 GET /usage 路由保留,以便未来在 Settings 增加逐条用量记录表时复用
    clear: () => req<{ cleared: boolean }>('/usage', { method: 'DELETE' }),
  },
  // 任务事件 SSE 订阅
  // F4 修复：加 onerror + 指数退避重连
  // 原 bug：EventSource 自带重连，但 readyState 进入 CLOSED 后不会自动恢复
  // 后端持续不可用时任务面板永久停止更新，需用户手动刷新页面
  streamEvents: (onEvent: (e: any) => void): (() => void) => {
    let es: EventSource | null = null;
    let closed = false;
    let reconnectTimer: number | null = null;
    let retryDelay = 1000;
    const MAX_RETRY_DELAY = 30000;
    const connect = () => {
      if (closed) return;
      es = new EventSource(`${BASE}/tasks/stream/events`);
      es.onopen = () => { retryDelay = 1000; }; // 重置退避
      es.onmessage = (e) => {
        try { onEvent(JSON.parse(e.data)); } catch { /* ping */ }
      };
      es.onerror = () => {
        // EventSource CLOSED 状态（readyState=2）表示彻底断开，需手动重连
        if (closed) return;
        es?.close();
        es = null;
        // 指数退避：1s → 2s → 4s → ... → cap 30s
        reconnectTimer = window.setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
          connect();
        }, retryDelay);
      };
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
      es?.close();
      es = null;
    };
  },
};
