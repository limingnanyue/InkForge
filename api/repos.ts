/**
 * 数据访问层 —— 所有表的 CRUD
 */
import { db, cryptoRandomId } from './db.js';
import type {
  Project, Chapter, AgentState, Task, TaskLog, ChatMessage,
  Provider, ExportRecord, ChapterNode, Usage, TokenUsageRecord, UsageStats,
  MarketScan,
} from '@shared/types';
import type { Genre, GenreCategory } from '../shared/genres.js';

const now = () => Date.now();
const parseJSON = (s: string, fallback: unknown) => {
  try { return JSON.parse(s); } catch { return fallback; }
};
const parseJSONArr = <T = unknown>(s: string | null | undefined): T[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v as T[] : [];
  } catch { return []; }
};

// ============ 项目 ============
export const projectRepo = {
  list(): Project[] {
    const rows = db.prepare('SELECT * FROM project ORDER BY updated_at DESC').all() as any[];
    return rows.map(rowToProject);
  },
  get(id: string): Project | null {
    const row = db.prepare('SELECT * FROM project WHERE id = ?').get(id) as any;
    return row ? rowToProject(row) : null;
  },
  create(data: { title: string; type: Project['type']; targetWords: number; summary?: string; webSearchEnabled?: boolean; genre?: string; genreId?: string }): Project {
    const t = now();
    const id = cryptoRandomId();
    db.prepare(
      `INSERT INTO project (id, title, type, target_words, current_words, summary, cover_seed, web_search_enabled, genre, genre_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, data.title, data.type, data.targetWords, 0, data.summary || '', cryptoRandomId(), data.webSearchEnabled ? 1 : 0, data.genre || '', data.genreId || null, t, t);
    // 初始化智能体状态
    db.prepare('INSERT INTO agent_state (project_id, updated_at) VALUES (?,?)').run(id, t);
    return this.get(id)!;
  },
  update(id: string, data: Partial<Pick<Project, 'title' | 'type' | 'targetWords' | 'summary' | 'webSearchEnabled' | 'genre' | 'genreId'>>): Project | null {
    const cur = this.get(id);
    if (!cur) return null;
    db.prepare(
      `UPDATE project SET title=?, type=?, target_words=?, summary=?, web_search_enabled=?, genre=?, genre_id=?, updated_at=? WHERE id=?`
    ).run(
      data.title ?? cur.title, data.type ?? cur.type, data.targetWords ?? cur.targetWords,
      data.summary ?? cur.summary, (data.webSearchEnabled ?? cur.webSearchEnabled) ? 1 : 0,
      data.genre ?? cur.genre, data.genreId ?? cur.genreId ?? null, now(), id
    );
    return this.get(id);
  },
  updateWordCount(id: string): void {
    const r = db.prepare('SELECT COALESCE(SUM(word_count),0) as w FROM chapter WHERE project_id=?').get(id) as { w: number };
    db.prepare('UPDATE project SET current_words=?, updated_at=? WHERE id=?').run(r.w, now(), id);
  },
  delete(id: string): void {
    // 先把 token_usage 的 project_id 置空（保留历史用量，不随项目级联删除）
    // task/chapter/agent_state/message/export_record 仍走原 CASCADE
    db.prepare('UPDATE token_usage SET project_id=NULL WHERE project_id=?').run(id);
    db.prepare('DELETE FROM project WHERE id=?').run(id);
  },
};

// ============ 章节 ============
export const chapterRepo = {
  listByProject(projectId: string): Chapter[] {
    const rows = db.prepare('SELECT * FROM chapter WHERE project_id=? ORDER BY order_idx ASC, created_at ASC').all(projectId) as any[];
    return rows.map(rowToChapter);
  },
  get(id: string): Chapter | null {
    const row = db.prepare('SELECT * FROM chapter WHERE id=?').get(id) as any;
    return row ? rowToChapter(row) : null;
  },
  create(data: { projectId: string; parentId?: string | null; title: string; outline?: string; content?: string; orderIdx?: number }): Chapter {
    const t = now();
    const id = cryptoRandomId();
    const content = data.content || '';
    db.prepare(
      `INSERT INTO chapter (id, project_id, parent_id, title, outline, content, order_idx, word_count, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, data.projectId, data.parentId ?? null, data.title, data.outline || '', content, data.orderIdx ?? 0, countWords(content), 'draft', t, t);
    return this.get(id)!;
  },
  update(id: string, data: Partial<Pick<Chapter, 'title' | 'outline' | 'content' | 'orderIdx' | 'status'>>): Chapter | null {
    const cur = this.get(id);
    if (!cur) return null;
    const title = data.title ?? cur.title;
    const outline = data.outline ?? cur.outline;
    const content = data.content ?? cur.content;
    const orderIdx = data.orderIdx ?? cur.orderIdx;
    const status = data.status ?? cur.status;
    db.prepare(
      `UPDATE chapter SET title=?, outline=?, content=?, order_idx=?, word_count=?, status=?, updated_at=? WHERE id=?`
    ).run(title, outline, content, orderIdx, countWords(content), status, now(), id);
    projectRepo.updateWordCount(cur.projectId);
    return this.get(id);
  },
  delete(id: string): void {
    const ch = this.get(id);
    db.prepare('DELETE FROM chapter WHERE id=?').run(id);
    if (ch) projectRepo.updateWordCount(ch.projectId);
  },
  snapshot(id: string): void {
    const ch = this.get(id);
    if (!ch) return;
    db.prepare('INSERT INTO chapter_snapshot (id, chapter_id, content, created_at) VALUES (?,?,?,?)')
      .run(cryptoRandomId(), id, ch.content, now());
  },
  tree(projectId: string): ChapterNode[] {
    const all = this.listByProject(projectId);
    const map = new Map<string, ChapterNode>();
    all.forEach(c => map.set(c.id, { ...c, children: [] }));
    const roots: ChapterNode[] = [];
    all.forEach(c => {
      const node = map.get(c.id)!;
      // 运行期自环兜底：parentId 指向自身时跳过（防 ChapterTree 无限递归）
      // schema CHECK 已禁止新写入，但兼容历史脏数据
      if (c.parentId && c.parentId !== c.id && map.has(c.parentId)) {
        map.get(c.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    });
    return roots;
  },
};

// ============ 智能体状态 ============
export const stateRepo = {
  get(projectId: string): AgentState | null {
    const row = db.prepare('SELECT * FROM agent_state WHERE project_id=?').get(projectId) as any;
    return row ? rowToState(row) : null;
  },
  update(projectId: string, data: Partial<Omit<AgentState, 'projectId' | 'updatedAt'>>): AgentState | null {
    const cur = this.get(projectId);
    if (!cur) {
      db.prepare('INSERT INTO agent_state (project_id, updated_at) VALUES (?,?)').run(projectId, now());
    }
    const merged = { ...(cur || { projectId: projectId, idea: '', setting: '', characters: '', memory: '', review: '', revision: '', cover: '', foreshadowing: [], characterState: [], chapterSummaries: [], volumeOutlines: [] }), ...data };
    db.prepare(
      `UPDATE agent_state SET idea=?, setting=?, characters=?, memory=?, review=?, revision=?, cover=?,
       foreshadowing_json=?, character_state_json=?, chapter_summaries_json=?, volume_outlines_json=?, updated_at=? WHERE project_id=?`
    ).run(
      merged.idea || '', merged.setting || '', merged.characters || '', merged.memory || '',
      merged.review || '', merged.revision || '', merged.cover || '',
      JSON.stringify(merged.foreshadowing || []), JSON.stringify(merged.characterState || []), JSON.stringify(merged.chapterSummaries || []),
      JSON.stringify(merged.volumeOutlines || []),
      now(), projectId
    );
    return this.get(projectId);
  },
};

// ============ 对话消息 ============
export const messageRepo = {
  // limit=0 表示取全部（兼容老调用方）；H2 修复：避免长对话全量加载
  listByProject(projectId: string, limit = 0): ChatMessage[] {
    const sql = limit > 0
      ? 'SELECT * FROM (SELECT * FROM message WHERE project_id=? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC'
      : 'SELECT * FROM message WHERE project_id=? ORDER BY created_at ASC';
    const rows = (limit > 0
      ? db.prepare(sql).all(projectId, limit)
      : db.prepare(sql).all(projectId)) as any[];
    return rows.map(rowToMessage);
  },
  create(data: { projectId: string; role: ChatMessage['role']; content: string }): ChatMessage {
    const t = now();
    const id = cryptoRandomId();
    db.prepare('INSERT INTO message (id, project_id, role, content, created_at) VALUES (?,?,?,?,?)')
      .run(id, data.projectId, data.role, data.content, t);
    return { id, projectId: data.projectId, role: data.role, content: data.content, createdAt: t };
  },
};

// ============ 任务 ============
export const taskRepo = {
  list(projectId?: string): Task[] {
    const rows = projectId
      ? db.prepare('SELECT * FROM task WHERE project_id=? ORDER BY created_at DESC').all(projectId) as any[]
      : db.prepare('SELECT * FROM task ORDER BY created_at DESC').all() as any[];
    return rows.map(rowToTask);
  },
  get(id: string): Task | null {
    const row = db.prepare('SELECT * FROM task WHERE id=?').get(id) as any;
    return row ? rowToTask(row) : null;
  },
  create(data: { projectId: string; type: Task['type']; config?: Record<string, unknown>; maxRetries?: number }): Task {
    const t = now();
    const id = cryptoRandomId();
    db.prepare(
      'INSERT INTO task (id, project_id, type, status, progress, config_json, checkpoint_json, message, retry_count, max_retries, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(id, data.projectId, data.type, 'queued', 0, JSON.stringify(data.config || {}), '{}', '', 0, data.maxRetries ?? 3, t, t);
    return this.get(id)!;
  },
  update(id: string, data: Partial<Pick<Task, 'status' | 'progress' | 'message' | 'checkpoint' | 'retryCount'>>): Task | null {
    const cur = this.get(id);
    if (!cur) return null;
    db.prepare(
      `UPDATE task SET status=?, progress=?, message=?, checkpoint_json=?, retry_count=?, updated_at=? WHERE id=?`
    ).run(
      data.status ?? cur.status, data.progress ?? cur.progress, data.message ?? cur.message,
      JSON.stringify(data.checkpoint ?? cur.checkpoint), data.retryCount ?? cur.retryCount, now(), id
    );
    return this.get(id);
  },
  delete(id: string): void {
    db.prepare('DELETE FROM task WHERE id=?').run(id);
  },
  claimNext: db.transaction((): Task | null => {
    // 心跳回收：worker 崩溃/卡死时任务会卡在 running 状态，updated_at 停滞
    // 超过 5 分钟未心跳的 running 任务视为僵尸，重置为 queued 让其他 worker 重新认领
    // 5 分钟阈值：单章生成正常 1-3 分钟，状态写入频繁；超过 5 分钟必为异常
    const STALE_MS = 5 * 60 * 1000;
    const staleThreshold = Date.now() - STALE_MS;
    db.prepare(
      "UPDATE task SET status='queued', message='心跳超时回收（worker 崩溃或卡死），重新排队' WHERE status='running' AND updated_at < ?"
    ).run(staleThreshold);

    // 原子认领：UPDATE...WHERE id=(SELECT...) 让其他 worker 并发时不会重复认领
    // SQLite 单写锁 + transaction 保证 SELECT 到 UPDATE 之间无并发干扰
    const row = db.prepare("SELECT * FROM task WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get() as any;
    if (!row) return null;
    // D4 修复：检查 UPDATE.changes，多 worker 部署下防重复认领
    // 单进程同步事务下 changes 必为 1；多进程 WAL 模式下若另一进程已抢先认领，changes=0 应返回 null
    const result = db.prepare("UPDATE task SET status='running', updated_at=? WHERE id=? AND status='queued'").run(now(), row.id);
    if (result.changes !== 1) return null;
    return rowToTask(row);
  }),
  // 心跳：仅刷新 updated_at，供 claimNext 心跳超时回收判断使用
  // M7 修复：长流式 chunk 累加过程中周期性调用，避免 5min 阈值误回收正常慢段
  heartbeat(id: string): void {
    db.prepare('UPDATE task SET updated_at=? WHERE id=?').run(now(), id);
  },
  // 失败重试：保留 checkpoint，状态置回 queued，retry_count+1（未超 max_retries 时返回任务，否则返回 null）
  retry(id: string): Task | null {
    const cur = this.get(id);
    if (!cur) return null;
    if (cur.retryCount >= cur.maxRetries) return null;
    const next = cur.retryCount + 1;
    db.prepare(
      "UPDATE task SET status='queued', progress=0, message=?, retry_count=?, updated_at=? WHERE id=?"
    ).run(`第 ${next} 次重试中`, next, now(), id);
    return this.get(id);
  },
  // 查看进度并继续：仅 paused/failed 状态可继续
  resumeFromCheckpoint(id: string): Task | null {
    const cur = this.get(id);
    if (!cur) return null;
    if (cur.status !== 'paused' && cur.status !== 'failed') return null;
    db.prepare("UPDATE task SET status='queued', updated_at=? WHERE id=?").run(now(), id);
    return this.get(id);
  },
};

// ============ 任务日志 ============
export const taskLogRepo = {
  listByTask(taskId: string): TaskLog[] {
    const rows = db.prepare('SELECT * FROM task_log WHERE task_id=? ORDER BY created_at ASC').all(taskId) as any[];
    return rows.map(r => ({ id: r.id, taskId: r.task_id, level: r.level, message: r.message, createdAt: r.created_at }));
  },
  create(taskId: string, level: TaskLog['level'], message: string): void {
    db.prepare('INSERT INTO task_log (id, task_id, level, message, created_at) VALUES (?,?,?,?,?)')
      .run(cryptoRandomId(), taskId, level, message, now());
  },
};

// ============ 提供商 ============
export const providerRepo = {
  list(): Provider[] {
    const rows = db.prepare('SELECT * FROM provider ORDER BY created_at ASC').all() as any[];
    return rows.map(rowToProvider);
  },
  get(id: string): Provider | null {
    const row = db.prepare('SELECT * FROM provider WHERE id=?').get(id) as any;
    return row ? rowToProvider(row) : null;
  },
  getDefault(): Provider | null {
    const row = db.prepare('SELECT * FROM provider WHERE is_default=1 LIMIT 1').get() as any;
    return row ? rowToProvider(row) : (this.list()[0] || null);
  },
  create(data: { name: string; kind: Provider['kind']; baseUrl: string; apiKey?: string; models?: string[]; webSearch?: Provider['webSearch'] }): Provider {
    const id = cryptoRandomId();
    db.prepare(
      'INSERT INTO provider (id, name, kind, base_url, api_key, models, web_search_json, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, data.name, data.kind, data.baseUrl, data.apiKey || '', JSON.stringify(data.models || []), JSON.stringify(data.webSearch || { enabled: false }), 0, now());
    return this.get(id)!;
  },
  update(id: string, data: Partial<Pick<Provider, 'name' | 'kind' | 'baseUrl' | 'apiKey' | 'models' | 'webSearch'>>): Provider | null {
    const cur = this.get(id);
    if (!cur) return null;
    db.prepare('UPDATE provider SET name=?, kind=?, base_url=?, api_key=?, models=?, web_search_json=? WHERE id=?')
      .run(
        data.name ?? cur.name, data.kind ?? cur.kind, data.baseUrl ?? cur.baseUrl,
        data.apiKey ?? cur.apiKey, JSON.stringify(data.models ?? cur.models),
        JSON.stringify(data.webSearch ?? cur.webSearch), id
      );
    return this.get(id);
  },
  setDefault(id: string): void {
    db.prepare('UPDATE provider SET is_default=0').run();
    db.prepare('UPDATE provider SET is_default=1 WHERE id=?').run(id);
  },
  delete(id: string): void {
    // H4 修复：保留历史用量记录但置 NULL provider_id（与 projectRepo.delete 处理 token_usage 一致）
    db.prepare('UPDATE token_usage SET provider_id=NULL WHERE provider_id=?').run(id);
    db.prepare('DELETE FROM provider WHERE id=?').run(id);
  },
};

// ============ 导出记录 ============
export const exportRepo = {
  list(projectId?: string): ExportRecord[] {
    const rows = projectId
      ? db.prepare('SELECT * FROM export_record WHERE project_id=? ORDER BY created_at DESC').all(projectId) as any[]
      : db.prepare('SELECT * FROM export_record ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({ id: r.id, projectId: r.project_id, format: r.format, chapterRange: r.chapter_range, filePath: r.file_path, createdAt: r.created_at }));
  },
  create(data: { projectId: string; format: ExportRecord['format']; chapterRange?: string; filePath: string }): ExportRecord {
    const id = cryptoRandomId();
    const chapterRange = data.chapterRange || '';
    db.prepare('INSERT INTO export_record (id, project_id, format, chapter_range, file_path, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, data.projectId, data.format, chapterRange, data.filePath, now());
    return { id, projectId: data.projectId, format: data.format, chapterRange, filePath: data.filePath, createdAt: now() };
  },
};

// ============ Token 用量 ============
export const usageRepo = {
  record(data: {
    projectId?: string | null;
    providerId?: string | null;
    providerName?: string;
    model?: string;
    usage: Usage;
  }): void {
    const u = data.usage;
    const total = u.totalTokens || (u.inputTokens + u.outputTokens);
    db.prepare(
      `INSERT INTO token_usage (id, project_id, provider_id, provider_name, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      cryptoRandomId(),
      data.projectId ?? null,
      data.providerId ?? null,
      data.providerName || '',
      data.model || '',
      u.inputTokens || 0,
      u.outputTokens || 0,
      total || 0,
      u.cacheReadTokens || 0,
      u.cacheCreationTokens || 0,
      now()
    );
  },
  list(projectId?: string): TokenUsageRecord[] {
    const rows = projectId
      ? db.prepare('SELECT * FROM token_usage WHERE project_id=? ORDER BY created_at DESC LIMIT 200').all(projectId) as any[]
      : db.prepare('SELECT * FROM token_usage ORDER BY created_at DESC LIMIT 200').all() as any[];
    return rows.map(this.rowToRecord);
  },
  getStats(): UsageStats {
    const agg = db.prepare(
      `SELECT
         COALESCE(SUM(input_tokens),0) AS totalInput,
         COALESCE(SUM(output_tokens),0) AS totalOutput,
         COALESCE(SUM(total_tokens),0) AS totalTokens,
         COALESCE(SUM(cache_read_tokens),0) AS totalCacheRead,
         COALESCE(SUM(cache_creation_tokens),0) AS totalCacheCreation,
         COUNT(*) AS callCount
       FROM token_usage`
    ).get() as { totalInput: number; totalOutput: number; totalTokens: number; totalCacheRead: number; totalCacheCreation: number; callCount: number };

    const byProviderRows = db.prepare(
      `SELECT provider_name AS providerName, model,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
              SUM(total_tokens) AS totalTokens, COUNT(*) AS callCount
       FROM token_usage GROUP BY provider_name, model ORDER BY totalTokens DESC LIMIT 20`
    ).all() as any[];

    const byProjectRows = db.prepare(
      `SELECT t.project_id AS projectId, p.title AS projectName,
              SUM(t.input_tokens) AS inputTokens, SUM(t.output_tokens) AS outputTokens,
              SUM(t.total_tokens) AS totalTokens, COUNT(*) AS callCount
       FROM token_usage t LEFT JOIN project p ON p.id = t.project_id
       GROUP BY t.project_id ORDER BY totalTokens DESC LIMIT 20`
    ).all() as any[];

    return {
      ...agg,
      byProvider: byProviderRows,
      byProject: byProjectRows.map(r => ({ ...r, projectName: r.projectName || '（全局/无项目）' })),
    };
  },
  rowToRecord(r: any): TokenUsageRecord {
    return {
      id: r.id, projectId: r.project_id, providerId: r.provider_id, providerName: r.provider_name,
      model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      totalTokens: r.total_tokens, cacheReadTokens: r.cache_read_tokens,
      cacheCreationTokens: r.cache_creation_tokens, createdAt: r.created_at,
    };
  },
  deleteForProject(projectId: string): void {
    db.prepare('DELETE FROM token_usage WHERE project_id=?').run(projectId);
  },
};

// ============ 题材库 ============
function rowToGenre(row: any): Genre {
  return {
    id: row.id,
    label: row.label,
    category: row.category as GenreCategory,
    description: row.description || '',
    emotionMap: row.emotion_map || '',
    isBuiltin: !!row.is_builtin,
  };
}

export const genreRepo = {
  list(): Genre[] {
    const rows = db.prepare('SELECT * FROM genre ORDER BY category ASC, label ASC').all() as any[];
    return rows.map(rowToGenre);
  },
  listByCategory(category: GenreCategory): Genre[] {
    const rows = db.prepare('SELECT * FROM genre WHERE category=? ORDER BY label ASC').all(category) as any[];
    return rows.map(rowToGenre);
  },
  get(id: string): Genre | null {
    const row = db.prepare('SELECT * FROM genre WHERE id=?').get(id) as any;
    return row ? rowToGenre(row) : null;
  },
  create(data: { id: string; label: string; category: GenreCategory; description?: string; emotionMap?: string }): Genre {
    const now = Date.now();
    db.prepare(
      'INSERT INTO genre (id, label, category, description, emotion_map, is_builtin, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(data.id, data.label, data.category, data.description || '', data.emotionMap || '', 0, now);
    return this.get(data.id)!;
  },
  update(id: string, data: { label?: string; category?: GenreCategory; description?: string; emotionMap?: string }): Genre | null {
    const cur = this.get(id);
    if (!cur) return null;
    db.prepare(
      'UPDATE genre SET label=?, category=?, description=?, emotion_map=? WHERE id=?'
    ).run(data.label ?? cur.label, data.category ?? cur.category, data.description ?? cur.description, data.emotionMap ?? cur.emotionMap, id);
    return this.get(id);
  },
  delete(id: string): void {
    // 内置题材不可删（前端会拦截，后端再校验一次兜底）
    const cur = this.get(id);
    if (cur?.isBuiltin) throw new Error('内置题材不可删除');
    db.prepare('DELETE FROM genre WHERE id=?').run(id);
  },
};

// ============ 市场风向扫榜历史 ============
function rowToMarketScan(row: any): MarketScan {
  return {
    id: row.id,
    genre: row.genre,
    genreId: row.genre_id || undefined,
    period: row.period || '近三个月',
    webSearch: !!row.web_search,
    content: row.content ?? '',  // list 接口 SELECT 不含 content，兜底空串
    createdAt: row.created_at,
  };
}

export const marketScanRepo = {
  // H3 修复：list 不取 content（单条可达万字），详情用 get(id) 按需取
  list(genreId?: string): MarketScan[] {
    const sql = 'SELECT id, genre, genre_id, period, web_search, created_at FROM market_scan';
    const rows = genreId
      ? db.prepare(sql + ' WHERE genre_id=? ORDER BY created_at DESC LIMIT 50').all(genreId) as any[]
      : db.prepare(sql + ' ORDER BY created_at DESC LIMIT 50').all() as any[];
    return rows.map(rowToMarketScan);
  },
  get(id: string): MarketScan | null {
    const row = db.prepare('SELECT * FROM market_scan WHERE id=?').get(id) as any;
    return row ? rowToMarketScan(row) : null;
  },
  create(data: { genre: string; genreId?: string; period: string; webSearch: boolean; content: string }): MarketScan {
    const id = cryptoRandomId();
    const now = Date.now();
    db.prepare(
      'INSERT INTO market_scan (id, genre, genre_id, period, web_search, content, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(id, data.genre, data.genreId || null, data.period, data.webSearch ? 1 : 0, data.content, now);
    return this.get(id)!;
  },
  delete(id: string): void {
    db.prepare('DELETE FROM market_scan WHERE id=?').run(id);
  },
};

// ============ 行映射 ============
function countWords(text: string): number {
  if (!text) return 0;
  // 中英文混合字数统计：中文按字，英文按词
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const english = (text.replace(/[\u4e00-\u9fa5]/g, ' ').trim().match(/\S+/g) || []).length;
  return chinese + english;
}

function rowToProject(r: any): Project {
  return {
    id: r.id, title: r.title, type: r.type, targetWords: r.target_words,
    currentWords: r.current_words, summary: r.summary, coverSeed: r.cover_seed,
    webSearchEnabled: r.web_search_enabled === 1,
    genre: r.genre ?? '', genreId: r.genre_id ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToChapter(r: any): Chapter {
  return {
    id: r.id, projectId: r.project_id, parentId: r.parent_id, title: r.title,
    outline: r.outline, content: r.content, orderIdx: r.order_idx,
    wordCount: r.word_count, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToState(r: any): AgentState {
  return {
    projectId: r.project_id, idea: r.idea, setting: r.setting, characters: r.characters,
    memory: r.memory, review: r.review, revision: r.revision, cover: r.cover,
    foreshadowing: parseJSONArr(r.foreshadowing_json),
    characterState: parseJSONArr(r.character_state_json),
    chapterSummaries: parseJSONArr(r.chapter_summaries_json),
    volumeOutlines: parseJSONArr(r.volume_outlines_json),
    updatedAt: r.updated_at,
  };
}
function rowToTask(r: any): Task {
  return {
    id: r.id, projectId: r.project_id, type: r.type, status: r.status, progress: r.progress,
    config: parseJSON(r.config_json, {}), checkpoint: parseJSON(r.checkpoint_json, {}),
    message: r.message, retryCount: r.retry_count ?? 0, maxRetries: r.max_retries ?? 3,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToMessage(r: any): ChatMessage {
  return { id: r.id, projectId: r.project_id, role: r.role, content: r.content, createdAt: r.created_at };
}
function rowToProvider(r: any): Provider {
  const ws = parseJSON(r.web_search_json, { enabled: false }) as Provider['webSearch'];
  return {
    id: r.id, name: r.name, kind: r.kind, baseUrl: r.base_url, apiKey: r.api_key,
    models: parseJSON(r.models, []), webSearch: ws && typeof ws.enabled === 'boolean' ? ws : { enabled: false },
    isDefault: r.is_default === 1, createdAt: r.created_at,
  };
}

export { countWords };
