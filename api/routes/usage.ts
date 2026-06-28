/**
 * Token 用量路由
 * GET /api/v1/usage/stats    —— 全局用量统计（设置页展示）
 * GET /api/v1/usage          —— 用量明细列表（可按 projectId 过滤）
 * DELETE /api/v1/usage       —— 清空全部用量记录
 */
import { Router, type Request, type Response } from 'express';
import { usageRepo } from '../repos.js';
import { db } from '../db.js';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

router.get('/stats', (_req: Request, res: Response) => {
  try { ok(res, usageRepo.getStats()); }
  catch (e) { fail(res, 'USAGE_ERROR', (e as Error).message, 500); }
});

router.get('/', (req: Request, res: Response) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
  try { ok(res, usageRepo.list(projectId)); }
  catch (e) { fail(res, 'USAGE_ERROR', (e as Error).message, 500); }
});

router.delete('/', (_req: Request, res: Response) => {
  try {
    db.exec('DELETE FROM token_usage');
    ok(res, { cleared: true });
  } catch (e) { fail(res, 'USAGE_ERROR', (e as Error).message, 500); }
});

export default router;
