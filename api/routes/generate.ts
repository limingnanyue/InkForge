/**
 * 一键生成路由 —— 触发成书/成短篇流水线
 */
import { Router, type Request, type Response } from 'express';
import { projectRepo, taskRepo, stateRepo, chapterRepo } from '../repos.js';
import type { GenerateKind, ProjectType, Task, Project } from '@shared/types';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

const MAX_BOOK = 5_000_000;   // 升级：长篇上限 500 万字（2000 章 / 100 卷）
const MAX_SHORT = 200_000;

/**
 * 基于已有项目创建续写任务（守护进程持续写作）
 * - 复用项目现有大纲章节（若有），从第一个未完成章节续写
 * - 若项目无章节，daemon 会自动生成大纲后开始
 * 可被 generate 路由与 chat 路由（守护进程意图）共同调用
 * model/providerId：可选，前端从全局 store currentModel/currentProviderId 透传
 */
export function createContinueTask(projectId: string, webSearch?: boolean, model?: string, providerId?: string, chapterWordBudget?: number, chapterWordMin?: number, chapterWordMax?: number): { task: Task; project: Project } | null {
  const project = projectRepo.get(projectId);
  if (!project) return null;

  // H2 修复(第二十轮): 同项目已有 queued/running book/short 任务时拒绝二次派发
  // 防 Studio 工作台 daemon_create 意图重复触发 + 用户 Generate 页手动重复派发 → 多 task 串行覆盖章节
  // 返回特殊标记 { duplicate: true } 让调用方(chat 路由)区分"项目不存在"和"已存在任务"
  // P1 修复(BUG2)说明: 这里把非 short(含 script)统一当 book 处理。
  //   script 剧本类型无专用 pipeline,本应输出剧本却输出小说(半实现陷阱)。
  //   现已在前端移除"剧本"选项 + projects.ts 创建路由禁止 type='script',
  //   故正常流程不会出现 script 项目;此处保持现状兜底,避免历史 script 项目续写时 500。
  const kind: GenerateKind = project.type === 'short' ? 'short' : 'book';
  const dup = taskRepo.list(projectId).some(t =>
    (t.type === 'book' || t.type === 'short') && (t.status === 'queued' || t.status === 'running'));
  if (dup) return null;
  const state = stateRepo.get(projectId);
  const idea = state?.idea || project.title;
  const finalWebSearch = typeof webSearch === 'boolean' ? webSearch : project.webSearchEnabled;

  // 读取已有章节，若有则构建 outlineJson 复用（避免重新生成大纲导致章节不一致）
  // oh-story：从 state.chapterSummaries 按 idx 补回 positioning/coreEmotion（防续写丢定位，破坏章节定位六类分布）
  const chapters = chapterRepo.listByProject(projectId);
  const summaryMap = new Map((state?.chapterSummaries || []).map(s => [s.idx, s]));
  const outlineJson = chapters.length > 0
    ? JSON.stringify(chapters.map(c => {
        const sm = summaryMap.get(c.orderIdx);
        return {
          title: c.title,
          outline: c.outline || '',
          hook: '', // Chapter 表不存 hook，续写新章用空 hook（daemon 会在 prompt 里用 ch.hook 兜底）
          ...(sm?.positioning ? { positioning: sm.positioning } : {}),
          ...(sm?.coreEmotion ? { coreEmotion: sm.coreEmotion } : {}),
        };
      }))
    : undefined;

  const task = taskRepo.create({
    projectId: project.id,
    type: kind,
    config: {
      projectId: project.id,
      targetWords: project.targetWords,
      config: { genre: project.genre || '都市玄幻', genreId: project.genreId, characters: '', hookStyle: '强冲突', pace: '紧凑', ending: '开放' },
      idea,
      title: project.title,
      webSearch: finalWebSearch,
      // 任务级模型选择（不传则回落到 default provider 旗舰模型）
      ...(model ? { model } : {}),
      ...(providerId ? { providerId } : {}),
      // 每章字数预算透传到 task.config，daemon 从 cfg 读
      ...(chapterWordBudget ? { chapterWordBudget } : {}),
      // H3 修复(第十九轮): 每章字数上下限透传,daemon 用其替代硬编码 budget*0.8/1.2
      ...(chapterWordMin != null ? { chapterWordMin } : {}),
      ...(chapterWordMax != null ? { chapterWordMax } : {}),
    },
  });

  // 预设 checkpoint：phase=chapter 直接跳过 scan/setup/outline（避免续写时重跑扫榜污染已有 idea）
  // daemon 会跳过 generateOutline，直接从现有大纲续写
  if (outlineJson) {
    taskRepo.update(task.id, { checkpoint: { phase: 'chapter', outlineJson } });
  }

  return { task: taskRepo.get(task.id)!, project };
}

router.post('/', (req: Request, res: Response) => {
  const { projectId, title, kind, targetWords, config, idea, webSearch, model, providerId, chapterWordBudget, chapterWordMin, chapterWordMax } = req.body || {};
  if (!kind || !['book', 'short'].includes(kind)) return fail(res, 'INVALID', 'kind 必须为 book 或 short');

  const limit = kind === 'book' ? MAX_BOOK : MAX_SHORT;
  if (!targetWords || targetWords <= 0) return fail(res, 'INVALID', '目标字数必填');
  if (targetWords > limit) return fail(res, 'INVALID', `${kind === 'book' ? '成书' : '成短篇'}上限为 ${limit.toLocaleString()} 字`);
  // 每章字数预算范围校验（book 1500-10000，short 2000-12000）
  const budgetMin = kind === 'book' ? 1500 : 2000;
  const budgetMax = kind === 'book' ? 10000 : 12000;
  if (chapterWordBudget != null && (typeof chapterWordBudget !== 'number' || chapterWordBudget < budgetMin || chapterWordBudget > budgetMax)) {
    return fail(res, 'INVALID', `每章字数预算须在 ${budgetMin}-${budgetMax} 之间`);
  }
  // H3 修复(第十九轮): 每章字数上下限校验
  // 约束: min <= budget <= max; min >= budgetMin*0.5; max <= budgetMax*1.5
  // (允许比 budget 范围更宽,因为上下限是浮动区间不是固定档位)
  const minErr = validateWordRange(chapterWordMin, chapterWordMax, chapterWordBudget ?? (kind === 'book' ? 2500 : 5000), budgetMin, budgetMax);
  if (minErr) return fail(res, 'INVALID', minErr);

  // 获取或创建项目
  let project = projectId ? projectRepo.get(projectId) : null;
  const genre = config?.genre || '';
  const genreId = config?.genreId;
  if (!project) {
    const type: ProjectType = kind === 'book' ? 'long' : 'short';
    project = projectRepo.create({ title: title || `${kind === 'book' ? '长篇' : '短篇'}作品`, type, targetWords, genre, genreId });
  } else {
    projectRepo.update(project.id, { targetWords, ...(genre ? { genre } : {}), ...(genreId ? { genreId } : {}) });
  }

  // H2 修复(第二十轮): 同项目已有 queued/running book/short 任务时拒绝二次派发
  // 防 Generate 页 fetch 抖动用户重试时绕过前端 busy 守卫 → 多 task 串行覆盖章节
  const dup = taskRepo.list(project.id).some(t =>
    (t.type === 'book' || t.type === 'short') && (t.status === 'queued' || t.status === 'running'));
  if (dup) return fail(res, 'CONFLICT', '已有生成任务在进行中，请前往守护进程查看', 409);

  // 写入创意到状态
  if (idea) stateRepo.update(project.id, { idea });

  // 创建守护任务（webSearch：请求显式传入优先，否则用项目级开关）
  const finalWebSearch = typeof webSearch === 'boolean' ? webSearch : project.webSearchEnabled;
  const task = taskRepo.create({
    projectId: project.id,
    type: kind,
    config: {
      projectId: project.id,
      targetWords,
      config: config || { genre: '都市玄幻', characters: '', hookStyle: '强冲突', pace: '紧凑', ending: '开放' },
      idea: idea || config?.genre || project.title,
      title: project.title,
      webSearch: finalWebSearch,
      // 任务级模型选择（不传则回落到 default provider 旗舰模型）
      ...(model ? { model } : {}),
      ...(providerId ? { providerId } : {}),
      // 每章字数预算透传到 task.config，daemon 从 cfg 读
      ...(chapterWordBudget ? { chapterWordBudget } : {}),
      // H3 修复(第十九轮): 每章字数上下限透传,daemon 用其替代硬编码 budget*0.8/1.2
      ...(chapterWordMin != null ? { chapterWordMin } : {}),
      ...(chapterWordMax != null ? { chapterWordMax } : {}),
    },
  });

  ok(res, { task, project });
});

// H3 修复(第十九轮): 每章字数上下限校验
// 规则: min/max 可选,但若传则必须满足 min <= budget <= max 且各自在 [budgetMin*0.5, budgetMax*1.5] 内
// 返回错误消息字符串(校验失败)或 null(校验通过)
function validateWordRange(min: unknown, max: unknown, budget: number, budgetMin: number, budgetMax: number): string | null {
  // 第二十六轮 P2 修复(容差不闭合): 原允许 min 低到 budgetMin*0.5、max 高到 budgetMax*1.5,
  //   与 engine.ts 字数门容差(chapterWordMin*0.7 / chapterWordMax*1.15)不协调——
  //   极端配置(如 min=750 book)会让 engine 的 minHard=525,LLM 输出 530 字也能通过质量门,
  //   但相对 budget=2500 差 80%,章节质量极差却放行。
  //   现: 收紧到 min >= budget*0.7 / max <= budget*1.5(与 engine 容差形成闭合区间),
  //   用户配置的上下限不能脱离 budget 太远。
  const loBound = Math.round(budgetMin * 0.5);
  const hiBound = Math.round(budgetMax * 1.5);
  if (min != null) {
    if (typeof min !== 'number' || min < loBound) return `每章字数下限不能小于 ${loBound}`;
    if (min > budget) return `每章字数下限(${min})不能大于预算(${budget})`;
    // 容差下限:不能低于 budget 的 70%(与 engine.ts minHard = chapterWordMin*0.7 协调)
    if (min < Math.round(budget * 0.7)) return `每章字数下限(${min})不能小于预算(${budget})的 70%`;
  }
  if (max != null) {
    if (typeof max !== 'number' || max > hiBound) return `每章字数上限不能大于 ${hiBound}`;
    if (max < budget) return `每章字数上限(${max})不能小于预算(${budget})`;
    // 容差上限:不能高于 budget 的 1.5 倍(与 engine.ts hardMax = chapterWordMax*1.15 协调)
    if (max > Math.round(budget * 1.5)) return `每章字数上限(${max})不能大于预算(${budget})的 1.5 倍`;
  }
  if (min != null && max != null && min > max) return `每章字数下限(${min})不能大于上限(${max})`;
  return null;
}

// 继续写作：基于已有项目派发续写任务到守护进程
router.post('/continue', (req: Request, res: Response) => {
  const { projectId, webSearch, model, providerId, chapterWordBudget, chapterWordMin, chapterWordMax } = req.body || {};
  if (!projectId) return fail(res, 'INVALID', '项目 ID 必填');
  // M4 修复：/continue 路由也校验 chapterWordBudget 范围（与 POST / 一致）
  // H1 修复(第十一轮): book 边界 8000→10000, short 边界 10000→12000,与 Generate 页 + POST /generate 同步
  // 项目 type=short → 范围 2000-12000；其余（long/script）→ 1500-10000（book）
  const project0 = projectRepo.get(projectId);
  if (!project0) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  const isShort = project0.type === 'short';
  const budgetMin = isShort ? 2000 : 1500;
  const budgetMax = isShort ? 12000 : 10000;
  if (chapterWordBudget != null && (typeof chapterWordBudget !== 'number' || chapterWordBudget < budgetMin || chapterWordBudget > budgetMax)) {
    return fail(res, 'INVALID', `每章字数预算须在 ${budgetMin}-${budgetMax} 之间`);
  }
  // H3 修复(第十九轮): /continue 路由也校验 chapterWordMin/Max 范围
  const minErr = validateWordRange(chapterWordMin, chapterWordMax, chapterWordBudget ?? (isShort ? 5000 : 2500), budgetMin, budgetMax);
  if (minErr) return fail(res, 'INVALID', minErr);
  // H2 修复(第二十轮): /continue 路由先做项目级 dup 检测,与 createContinueTask 内部一致
  // 区分 404(项目不存在) 与 409(已有任务进行中),让前端能给出不同提示
  const dup = taskRepo.list(projectId).some(t =>
    (t.type === 'book' || t.type === 'short') && (t.status === 'queued' || t.status === 'running'));
  if (dup) return fail(res, 'CONFLICT', '已有生成任务在进行中，请前往守护进程查看', 409);
  const result = createContinueTask(projectId, webSearch, model, providerId, chapterWordBudget, chapterWordMin, chapterWordMax);
  if (!result) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  ok(res, result);
});

export default router;
