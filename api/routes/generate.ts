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
export function createContinueTask(projectId: string, webSearch?: boolean, model?: string, providerId?: string, chapterWordBudget?: number): { task: Task; project: Project } | null {
  const project = projectRepo.get(projectId);
  if (!project) return null;

  const kind: GenerateKind = project.type === 'short' ? 'short' : 'book';
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
  const { projectId, title, kind, targetWords, config, idea, webSearch, model, providerId, chapterWordBudget } = req.body || {};
  if (!kind || !['book', 'short'].includes(kind)) return fail(res, 'INVALID', 'kind 必须为 book 或 short');

  const limit = kind === 'book' ? MAX_BOOK : MAX_SHORT;
  if (!targetWords || targetWords <= 0) return fail(res, 'INVALID', '目标字数必填');
  if (targetWords > limit) return fail(res, 'INVALID', `${kind === 'book' ? '成书' : '成短篇'}上限为 ${limit.toLocaleString()} 字`);
  // 每章字数预算范围校验（book 1500-8000，short 2000-10000）
  const budgetMin = kind === 'book' ? 1500 : 2000;
  const budgetMax = kind === 'book' ? 8000 : 10000;
  if (chapterWordBudget != null && (typeof chapterWordBudget !== 'number' || chapterWordBudget < budgetMin || chapterWordBudget > budgetMax)) {
    return fail(res, 'INVALID', `每章字数预算须在 ${budgetMin}-${budgetMax} 之间`);
  }

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
    },
  });

  ok(res, { task, project });
});

// 继续写作：基于已有项目派发续写任务到守护进程
router.post('/continue', (req: Request, res: Response) => {
  const { projectId, webSearch, model, providerId, chapterWordBudget } = req.body || {};
  if (!projectId) return fail(res, 'INVALID', '项目 ID 必填');
  // M4 修复：/continue 路由也校验 chapterWordBudget 范围（与 POST / 一致）
  // 项目 type=short → 范围 2000-10000；其余（long/script）→ 1500-8000（book）
  if (chapterWordBudget != null) {
    const project = projectRepo.get(projectId);
    if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
    const isShort = project.type === 'short';
    const budgetMin = isShort ? 2000 : 1500;
    const budgetMax = isShort ? 10000 : 8000;
    if (typeof chapterWordBudget !== 'number' || chapterWordBudget < budgetMin || chapterWordBudget > budgetMax) {
      return fail(res, 'INVALID', `每章字数预算须在 ${budgetMin}-${budgetMax} 之间`);
    }
  }
  const result = createContinueTask(projectId, webSearch, model, providerId, chapterWordBudget);
  if (!result) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  ok(res, result);
});

export default router;
