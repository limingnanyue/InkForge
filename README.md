# InkForge 墨铸 · AI 写作工作台

> 基于 AI 的中文长篇小说 / 短篇创作平台，本地零配置开箱即用。

InkForge 把"百万字长篇"这种高难度创作拆解成可断点续传的流水线：扫榜取材 → 大纲架构 → 分章生成 → 章末精修 → 一致性归档。配套守护进程任务队列、多模型路由、联网搜索取材、题材市场风向标、Token 用量统计等完整工具链。

---

## 核心特性

### 创作能力
- **百万字长篇流水线**：扫榜 → 卷纲 → 分章大纲 → 逐章生成 → 精修，支持断点续传
- **最高 500 万字超长篇**：按 2500 字/章切分章数，>200 章自动启用分卷大纲生成（20 章/卷），逐卷调 LLM 合并
- **世界观 + 角色档案 setup 阶段**：扫榜后自动生成世界观设定与角色档案落库
- **章节质量门（七维质检）**：字数门 + 跑题门 + AI 味门 + 情感门 + 冲突门 + 伏笔门 + 节奏门，不达标自动重写
- **chapter_memo 七段契约**：每章生成前先产出结构化 memo（目标/钩子/伏笔埋收推/角色弧线/字数预算/情绪强度/承接要点），生成后 verifyMemoCompliance 规则式硬对账（伏笔关键词 + 章末钩子信号词）
- **整书去 AI 味精修**：前 30 章黄金追读区 + 末尾 20% 章节精修，7 Gate 去 AI 味（禁用词替换/句式去套路/心理外化/节奏打碎/对话去腔调/结尾去升华/去解释腔）
- **短篇一键生成**：分段大纲 + 顺序生成 + 精修，二十万字以内开箱即得
- **单章生成 / 续写 / 精修**：对话式触发，含快照回滚
- **oh-story 三层归档**：近 5 章详记 + 中 10 章概要 + 卷级总览，防长篇人设跑偏
- **伏笔状态机**：未埋 / 已埋 / 已回收 / 已过期 四态追踪，主线伏笔（high）永不自动过期防长篇误判丢失，自动提示回收时机
- **角色热度四态**：核心（recentAppearCount≥5）/ 活跃（2-4）完整注入 + 边缘（1）/ 失踪（0 或 >20 章未出场）仅名注入 + 主角保底，防人设漂移
- **剧情设计三件套**：① 情感线节点追踪（CP 向作品，心动/靠近/误解/分离/和好/升华节奏）② 矛盾网三层状态机（章级/卷级/书级，解决必须激活新矛盾防单元剧化）③ 卷级伏笔集群填充（按 plantedAt/expectedRecycleAt 预填 keyForeshadows）
- **全书主线进度锚点**：每 10 章审稿增量更新 mainlineProgress（已达成里程碑 + 未解核心冲突 + 关键转折点），替代 idea 前 200 字锚点，防中后段主线遗忘
- **章节定位六类配额**：高压章/普通推进/修炼试错/关系回收/低压生活/信息整理，含连续 run 检测（高压/低压连续 >2 章告警防节奏疲劳）
- **AI 生成封面提示词**：10 种风格预设 + 书名覆盖 + 作者署名，风格与作者跨项目记忆

### 文风系统
- **13 项文风预设**：爽文 / 慢热 / 正剧 / 恶搞 / 黑色幽默 + 甜宠 / 治愈 / 虐恋 / 群像 / 悬疑 / 无限流 / 系统流 / 年代文
- **文风全链路消费**：tone 在 setup（世界观/角色档案）/ outline（大纲 + Σ契约密疏点配比）/ write（正文生成）三阶段注入，文风真正影响生成结果
- **emotionDensity 密疏点配比**：dense（密3疏2）/ normal（密2疏3）/ sparse（密1疏4），影响大纲情节点密度
- **按项目类型过滤**：短篇过滤掉无限流/系统流/年代文等长篇专属文风
- **前后端同源管理**：shared/tone-presets.ts 统一维护文风指令表

### 模型与基础设施
- **多模型路由**：OpenAI / Claude / Gemini + 国内 8 家（智谱 / DeepSeek / 豆包 / 通义 / Kimi / 混元 / 文心）+ Kilo 公益聚合 + KKAPI 网关 + 本地 Ollama
- **国产模型适配**：tokenCharRatio 按厂商放大 token 预算（国产 1.8×），防 maxTokens 截断；质检/大纲/正文各阶段均乘系数
- **守护进程任务队列**：心跳回收 + 自动重试 + 指数退避 + 断点续传
- **章节级容错**：单章 LLM 调用失败不中断整本书（章节级重试 3 次 + 跳过继续），400/内容拒绝直接跳过，429/timeout/网络错误重试
- **动态 wallTimeout**：章节正文按 maxTokens 动态计算超时（max(8min, maxTokens×100ms)），防慢模型误杀
- **联网搜索取材**：可按项目 / 按任务开关，扫榜 / 取材阶段注入实时热点
- **题材市场风向标**：扫榜分析 + 历史回看 + 趋势对比
- **Token 用量统计**：分项目 / 分模型 / 分时段明细
- **多模型余额查询**：DeepSeek / Kimi / GLM 等独立计费 API

### 工程质量
- **零配置本地启动**：better-sqlite3 文件库，无需安装数据库
- **TypeScript 严格类型**：前后端共享类型定义
- **流式 SSE 输出**：实时 token 流 + 任务进度推送 + 断网自动重连
- **导出中心**：Markdown / TXT / 网页版 HTML / Word 兼容文档 + 章节范围选择
- **ChapterTree 虚拟滚动 + 拖拽排序**：>100 章启用视口区间渲染；原生 HTML5 拖拽排序（零新依赖）+ 批量操作（精修/改状态/删除）
- **Studio 停止生成 + 重试**：流式输出可中断（AbortController），失败气泡支持重试
- **Modal 焦点陷阱**：Tab 循环 + Escape 关闭 + 焦点还原，无障碍且不引入新依赖
- **状态守卫**：pause 仅 running/queued、retry 仅 failed、resume 仅 paused/failed
- **cancel token**：worker 在章节边界 + 流式 next() 检查信号，pause/cancel 不杀进程
- **async 路由错误捕获**：所有 async handler 包 try/catch，DB 异常不致进程级 unhandledRejection
- **数据库增量迁移**：升级后旧库自动补列（chapter_memos_json / emotion_beats_json / conflict_lines_json / mainline_progress 等），无需手动处理

---

## 快速开始

### 环境要求
- Node.js ≥ 18
- pnpm（推荐）或 npm / yarn

### 安装与启动

```bash
# 安装依赖
pnpm install

# 开发模式（前端 + 后端 + 守护进程同时启动）
pnpm dev

# 生产构建
pnpm build

# 生产启动（独立 worker 进程模式）
pnpm start
```

启动后访问：
- 前端：http://localhost:5173
- 后端 API：http://localhost:3001

### 配置模型

1. 启动后打开 http://localhost:5173 → 「模型中心」
2. 选择内置厂商（OpenAI / Claude / 智谱 / DeepSeek 等），填入 API Key
3. 或选择「Kilo 公益聚合」体验免费模型（每日配额）
4. 本地部署可填 Ollama（默认 `http://localhost:11434/v1`）

数据存储在 `api/data/inkforge.db`（首次启动自动创建）。

---

## 项目结构

```
InkForge/
├── api/                          # 后端
│   ├── server.ts                 # Express 入口（内嵌 worker）
│   ├── worker.ts                 # 独立 worker 进程入口
│   ├── daemon.ts                 # 任务队列消费 + 流水线编排
│   ├── engine.ts                 # 大纲生成 / 状态机 / 质检 / memo 硬对账
│   ├── llm.ts                    # 多厂商 LLM 路由 + 流式
│   ├── exporter.ts               # 导出（Markdown/TXT/HTML/Word 兼容）
│   ├── db.ts                     # SQLite schema + 迁移 + seed
│   ├── repos.ts                  # 数据访问层
│   ├── websearch.ts              # 联网搜索封装
│   ├── routes/                   # REST + SSE 路由
│   │   ├── chat.ts               # 对话 SSE（意图识别 + 续写/精修/生成）
│   │   ├── generate.ts           # 一键生成任务派发
│   │   ├── models.ts             # provider CRUD + 测试 + 拉模型
│   │   ├── chapters.ts           # 章节操作 + 快照 + 拖拽移动
│   │   ├── projects.ts           # 项目 CRUD + 封面生成
│   │   ├── genres.ts             # 题材库
│   │   ├── analyze.ts            # 市场扫榜 + 拆文分析
│   │   ├── tasks.ts              # 任务列表 + SSE 推送
│   │   ├── export.ts             # 导出
│   │   └── usage.ts              # Token 用量
│   └── data/                     # SQLite 数据库 + 导出文件（gitignored）
├── src/                          # 前端
│   ├── pages/                    # 路由页面
│   │   ├── Studio.tsx            # AI 对话主界面（流式输出 + 停止/重试）
│   │   ├── Projects.tsx          # 作品库
│   │   ├── ProjectDetail.tsx     # 章节编辑 + 大纲 + 状态 + 批量操作
│   │   ├── Generate.tsx          # 一键生成向导（文风选择）
│   │   ├── Daemon.tsx            # 任务监控面板
│   │   ├── Models.tsx            # 模型中心
│   │   ├── Market.tsx            # 题材市场扫榜
│   │   ├── TearDown.tsx          # 拆文分析
│   │   ├── Genres.tsx            # 题材库管理
│   │   ├── ExportCenter.tsx      # 导出中心
│   │   └── Settings.tsx          # 系统设置
│   ├── components/               # 通用组件（Modal/Switch/Tabs/react-bits 等）
│   └── api/client.ts             # API 客户端（SSE 重连 + chat 断网重试）
├── shared/                       # 前后端共享
│   ├── types.ts                  # 类型定义（ChapterMemo/EmotionBeat/ConflictLine 等）
│   ├── genres.ts                 # 内置题材库
│   └── tone-presets.ts           # 文风预设表（13 项）
└── package.json
```

---

## 主要页面

| 页面 | 路由 | 功能 |
|------|------|------|
| 工作台 | `/` | AI 对话，意图识别触发续写/精修/生成/扫榜，支持停止生成与重试 |
| 作品库 | `/projects` | 项目列表 + 创建/重命名/删除 |
| 章节编辑 | `/projects/:id` | 章节树（拖拽排序 + 批量操作）+ 大纲 + 状态面板 |
| 一键生成 | `/generate` | 长篇/短篇生成向导（题材/创意/字数/文风） |
| 守护进程 | `/daemon` | 任务队列监控 + 暂停/恢复/重试 |
| 模型中心 | `/models` | Provider 配置 + 模型切换 + 余额查询 |
| 题材市场 | `/market` | 扫榜分析 + 历史回看 |
| 拆文分析 | `/teardown` | 输入标题+简介，AI 拆解套路 |
| 题材库 | `/genres` | 内置 + 自定义题材管理 |
| 导出中心 | `/export` | Markdown/TXT/网页版HTML/Word兼容导出 |
| 设置 | `/settings` | 字号 + 主题 + 数据库体检 |

---

## 任务类型

守护进程消费以下任务（断点续传 + 自动重试 + 章节级容错）：

| type | 触发 | 流程 |
|------|------|------|
| `book` | 一键生成（长篇） | 扫榜 → setup（世界观+角色） → 大纲（>200 章分卷） → 卷纲 → 逐章生成（memo+七维质检） → 精修（前30章+末尾20%） |
| `short` | 一键生成（短篇） | 分段大纲 → 顺序生成（memo+质检） → 精修 |
| `chapter` | 单章生成 | 直接生成指定章节正文（memo+质检） |
| `refine` | 单章精修 | 精修指定章节 + 快照 |
| `refine-book` | 整书精修 | 批量遍历 content > 100 字章节，逐章 refine，断点续传 |

任务状态：`queued → running → done | failed | paused`（失败自动重试 3 次，指数退避；pause 后可 resume 续传；单章失败跳过不中断整本书）。

---

## 智能体状态分层

基于 oh-story-claudecode + inkos 方法论，长篇防跑偏核心机制：

| 机制 | 说明 |
|------|------|
| **伏笔状态机** | planted/paid/expired 四态，high 主线伏笔永不自动过期，expectedRecycleAt 到期硬提醒 |
| **角色热度四态** | 核心/活跃完整注入 + 边缘/失踪仅名 + 主角保底，按 recentAppearCount 分级 |
| **chapter_memo 七段契约** | 每章生成前结构化 memo，生成后 verifyMemoCompliance 硬对账（伏笔关键词 + 钩子信号词） |
| **三层摘要归档** | 近 5 章详记 + 中 10 章概要 + 卷级压缩（compactVolumeSummary LLM 真压缩） |
| **情感线节点追踪** | EmotionBeat 结构化字段，CP 向作品追踪心动/误解/和好/升华节奏 |
| **矛盾网三层状态机** | ConflictLine 章级/卷级/书级，resolved 无 escalatedTo 标警告防单元剧化 |
| **全书主线进度** | mainlineProgress 每 10 章审稿增量更新，防中后段主线遗忘 |
| **卷级伏笔集群** | VolumeOutline.keyForeshadows 按 plantedAt/expectedRecycleAt 预填 |
| **滑动窗口大纲** | 当前卷全章 + ±5 邻章 + 其他卷 premise，防长篇大纲截断 |
| **角色实时状态** | characterState 位置/情绪/关系，单字名称谓边界匹配防误判 |

---

## 数据库 Schema

主要表（详见 `api/db.ts`）：

- `project` — 项目（type: long/short，含题材、字数）
- `chapter` — 章节（parent_id 支持卷嵌套，status 状态机含 failed，positioning 章节定位）
- `task` / `task_log` — 任务队列与日志
- `agent_state` — 智能体状态（记忆/伏笔/角色状态/章节摘要/卷纲/chapter_memos/emotion_beats/conflict_lines/mainline_progress）
- `provider` — 模型配置
- `token_usage` — 用量明细
- `genre` — 题材库
- `market_scan` — 扫榜历史

数据库支持增量迁移：升级后旧库自动补列，无需手动处理。

---

## 环境变量

可通过 `.env` 或环境变量配置（均有默认值）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `INKFORGE_DATA_DIR` | `api/data` | 数据目录 |
| `INKFORGE_DB_PATH` | `{DATA_DIR}/inkforge.db` | SQLite 文件路径 |
| `INKFORGE_EMBED_WORKER` | `true` | 内嵌 worker（false 时需独立进程） |
| `PORT` | `3001` | 后端端口 |

---

## 部署

### 本地开发
```bash
pnpm dev
```

### 生产（单进程，内嵌 worker）
```bash
pnpm build
pnpm start:server
```

### 生产（多进程，server + worker 分离）
```bash
pnpm build
pnpm start   # 同时启动 server 和 worker
```

### Vercel
仓库已含 `vercel.json`，可直接连接仓库部署（注意 SQLite 文件系统在 serverless 不持久，建议用外部 DB）。

---

## 技术栈

- **前端**：React 18 + TypeScript + Vite + Tailwind CSS + Zustand + react-router-dom 7 + react-bits
- **后端**：Node.js + Express + better-sqlite3 + tsx
- **AI**：OpenAI 兼容协议为主，Anthropic / Gemini 走原生协议
- **实时**：SSE 流式输出 + 任务进度推送 + 断网重连

---

## 许可

私有项目，未公开授权。
