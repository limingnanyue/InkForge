/**
 * 项目 + 章节 + 智能体状态 路由
 */
import { Router, type Request, type Response } from 'express';
import { projectRepo, chapterRepo, stateRepo, messageRepo } from '../repos.js';
import type { ProjectType } from '@shared/types';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

// ===== 项目 =====
router.get('/', (_req: Request, res: Response) => ok(res, projectRepo.list()));

router.post('/', (req: Request, res: Response) => {
  const { title, type, targetWords, summary, webSearchEnabled, genre, genreId } = req.body || {};
  if (!title || !type) return fail(res, 'INVALID', '标题和类型必填');
  if (!['long', 'short', 'script'].includes(type)) return fail(res, 'INVALID', '类型不合法');
  const project = projectRepo.create({ title, type: type as ProjectType, targetWords: targetWords || 0, summary, webSearchEnabled, genre, genreId });
  ok(res, project);
});

router.get('/:id', (req: Request, res: Response) => {
  const project = projectRepo.get(req.params.id);
  if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  ok(res, project);
});

router.patch('/:id', (req: Request, res: Response) => {
  // R2 修复：白名单过滤，防篡改 id/created_at/current_words 等字段
  // current_words 应由 updateWordCount 内部计算，不接受外部 PATCH 覆盖
  const body = req.body || {};
  const patch: Record<string, unknown> = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.summary === 'string') patch.summary = body.summary;
  if (typeof body.coverSeed === 'string') patch.coverSeed = body.coverSeed;
  if (typeof body.webSearchEnabled === 'boolean') patch.webSearchEnabled = body.webSearchEnabled;
  if (typeof body.genre === 'string') patch.genre = body.genre;
  if (typeof body.genreId === 'string' || body.genreId === null) patch.genreId = body.genreId;
  const project = projectRepo.update(req.params.id, patch);
  if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  ok(res, project);
});

router.delete('/:id', (req: Request, res: Response) => {
  projectRepo.delete(req.params.id);
  ok(res, { id: req.params.id });
});

// ===== 章节 =====
router.get('/:id/chapters', (req: Request, res: Response) => {
  ok(res, chapterRepo.tree(req.params.id));
});

router.post('/:id/chapters', (req: Request, res: Response) => {
  const { title, parentId, outline, content, orderIdx } = req.body || {};
  if (!title) return fail(res, 'INVALID', '章节标题必填');
  const chapter = chapterRepo.create({ projectId: req.params.id, parentId, title, outline, content, orderIdx });
  ok(res, chapter);
});

// ===== 智能体状态 =====
router.get('/:id/state', (req: Request, res: Response) => {
  const state = stateRepo.get(req.params.id);
  ok(res, state || stateRepo.update(req.params.id, {}));
});

router.patch('/:id/state', (req: Request, res: Response) => {
  const state = stateRepo.update(req.params.id, req.body || {});
  ok(res, state);
});

// ===== 对话消息 =====
router.get('/:id/messages', (req: Request, res: Response) => {
  ok(res, messageRepo.listByProject(req.params.id));
});

export default router;
