/**
 * SQLite 数据库连接与表结构初始化
 * 基于 better-sqlite3，本地零配置
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据目录：可由环境变量覆盖（服务器部署挂载卷）
export const DATA_DIR = process.env.INKFORGE_DATA_DIR || path.join(__dirname, 'data');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
export const DB_PATH = process.env.INKFORGE_DB_PATH || path.join(DATA_DIR, 'inkforge.db');

// 确保数据目录存在
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(EXPORT_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 多 worker 并发时 SQLITE_BUSY 不立即抛错，等待 5s 重试（better-sqlite3 默认 busy_timeout=0）
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('long','short','script')),
  target_words INTEGER NOT NULL DEFAULT 0,
  current_words INTEGER NOT NULL DEFAULT 0,
  summary TEXT DEFAULT '',
  cover_seed TEXT DEFAULT '',
  web_search_enabled INTEGER NOT NULL DEFAULT 0,
  genre TEXT DEFAULT '',
  genre_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES chapter(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  outline TEXT DEFAULT '',
  content TEXT DEFAULT '',
  order_idx INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  -- draft=草稿 / generating=生成中 / done=完成 / failed=失败（可重试）
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','generating','done','failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- M5 修复(第十三轮): oh-story 章节定位六类持久化,前端可在章节树/编辑器稳定展示标签
  positioning TEXT DEFAULT NULL,
  core_emotion TEXT DEFAULT NULL,
  -- C2 修复：禁止章节 parent_id 指向自身（防 ChapterTree 无限递归）
  -- 注意：SQLite 表级 CHECK 必须放在所有列定义之后，否则报 syntax error
  CHECK(parent_id IS NULL OR parent_id != id)
);
CREATE INDEX IF NOT EXISTS idx_chapter_project ON chapter(project_id);
CREATE INDEX IF NOT EXISTS idx_chapter_parent ON chapter(parent_id);

CREATE TABLE IF NOT EXISTS agent_state (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  idea TEXT DEFAULT '',
  setting TEXT DEFAULT '',
  characters TEXT DEFAULT '',
  memory TEXT DEFAULT '',
  review TEXT DEFAULT '',
  revision TEXT DEFAULT '',
  cover TEXT DEFAULT '',
  foreshadowing_json TEXT DEFAULT '[]',
  character_state_json TEXT DEFAULT '[]',
  chapter_summaries_json TEXT DEFAULT '[]',
  volume_outlines_json TEXT DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  config_json TEXT DEFAULT '{}',
  checkpoint_json TEXT DEFAULT '{}',
  message TEXT DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_project ON task(project_id);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_project ON message(project_id);

CREATE TABLE IF NOT EXISTS chapter_snapshot (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT DEFAULT '',
  models TEXT DEFAULT '[]',
  web_search_json TEXT DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_log (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasklog_task ON task_log(task_id);

CREATE TABLE IF NOT EXISTS export_record (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  chapter_range TEXT DEFAULT '',
  file_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Token 用量明细表：每次 LLM 调用一条记录（project_id 可空=全局分析等无项目上下文调用）
CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  provider_id TEXT,
  provider_name TEXT DEFAULT '',
  model TEXT DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokenusage_project ON token_usage(project_id);
CREATE INDEX IF NOT EXISTS idx_tokenusage_created ON token_usage(created_at);

-- 题材库：内置题材 + 用户自定义题材（取代前端硬编码常量）
CREATE TABLE IF NOT EXISTS genre (
  id TEXT PRIMARY KEY,                -- slug 风格 ID（如 'urban-fantasy'）
  label TEXT NOT NULL,                -- 显示名（如"都市玄幻"）
  category TEXT NOT NULL,             -- male / female / common
  description TEXT DEFAULT '',
  emotion_map TEXT DEFAULT '',
  is_builtin INTEGER NOT NULL DEFAULT 0,  -- 1=内置不可删，0=用户自定义
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_genre_category ON genre(category);

-- 市场风向扫榜历史：风向标功能（记录每次扫榜，支持历史回看 + 趋势分析）
CREATE TABLE IF NOT EXISTS market_scan (
  id TEXT PRIMARY KEY,
  genre TEXT NOT NULL,               -- 题材 label（冗余便于列表展示）
  genre_id TEXT,                     -- 题材库 ID（可空，自定义题材时为 null）
  period TEXT DEFAULT '近三个月',
  web_search INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,             -- markdown 报告
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketscan_genre ON market_scan(genre_id);
CREATE INDEX IF NOT EXISTS idx_marketscan_created ON market_scan(created_at);
`;

export function initDb(): void {
  db.exec(SCHEMA);
  migrateLegacySchema();
  seedDefaultProviders();
  ensureKiloProvider();
  ensureKkaiProvider();
  seedBuiltinGenres();
}

// 旧库升级：补列（已存在则跳过）
function migrateLegacySchema(): void {
  const providerCols = (db.prepare("PRAGMA table_info(provider)").all() as { name: string }[]).map(c => c.name);
  if (!providerCols.includes('web_search_json')) {
    db.exec("ALTER TABLE provider ADD COLUMN web_search_json TEXT DEFAULT '{}'");
  }
  const taskCols = (db.prepare("PRAGMA table_info(task)").all() as { name: string }[]).map(c => c.name);
  if (!taskCols.includes('retry_count')) db.exec("ALTER TABLE task ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
  if (!taskCols.includes('max_retries')) db.exec("ALTER TABLE task ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3");
  const projectCols = (db.prepare("PRAGMA table_info(project)").all() as { name: string }[]).map(c => c.name);
  if (!projectCols.includes('web_search_enabled')) db.exec("ALTER TABLE project ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0");
  if (!projectCols.includes('genre')) db.exec("ALTER TABLE project ADD COLUMN genre TEXT DEFAULT ''");
  if (!projectCols.includes('genre_id')) db.exec("ALTER TABLE project ADD COLUMN genre_id TEXT");
  const stateCols = (db.prepare("PRAGMA table_info(agent_state)").all() as { name: string }[]).map(c => c.name);
  if (!stateCols.includes('foreshadowing_json')) db.exec("ALTER TABLE agent_state ADD COLUMN foreshadowing_json TEXT DEFAULT '[]'");
  if (!stateCols.includes('character_state_json')) db.exec("ALTER TABLE agent_state ADD COLUMN character_state_json TEXT DEFAULT '[]'");
  if (!stateCols.includes('chapter_summaries_json')) db.exec("ALTER TABLE agent_state ADD COLUMN chapter_summaries_json TEXT DEFAULT '[]'");
  if (!stateCols.includes('volume_outlines_json')) db.exec("ALTER TABLE agent_state ADD COLUMN volume_outlines_json TEXT DEFAULT '[]'");
  // H1 修复(第十二轮): agent_state 加 outline 列存全书大纲,防长篇主线遗忘
  if (!stateCols.includes('outline')) db.exec("ALTER TABLE agent_state ADD COLUMN outline TEXT DEFAULT ''");

  // M5 修复(第十三轮): 旧库 chapter 表补 positioning/core_emotion 列,让 oh-story 章节定位六类持久化
  const chapterCols = (db.prepare("PRAGMA table_info(chapter)").all() as { name: string }[]).map(c => c.name);
  if (!chapterCols.includes('positioning')) db.exec("ALTER TABLE chapter ADD COLUMN positioning TEXT DEFAULT NULL");
  if (!chapterCols.includes('core_emotion')) db.exec("ALTER TABLE chapter ADD COLUMN core_emotion TEXT DEFAULT NULL");

  // C1 修复：旧库 chapter 表的 CHECK 不含 'failed' 时重建表（SQLite 不支持 ALTER CHECK）
  // 副作用：旧 status='generating' 的卡死章节会被强制回滚为 'draft'，避免再次启动后被 CHECK 拒绝写入 'failed'
  const chapterSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chapter'").get() as { sql: string } | undefined;
  if (chapterSchema && !chapterSchema.sql.includes("'failed'")) {
    // 用 better-sqlite3 的 transaction 包装：异常时自动 ROLLBACK
    // 原裸 BEGIN/COMMIT 无 try/catch，中途失败事务保持打开（better-sqlite3 不自动回滚裸 BEGIN）
    db.transaction(() => {
      db.exec(`CREATE TABLE chapter_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES chapter(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        outline TEXT DEFAULT '',
        content TEXT DEFAULT '',
        order_idx INTEGER NOT NULL DEFAULT 0,
        word_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','generating','done','failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        positioning TEXT DEFAULT NULL,
        core_emotion TEXT DEFAULT NULL,
        CHECK(parent_id IS NULL OR parent_id != id)
      )`);
      // 旧 generating 状态视为无效（启动时无人持有），回滚为 draft
      // 注意：旧库可能无 positioning/core_emotion 列（C1 重建先于 M5 ALTER 时），用 COALESCE 兜底
      const hasOldPositioning = chapterCols.includes('positioning');
      const selectCols = hasOldPositioning
        ? 'id, project_id, parent_id, title, outline, content, order_idx, word_count, CASE WHEN status=\'generating\' THEN \'draft\' ELSE status END, created_at, updated_at, positioning, core_emotion'
        : 'id, project_id, parent_id, title, outline, content, order_idx, word_count, CASE WHEN status=\'generating\' THEN \'draft\' ELSE status END, created_at, updated_at, NULL, NULL';
      db.exec(`INSERT INTO chapter_new (id, project_id, parent_id, title, outline, content, order_idx, word_count, status, created_at, updated_at, positioning, core_emotion)
               SELECT ${selectCols} FROM chapter`);
      db.exec('DROP TABLE chapter');
      db.exec('ALTER TABLE chapter_new RENAME TO chapter');
      db.exec('CREATE INDEX IF NOT EXISTS idx_chapter_project ON chapter(project_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_chapter_parent ON chapter(parent_id)');
    })();
  }
}

// 2026 年 6 月全厂商官方最新 Model ID（OpenAI 兼容协议为默认，Anthropic / Gemini 走原生）
function seedDefaultProviders(): void {
  const count = db.prepare('SELECT COUNT(*) as c FROM provider').get() as { c: number };
  if (count.c > 0) return;
  const now = Date.now();
  // 名称 / kind / baseUrl / 模型列表（按厂商分组，旗舰→高速→低成本）
  const defaults: Array<{ name: string; kind: string; base_url: string; models: string[]; is_default?: number }> = [
    // —— 海外 ——
    { name: 'OpenAI', kind: 'openai', base_url: 'https://api.openai.com/v1',
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'o1-preview', 'gpt-4o', 'gpt-4o-mini', 'gpt-image-2'], is_default: 1 },
    { name: 'Anthropic Claude', kind: 'anthropic', base_url: 'https://api.anthropic.com',
      models: ['claude-4.6-opus-20260205', 'claude-4.6-sonnet-20260217', 'claude-fable-5', 'claude-3-5-haiku'] },
    { name: 'Google Gemini', kind: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta',
      models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
    // —— 国内 ——
    { name: '智谱 GLM', kind: 'glm', base_url: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-5.2-pro', 'glm-5.2-flash', 'glm-4-air'] },
    { name: 'DeepSeek 深度求索', kind: 'deepseek', base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-r1'] },
    { name: '字节豆包 Seed', kind: 'doubao', base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      models: ['seed-write-pro', 'seed-large', 'seed-flash'] },
    { name: '阿里通义 Qwen', kind: 'qwen', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen3.7-turbo', 'qwen3.7-longtext'] },
    { name: '月之暗面 Kimi', kind: 'kimi', base_url: 'https://api.moonshot.cn/v1',
      models: ['kimi-k2.7-main', 'kimi-k2.7-code'] },
    { name: '腾讯混元', kind: 'hunyuan', base_url: 'https://api.hunyuan.cloud.tencent.com/v1',
      models: ['hunyuan-hy3-preview'] },
    { name: '百度文心 ERNIE', kind: 'ernie', base_url: 'https://qianfan.baidubce.com/v2',
      models: ['ernie-bot-5.1', 'ernie-speed-5.1'] },
    // —— 本地部署 ——
    { name: '本地 Ollama', kind: 'ollama', base_url: 'http://localhost:11434/v1',
      models: ['llama-4-scout-17b', 'qwen2.5-32b-instruct', 'deepseek-v4'] },
    // —— 公益免费聚合（OpenAI 兼容，转 OpenRouter，每日免费配额） ——
    { name: 'Kilo 公益聚合', kind: 'kilo', base_url: 'https://api.kilo.ai/api/openrouter',
      models: ['kilo-auto/free', 'qwen/qwen3.6-plus:free', 'minimax/minimax-m2.5:free',
               'nvidia/nemotron-3-super-120b-a12b:free', 'arcee-ai/trinity-large-preview:free',
               'stepfun/step-3.5-flash:free'] },
  ];
  const insert = db.prepare(
    'INSERT INTO provider (id, name, kind, base_url, api_key, models, web_search_json, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  for (const p of defaults) {
    insert.run(cryptoRandomId(), p.name, p.kind, p.base_url, '', JSON.stringify(p.models), '{}', p.is_default ?? 0, now);
  }
}

// 增量补丁：旧 DB 已 seed 过 provider 但缺少 Kilo 公益聚合（2026-06 新增 kind）
// 幂等：若已有 kind='kilo' 的 provider 则跳过
function ensureKiloProvider(): void {
  const row = db.prepare("SELECT id FROM provider WHERE kind='kilo' LIMIT 1").get() as { id: string } | undefined;
  if (row) return;
  const now = Date.now();
  db.prepare(
    'INSERT INTO provider (id, name, kind, base_url, api_key, models, web_search_json, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    cryptoRandomId(),
    'Kilo 公益聚合',
    'kilo',
    'https://api.kilo.ai/api/openrouter',
    '',
    JSON.stringify(['kilo-auto/free', 'qwen/qwen3.6-plus:free', 'minimax/minimax-m2.5:free',
                    'nvidia/nemotron-3-super-120b-a12b:free', 'arcee-ai/trinity-large-preview:free',
                    'stepfun/step-3.5-flash:free']),
    '{}',
    0,
    now
  );
}

// 增量补丁：旧 DB 已 seed 过 provider 但缺少 KKAPI 网关聚合（2026-06 新增 kind）
// 幂等：若已有 kind='kkai' 的 provider 则跳过
// KKAPI（https://kkaiapi.com/）是 OpenAI 兼容的网关聚合，中转 OpenAI/Claude/Gemini/DALL·E/SDXL 等，
// 文本与图像模型走统一 /v1/chat/completions 与 /v1/images/generations 端点
function ensureKkaiProvider(): void {
  const row = db.prepare("SELECT id FROM provider WHERE kind='kkai' LIMIT 1").get() as { id: string } | undefined;
  if (row) return;
  const now = Date.now();
  db.prepare(
    'INSERT INTO provider (id, name, kind, base_url, api_key, models, web_search_json, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    cryptoRandomId(),
    'KKAPI 网关聚合',
    'kkai',
    'https://api.kkaiapi.com/v1',
    '',
    // 文本模型 + 图像模型（gpt-image-2 / dall-e-3 / sd3-large / flux-pro）
    JSON.stringify([
      'gpt-5.6-sol', 'gpt-5.6-terra', 'claude-4.6-sonnet-20260217',
      'gemini-2.5-pro', 'deepseek-v4-pro', 'qwen3.7-turbo',
      'gpt-image-2', 'dall-e-3', 'sd3-large', 'flux-pro-1.1',
    ]),
    '{}',
    0,
    now
  );
}

// 内置题材库 seed：把 shared/genres.ts 的 BUILTIN_GENRES 写入 genre 表
// 幂等：已存在的 id 用 INSERT OR IGNORE 跳过，不覆盖用户对内置题材的修改
// 升级场景：新增的内置题材会自动 seed（不再因「已有内置题材」早返回）
import { BUILTIN_GENRES } from '../shared/genres.js';
function seedBuiltinGenres(): void {
  const now = Date.now();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO genre (id, label, category, description, emotion_map, is_builtin, created_at) VALUES (?,?,?,?,?,?,?)'
  );
  for (const g of BUILTIN_GENRES) {
    insert.run(g.id, g.label, g.category, g.description || '', g.emotionMap || '', 1, now);
  }
}

import { v4 as uuidv4 } from 'uuid';
export function cryptoRandomId(): string {
  return uuidv4();
}
