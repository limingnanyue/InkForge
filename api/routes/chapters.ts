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
  const task = taskRepo.create({
    projectId: chapter.projectId,
    type: 'refine',
    config: { projectId: chapter.projectId, chapterId: chapter.id },
  });
  ok(res, task);
});

export default router;
