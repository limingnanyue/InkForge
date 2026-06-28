/**
 * 题材库路由 —— 内置 + 用户自定义题材的 CRUD
 * 取代前端硬编码常量，支持用户添加/编辑/删除自定义题材
 */
import { Router, type Request, type Response } from 'express';
import { genreRepo } from '../repos.js';
import { db } from '../db.js';
import type { GenreCategory } from '../../shared/genres.js';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

// 校验 id slug：只允许小写字母/数字/短横线，长度 2-50
const ID_RE = /^[a-z0-9][a-z0-9-]{1,49}$/;
const VALID_CATEGORIES: GenreCategory[] = ['male', 'female', 'common'];

// GET /api/v1/genres —— 列出全部题材（按 category 分组返回前端可直接 optgroup）
router.get('/', (_req: Request, res: Response) => {
  ok(res, genreRepo.list());
});

// GET /api/v1/genres/:id
router.get('/:id', (req: Request, res: Response) => {
  const g = genreRepo.get(req.params.id);
  if (!g) return fail(res, 'NOT_FOUND', '题材不存在', 404);
  ok(res, g);
});

// POST /api/v1/genres —— 创建自定义题材
router.post('/', (req: Request, res: Response) => {
  const { id, label, category, description, emotionMap } = req.body || {};
  if (!id || !ID_RE.test(id)) return fail(res, 'INVALID', 'id 必填且仅允许小写字母/数字/短横线，2-50 字符');
  if (!label || typeof label !== 'string' || label.trim().length < 2) return fail(res, 'INVALID', 'label 必填且至少 2 字符');
  if (!category || !VALID_CATEGORIES.includes(category)) return fail(res, 'INVALID', 'category 必须为 male/female/common');
  if (genreRepo.get(id)) return fail(res, 'DUPLICATE', 'id 已存在', 409);
  try {
    const g = genreRepo.create({ id: id.toLowerCase(), label: label.trim(), category, description, emotionMap });
    ok(res, g);
  } catch (e) {
    fail(res, 'CREATE_FAILED', (e as Error).message, 500);
  }
});

// PATCH /api/v1/genres/:id —— 更新题材（内置题材可改 label/description/emotionMap，但 category 也可改）
router.patch('/:id', (req: Request, res: Response) => {
  const cur = genreRepo.get(req.params.id);
  if (!cur) return fail(res, 'NOT_FOUND', '题材不存在', 404);
  const { label, category, description, emotionMap } = req.body || {};
  if (category && !VALID_CATEGORIES.includes(category)) return fail(res, 'INVALID', 'category 必须为 male/female/common');
  if (label !== undefined && (typeof label !== 'string' || label.trim().length < 2)) return fail(res, 'INVALID', 'label 至少 2 字符');
  try {
    const g = genreRepo.update(req.params.id, { label, category, description, emotionMap });
    ok(res, g);
  } catch (e) {
    fail(res, 'UPDATE_FAILED', (e as Error).message, 500);
  }
});

// DELETE /api/v1/genres/:id —— 删除题材（内置题材不可删）
// 同步清理引用：project.genre_id 置空 + genre 留 label 兜底显示；market_scan.genre_id 置空（保留历史）
router.delete('/:id', (req: Request, res: Response) => {
  const cur = genreRepo.get(req.params.id);
  if (!cur) return fail(res, 'NOT_FOUND', '题材不存在', 404);
  if (cur.isBuiltin) return fail(res, 'FORBIDDEN', '内置题材不可删除（可编辑）', 403);
  try {
    const id = req.params.id;
    db.transaction(() => {
      // project: 置 genre_id=NULL，但保留 genre label 字段以兜底显示（避免项目题材显示空白）
      db.prepare("UPDATE project SET genre_id=NULL WHERE genre_id=?").run(id);
      // market_scan: 仅置 genre_id=NULL，历史报告内容（content 字段）不受影响
      db.prepare("UPDATE market_scan SET genre_id=NULL WHERE genre_id=?").run(id);
      genreRepo.delete(id);
    })();
    ok(res, { deleted: true });
  } catch (e) {
    fail(res, 'DELETE_FAILED', (e as Error).message, 500);
  }
});

export default router;
