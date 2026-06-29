/**
 * 章节操作路由（单章更新/快照/删除/生成/精修）
 */
import { Router, type Request, type Response } from 'express';
import { chapterRepo, taskRepo, providerRepo } from '../repos.js';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

router.patch('/:id', (req: Request, res: Response) => {
  // R2 修复：白名单过滤，防篡改 id/project_id/created_at 等字段
  // 原 bug：req.body 全量透传，调用方可改 status:'done' 绕过生成流程、改 project_id 移到别项目
  const body = req.body || {};
  const patch: Record<string, unknown> = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.outline === 'string') patch.outline = body.outline;
  if (typeof body.content === 'string') patch.content = body.content;
  if (typeof body.orderIdx === 'number') patch.orderIdx = body.orderIdx;
  if (typeof body.status === 'string' && ['draft', 'generating', 'done', 'failed'].includes(body.status)) patch.status = body.status;
  const chapter = chapterRepo.update(req.params.id, patch);
  if (!chapter) return fail(res, 'NOT_FOUND', '章节不存在', 404);
  ok(res, chapter);
});

router.delete('/:id', (req: Request, res: Response) => {
  chapterRepo.delete(req.params.id);
  ok(res, { id: req.params.id });
});

router.post('/:id/snapshot', (req: Request, res: Response) => {
  chapterRepo.snapshot(req.params.id);
  ok(res, { ok: true });
});

// 单章生成（入队守护任务）
router.post('/:id/generate', (req: Request, res: Response) => {
  const chapter = chapterRepo.get(req.params.id);
  if (!chapter) return fail(res, 'NOT_FOUND', '章节不存在', 404);
  // H1 修复(第二十轮): 同章节已有 queued/running chapter 任务时拒绝二次派发
  // 防 UI 双击或 SSE 重连重置 busy 后再次点击 → 两 task 串行执行时第二个覆盖第一个的 content
  const dup = taskRepo.list(chapter.projectId).some(t =>
    t.type === 'chapter' && (t.config as any).chapterId === chapter.id && (t.status === 'queued' || t.status === 'running'));
  if (dup) return fail(res, 'CONFLICT', '该章节已有生成任务在进行中', 409);
  const task = taskRepo.create({
    projectId: chapter.projectId,
    type: 'chapter',
    config: { projectId: chapter.projectId, chapterId: chapter.id, prompt: req.body?.prompt },
  });
  ok(res, task);
});

// 单章精修（入队守护任务）
router.post('/:id/refine', (req: Request, res: Response) => {
  const chapter = chapterRepo.get(req.params.id);
  if (!chapter) return fail(res, 'NOT_FOUND', '章节不存在', 404);
  // H1 修复(第二十轮): 同章节已有 queued/running refine 任务时拒绝二次派发
  const dup = taskRepo.list(chapter.projectId).some(t =>
    t.type === 'refine' && (t.config as any).chapterId === chapter.id && (t.status === 'queued' || t.status === 'running'));
  if (dup) return fail(res, 'CONFLICT', '该章节已有精修任务在进行中', 409);
  const task = taskRepo.create({
    projectId: chapter.projectId,
    type: 'refine',
    config: { projectId: chapter.projectId, chapterId: chapter.id },
  });
  ok(res, task);
});

export default router;
