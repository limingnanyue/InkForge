# InkForge 墨铸 · AI 写作工作台

> 基于 AI 的中文长篇小说 / 短篇 / 剧本创作平台，本地零配置开箱即用。

InkForge 把"百万字长篇"这种高难度创作拆解成可断点续传的流水线：扫榜取材 → 大纲架构 → 分章生成 → 章末精修 → 一致性归档。配套守护进程任务队列、多模型路由、联网搜索取材、题材市场风向标、Token 用量统计等完整工具链。

---

## 核心特性

### 创作能力
- **百万字长篇流水线**：扫榜 → 卷纲 → 分章大纲 → 逐章生成 → 末尾精修，支持断点续传
- **最高 500 万字超长篇**：按 2500 字/章切分章数，>200 章自动启用分卷大纲生成（20 章/卷），逐卷调 LLM 合并
- **世界观 + 角色档案 setup 阶段**：扫榜后自动生成世界观设定与角色档案落库，解决一键生成后大纲/状态 Tab 空白
- **章节质量门**：每章生成后跑双门检测——字数门（<60% 预算重写）+ 跑题门（LLM 打分 <0.6 重写），不达标自动重写 1 次
- **整书去 AI 味精修**：批量遍历所有 content > 100 字章节，逐章跑 refine skill；断点续传用 `lastChapterId` 定位（比下标稳定），并发去重防重复派发
- **短篇一键生成**：分段大纲 + 顺序生成 + 精修，二十万字以内开箱即得
- **单章生成 / 续写 / 精修**：对话式触发，含快照回滚
- **剧本创作**：独立 type 区分剧本与小说
- **oh-story 三层归档**：近 5 章详记 + 中 10 章概要 + 卷级总览，防长篇人设跑偏
- **伏笔状态机**：未埋 / 已埋 / 已回收 / 已过期 四态追踪，自动提示回收时机
- **AI 生成封面提示词**：10 种风格预设（写实/动漫/油画/水彩/赛博朋克/奇幻/唯美/复古/黑白/水墨）+ 书名覆盖 + 作者署名，风格与作者跨项目记忆

### 模型与基础设施
- **多模型路由**：OpenAI / Claude / Gemini + 国内 8 家（智谱 / DeepSeek / 豆包 / 通义 / Kimi / 混元 / 文心）+ Kilo 公益聚合 + 本地 Ollama
- **守护进程任务队列**：心跳回收 + 自动重试 + 指数退避 + 断点续传
- **联网搜索取材**：可按项目 / 按任务开关，扫榜 / 取材阶段注入实时热点
- **题材市场风向标**：扫榜分析 + 历史回看 + 趋势对比
- **Token 用量统计**：分项目 / 分模型 / 分时段明细
- **多模型余额查询**：DeepSeek / Kimi / GLM 等独立计费 API

### 工程质量
- **零配置本地启动**：better-sqlite3 文件库，无需安装数据库
- **TypeScript 严格类型**：前后端共享类型定义
- **流式 SSE 输出**：实时 token 流 + 任务进度推送
- **导出中心**：Markdown / TXT / 章节范围选择
- **ChapterTree 虚拟滚动**：>100 章启用视口区间渲染，DOM 恒定 ~30 个，长篇不卡
- **Modal 焦点陷阱**：Tab 循环 + Escape 关闭 + 焦点还原，无障碍且不引入新依赖
- **状态守卫**：pause 仅 running/queued、retry 仅 failed、resume 仅 paused/failed，状态语义不被破坏
- **cancel token**：worker 在章节边界 + 流式 next() 检查信号，pause/cancel 不杀进程
- **守护进程健壮性**：claimNext/DB 异常自愈重启、心跳防误回收、catch 二次 try/catch 防 DB 异常杀 loop

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
│   ├── engine.ts                 # 大纲生成 / 状态机 / parseOutline 兜底
│   ├── llm.ts                    # 多厂商 LLM 路由 + 流式
│   ├── db.ts                     # SQLite schema + 迁移 + seed
│   ├── repos.ts                  # 数据访问层
│   ├── websearch.ts              # 联网搜索封装
│   ├── routes/                   # REST + SSE 路由
│   │   ├── chat.ts               # 对话 SSE（意图识别 + 续写/精修/生成）
│   │   ├── generate.ts           # 一键生成任务派发
│   │   ├── models.ts             # provider CRUD + 测试 + 拉模型
│   │   ├── chapters.ts           # 章节操作 + 快照
│   │   ├── projects.ts           # 项目 CRUD
│   │   ├── genres.ts             # 题材库
│   │   ├── analyze.ts             # 市场扫榜 + 拆文分析
│   │   ├── tasks.ts              # 任务列表 + SSE 推送
│   │   ├── export.ts             # 导出
│   │   └── usage.ts              # Token 用量
│   └── data/                     # SQLite 数据库 + 导出文件（gitignored）
├── src/                          # 前端
│   ├── pages/                    # 路由页面
│   │   ├── Studio.tsx            # AI 对话主界面（流式输出 + 智能体状态）
│   │   ├── Projects.tsx          # 作品库
│   │   ├── ProjectDetail.tsx     # 章节编辑 + 大纲 + 状态
│   │   ├── Generate.tsx          # 一键生成向导
│   │   ├── Daemon.tsx            # 任务监控面板
│   │   ├── Models.tsx           # 模型中心
│   │   ├── Market.tsx            # 题材市场扫榜
│   │   ├── TearDown.tsx          # 拆文分析
│   │   ├── Genres.tsx            # 题材库管理
│   │   ├── ExportCenter.tsx      # 导出中心
│   │   └── Settings.tsx          # 系统设置
│   ├── components/               # 通用组件
│   ├── stores/                   # Zustand 状态管理
│   └── api/client.ts             # API 客户端
├── shared/                       # 前后端共享类型
│   ├── types.ts
│   └── genres.ts                 # 内置题材库
└── package.json
```

---

## 主要页面

| 页面 | 路由 | 功能 |
|------|------|------|
| 工作台 | `/` | AI 对话，意图识别触发续写/精修/生成/扫榜 |
| 作品库 | `/projects` | 项目列表 + 创建/重命名/删除 |
| 章节编辑 | `/projects/:id` | 章节树 + 大纲 + 状态面板 + 单章操作 |
| 一键生成 | `/generate` | 长篇/短篇生成向导（题材/创意/字数） |
| 守护进程 | `/daemon` | 任务队列监控 + 暂停/恢复/重试 |
| 模型中心 | `/models` | Provider 配置 + 模型切换 + 余额查询 |
| 题材市场 | `/market` | 扫榜分析 + 历史回看 |
| 拆文分析 | `/teardown` | 输入标题+简介，AI 拆解套路 |
| 题材库 | `/genres` | 内置 + 自定义题材管理 |
| 导出中心 | `/export` | Markdown/TXT 导出 |
| 设置 | `/settings` | 字号 + 主题 + 数据库体检 |

---

## 任务类型

守护进程消费以下任务（断点续传 + 自动重试）：

| type | 触发 | 流程 |
|------|------|------|
| `book` | 一键生成（长篇） | 扫榜 → setup（世界观+角色） → 大纲（>200 章分卷） → 卷纲 → 逐章生成（质量门） → 末尾精修 |
| `short` | 一键生成（短篇） | 分段大纲 → 顺序生成（质量门） → 精修 |
| `chapter` | 单章生成 | 直接生成指定章节正文（质量门） |
| `refine` | 单章精修 | 精修指定章节 + 快照 |
| `refine-book` | 整书精修 | 批量遍历 content > 100 字章节，逐章 refine，断点续传 |

任务状态：`queued → running → done | failed | paused`（失败自动重试 3 次，指数退避；pause 后可 resume 续传）。

---

## 数据库 Schema

主要表（详见 `api/db.ts`）：

- `project` — 项目（type: long/short/script，含题材、字数）
- `chapter` — 章节（parent_id 支持卷嵌套，status 状态机含 failed）
- `task` / `task_log` — 任务队列与日志
- `agent_state` — 智能体状态（记忆/伏笔/角色状态/章节摘要/卷纲）
- `provider` — 模型配置
- `token_usage` — 用量明细
- `genre` — 题材库
- `market_scan` — 扫榜历史

数据库支持增量迁移：升级后旧库自动补列 / 重建表，无需手动处理。

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

- **前端**：React 18 + TypeScript + Vite + Tailwind CSS + Zustand + react-router-dom 7
- **后端**：Node.js + Express + better-sqlite3 + tsx
- **AI**：OpenAI 兼容协议为主，Anthropic / Gemini 走原生协议
- **实时**：SSE 流式输出 + 任务进度推送

---

## 许可

私有项目，未公开授权。
