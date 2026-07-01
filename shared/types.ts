/**
 * InkForge 共享类型定义 —— 前后端契约
 */

// 统一响应
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

// 项目类型
export type ProjectType = 'long' | 'short' | 'script';

export interface Project {
  id: string;
  title: string;
  type: ProjectType;
  targetWords: number;
  currentWords: number;
  summary: string;
  coverSeed: string;
  webSearchEnabled: boolean; // 项目级联网搜索开关（影响对话/生成默认值）
  genre: string;     // 题材 label（如"都市修真"），向后兼容
  genreId?: string;  // 题材库 ID（关联 genre 表，可空表示未指定/自定义）
  createdAt: number;
  updatedAt: number;
}

export type ChapterStatus = 'draft' | 'generating' | 'done' | 'failed';

export interface Chapter {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  outline: string;
  content: string;
  orderIdx: number;
  wordCount: number;
  status: ChapterStatus;
  createdAt: number;
  updatedAt: number;
  // M5 修复(第十三轮): oh-story 章节定位六类持久化到 chapter 表
  // 原: 大纲解析得到的 positioning/coreEmotion 仅存内存 chapters 数组,
  //     chapterRepo.create 不写入 → 重启后 chapterRepo.listByProject 返回的 Chapter 无 positioning →
  //     前端 UI 无法稳定展示标签(章节树/编辑器顶栏)
  positioning?: ChapterPositioning;
  coreEmotion?: string;
}

export interface ChapterNode extends Chapter {
  children: ChapterNode[];
}

// 智能体状态分层（基于 InkOS + oh-story-claudecode 长篇方法论）
// 长篇防跑偏三件套：foreshadowing（伏笔状态机）/ characterState（角色实时状态）/ chapterSummaries（三层摘要归档）

// 伏笔状态机（oh-story）：未埋 → 已埋 → 已回收 / 已过期
// 过期：埋设后超过 expectedRecycleAt 仍未回收 → 自动标 expired，避免悬置伏笔污染剧情
export interface Foreshadow {
  id: string;
  desc: string;          // 伏笔描述
  plantedAt: number;     // 埋设章节序号（orderIdx）
  status: 'planted' | 'paid' | 'expired'; // 已埋设 / 已回收 / 已过期
  expectedRecycleAt?: number; // 预计回收章节（用于过期检测与提醒）
  importance?: 'high' | 'mid' | 'low'; // 重要度：high=主线伏笔必回收
  paidAt?: number;       // 实际回收章节
}

export interface CharacterState {
  name: string;
  location: string;      // 当前所在
  mood: string;          // 当前情绪/状态
  relationships: string; // 与其他角色当前关系
  // 第二十六轮新增(角色热度四态): 规则式计算的出场热度字段,由 updateStateFromGeneration 补全,
  // LLM 不返回(merge 时会丢,需在 merge 后重算补回)。旧数据无此字段,buildDynamicContext 降级到原 slice(-15)。
  lastSeenAt?: number;        // 最后出场章节序号(0-based),用于热度计算与失踪判定
  recentAppearCount?: number; // 最近10章出场次数(滑动窗口),用于热度分级
}

// 章节定位六类（oh-story）：决定本章情绪强度与字数预算，防止每章像短篇、防止情绪扎堆
export type ChapterPositioning =
  | 'high-pressure'   // 高压章：4-5 级冲突，15-20% 占比，字数偏上限
  | 'normal-progress' // 普通推进章：2-3 级，40-50% 占比
  | 'trial-error'     // 修炼试错章：2 级，5-10%
  | 'relationship'    // 关系回收章：2-3 级，5-10%
  | 'low-pressure'    // 低压生活章：1-2 级，≤10%
  | 'info-organize';  // 信息整理章：1 级，≤5%

export interface ChapterSummary {
  idx: number;           // 章节 orderIdx
  title: string;
  summary: string;       // 80-150 字摘要
  positioning?: ChapterPositioning; // 章节定位类型（用于节奏分布统计）
  wordBudget?: number;   // 本章字数预算（实际写多少，用于 Σ 契约校验）
  coreEmotion?: string;  // 本章核心情绪（爽感释放/震撼/痛快/怅然等）
}

// chapter_memo 七段契约（参考 inkos chapter_memo + hook 账本硬对账）
// 作为本章正文生成的硬契约，与 buildChapterAnchor 软约束互补：
//   - anchor 是 prompt 段落（软约束，靠 LLM 自觉遵守）
//   - memo 是结构化字段（硬契约，生成后由 verifyMemoCompliance 规则式硬对账）
// 七段：① 目标 ② 钩子 ③ 伏笔(埋/收/推) ④ 角色弧线 ⑤ 字数预算 ⑥ 情绪强度 ⑦ 承接要点
export interface ChapterMemo {
  idx: number;              // 章节序号(0-based)
  objectives: string;       // 1. 本章目标(必达情节点)
  hook: string;             // 2. 本章钩子(章末200字悬念元素具体描述)
  plantForeshadows: string[];  // 3. 本章埋设的伏笔 desc 列表
  payForeshadows: string[];    // 3. 本章回收的伏笔 desc 列表
  advanceForeshadows: string[];// 3. 本章推进的伏笔 desc 列表
  characterArcs: { name: string; arc: string }[];  // 4. 本章角色弧线节点
  wordBudget: number;       // 5. 字数预算
  emotionIntensity: string; // 6. 情绪强度 + 核心情绪
  carryOver: string;        // 7. 承接要点(上一章末尾场景+必须自然衔接的元素)
  createdAt: number;
}

// 卷级大纲（oh-story 三层结构：全书大纲 → 卷纲 → 细纲）
// 用于长篇分卷管理，每卷有独立的情绪弧线与伏笔集群
export interface VolumeOutline {
  idx: number;             // 卷序号
  title: string;           // 卷名
  premise: string;         // 本卷核心冲突/目标
  emotionArc: string;      // 情绪弧线（如 V形/倒V形/W形/递进/延迟满足/急转弯）
  chapterRange: [number, number]; // 本卷章序号区间 [起, 终]
  keyForeshadows: string[]; // 本卷重点埋设/回收的伏笔 desc
  // H6 修复(第十四轮): 远期卷摘要真压缩缓存
  // 原: buildDynamicContext 远期卷摘要仅"采样 3 条 + 截断 30 字",非真压缩 → 长篇失忆
  // 现: 每卷所有章节完成后调 LLM 压缩成 3 句话(主线推进+伏笔状态+角色弧线),缓存到此字段
  //   buildDynamicContext 优先用 compactedSummary,无则降级到采样
  compactedSummary?: string;
}

// 情感线节点追踪（CP向作品专用，甜宠/虐恋文风下激活）
// 每个 beat 标记情感推进的关键节点，防 CP 互动节奏失控
// 持久化: agent_state.emotion_beats_json（db.ts SCHEMA + migrateLegacySchema）
export interface EmotionBeat {
  idx: number;          // 章节序号
  type: '心动' | '靠近' | '误解' | '分离' | '和好' | '升华' | '日常糖' | '虐点';
  characters: string[]; // 涉及角色名（CP双方）
  desc: string;         // 情感节点描述
}

// 矛盾网三层追踪（oh-story 方法论：章级/卷级/书级矛盾同时运行）
// 每解决一个矛盾必须激活或加深另一个，防单元剧化
// 持久化: agent_state.conflict_lines_json（db.ts SCHEMA + migrateLegacySchema）
export interface ConflictLine {
  id: string;
  desc: string;          // 矛盾描述
  level: 'chapter' | 'volume' | 'book';  // 三层
  status: 'active' | 'resolved' | 'escalated';  // 激活/已解决/已升级
  introducedAt: number;  // 引入章节
  resolvedAt?: number;   // 解决章节
  escalatedTo?: string;  // 升级到的矛盾 id（解决一个必须激活另一个）
}

export interface AgentState {
  projectId: string;
  idea: string;       // 创意：核心点子、题材定位
  setting: string;    // 设定：世界观、规则、背景
  characters: string; // 角色：人物卡、关系网、成长弧
  memory: string;     // 记忆：已发生事件、伏笔、回收点（自然语言总览）
  review: string;     // 审稿：质量评估、节奏诊断
  revision: string;   // 修订：修改建议、版本差异
  cover: string;      // 封面：视觉风格、生成参数
  foreshadowing: Foreshadow[];       // 伏笔状态机（结构化，防遗忘 + 过期检测）
  characterState: CharacterState[];   // 角色实时状态表（防人设漂移）
  chapterSummaries: ChapterSummary[]; // 三层摘要归档（近5章详记 / 十章概要 / 卷总览）
  chapterMemos?: ChapterMemo[];       // 每章 memo 契约(inkos chapter_memo 七段契约, hook 账本硬对账)
  volumeOutlines?: VolumeOutline[];   // 卷级大纲（长篇专用）
  emotionBeats?: EmotionBeat[];       // 情感线节点追踪（CP向作品专用，防 CP 互动节奏失控）
  conflictLines?: ConflictLine[];     // 矛盾网三层追踪（防单元剧化，每解决一个矛盾必须激活另一个）
  outline?: string;  // 全书大纲（H1 修复第十二轮：原仅落 task.checkpoint，正文生成 prompt 看不到全书主线 → 长篇中段跑题/遗忘主线）
  // 风险4修复: 全书主线进度（每10章审稿增量更新，防长篇中后段主线遗忘）
  // 替代 idea 前200字锚点，包含已达成里程碑/未解核心冲突/关键转折点
  mainlineProgress?: string;
  updatedAt: number;
}

// 对话消息
export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  projectId: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

// 守护进程任务
export type TaskType = 'book' | 'short' | 'chapter' | 'refine' | 'refine-book';
export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed';

export interface Task {
  id: string;
  projectId: string;
  type: TaskType;
  status: TaskStatus;
  progress: number;
  config: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  message: string;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskLog {
  id: string;
  taskId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: number;
}

// LLM 提供商（按厂商 kind 区分协议）
export type ProviderKind =
  | 'openai' | 'anthropic' | 'gemini'
  | 'deepseek' | 'qwen' | 'glm' | 'doubao' | 'kimi' | 'hunyuan' | 'ernie'
  | 'kilo'  // Kilo AI 公益聚合（OpenAI 兼容，转 OpenRouter，每日免费配额）
  | 'kkai'  // KKAPI 网关聚合（OpenAI 兼容，https://kkaiapi.com/，文本+图像多模型中转）
  | 'ollama' | 'custom';

// 联网搜索配置（接 anysearch MCP）
export interface WebSearchConfig {
  enabled: boolean;
  apiKey?: string;      // anysearch API Key（可空，匿名限速）
  maxResults?: number;  // 默认 5
}

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string; // 已解密（仅在内存/本地）
  models: string[];
  webSearch: WebSearchConfig; // 该提供商是否启用联网搜索
  isDefault: boolean;
  createdAt: number;
}

export interface ModelConfig {
  temperature: number;
  maxTokens: number;
  topP: number;
}

// LLM 调用
export interface ChatCompletionMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  providerId?: string;
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  webSearch?: boolean; // 本次调用是否启用联网搜索（覆盖 provider.webSearch.enabled）
}

// 一键生成
export type GenerateKind = 'book' | 'short';

// 题材分组定义在 shared/genres.ts(与 BUILTIN_GENRES 同源),此处不再重复定义。
// (第二十六轮清理: 原 GenreGroup 死代码,字段 shape 与 genres.ts 的 GenreGroup 冲突,无任何 import)

export interface GenerateConfig {
  genre: string;        // 具体题材，如"都市修真"（向后兼容：既可存 label 也可存 id）
  genreId?: string;    // 题材库 ID（持久化用，新增字段）
  characters: string;
  hookStyle: string;
  pace: string;
  ending: string;
  viewpoint?: string;  // 视角：第一人称/第三人称
  tone?: string;       // 文风：爽文/慢热/正剧/恶搞
}

// 市场风向扫榜记录（风向标历史数据）
export interface MarketScan {
  id: string;
  genre: string;        // 题材 label（用于展示与去重）
  genreId?: string;     // 题材库 ID
  period: string;       // 时间范围：近一个月/近三个月/近半年
  webSearch: boolean;   // 是否启用联网搜索取材
  content: string;      // LLM 输出的 markdown 报告
  createdAt: number;
}

export interface GenerateRequest {
  projectId?: string;
  title?: string;
  kind: GenerateKind;
  targetWords: number;
  config: GenerateConfig;
  idea?: string;
  webSearch?: boolean; // 生成时是否启用联网搜索取材
  // 每章字数预算（影响大纲章数估算、章节 maxTokens、质量门字数门判定）
  // 不传则按 kind 回落：book=2500，short=5000
  chapterWordBudget?: number;
  // H3 修复(第十九轮): 每章字数上下限 - 用户可自定义浮动范围,替代原硬编码 budget*0.8/1.2
  // 不传则后端按 budget*0.8/1.2 计算(向后兼容)
  // 约束: chapterWordMin <= chapterWordBudget <= chapterWordMax
  chapterWordMin?: number;
  chapterWordMax?: number;
  // 任务级模型选择（不传则回落到 default provider 旗舰模型）
  // 用法：前端从全局 store currentModel/currentProviderId 透传到 generate 接口
  model?: string;
  providerId?: string;
}

// 导出
// P1 修复(BUG1): 新增 'html' —— epub 导出实际生成 HTML,format 字段需诚实标注为 'html'
// 保留 'epub' 仅为兼容历史导出记录,新导出不再产出该标识
export type ExportFormat = 'txt' | 'markdown' | 'html' | 'epub' | 'docx';

export interface ExportRequest {
  projectId: string;
  format: ExportFormat;
  chapterRange?: string;
}

export interface ExportRecord {
  id: string;
  projectId: string;
  format: ExportFormat;
  chapterRange: string;
  filePath: string;
  createdAt: number;
}

// Token 用量（单次 LLM 调用）
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;     // 缓存命中读取的 token（Anthropic/OpenAI 缓存）
  cacheCreationTokens?: number;  // 缓存写入的 token
}

// 用量明细记录（持久化）
export interface TokenUsageRecord {
  id: string;
  projectId: string | null;
  providerId: string | null;
  providerName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  createdAt: number;
}

// 用量统计（设置页展示）
export interface UsageStats {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  callCount: number;
  byProvider: Array<{ providerName: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number; callCount: number }>;
  byProject: Array<{ projectId: string | null; projectName: string; inputTokens: number; outputTokens: number; totalTokens: number; callCount: number }>;
}

// SSE 流式事件
export type StreamEvent =
  | { type: 'chat:chunk'; messageId: string; delta: string }
  | { type: 'chat:done'; messageId: string; content: string }
  | { type: 'task:progress'; taskId: string; progress: number; message: string }
  | { type: 'task:log'; taskId: string; level: string; message: string }
  | { type: 'task:done'; taskId: string }
  | { type: 'task:failed'; taskId: string; message: string }
  | { type: 'error'; message: string };
