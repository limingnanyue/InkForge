/**
 * 导出路由 —— 导出 + 下载 + 历史
 */
import { Router, type Request, type Response } from 'express';
import path from 'path';
import { exportProject } from '../exporter.js';
import { exportRepo } from '../repos.js';
import { EXPORT_DIR } from '../db.js';
import type { ExportFormat } from '@shared/types';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

router.post('/', (req: Request, res: Response) => {
  const { projectId, format, chapterRange } = req.body || {};
  if (!projectId || !format) return fail(res, 'INVALID', 'projectId 和 format 必填');
  if (!['txt', 'markdown', 'epub', 'docx'].includes(format)) return fail(res, 'INVALID', '格式不合法');
  try {
    const result = exportProject({ projectId, format: format as ExportFormat, chapterRange });
    ok(res, result);
  } catch (e) {
    fail(res, 'EXPORT_FAILED', (e as Error).message, 500);
  }
});

router.get('/', (req: Request, res: Response) => {
  // query.projectId 运行期可能是 string | string[] | undefined（?projectId=a&projectId=b 场景）
  const raw = req.query.projectId;
  const projectId = typeof raw === 'string' ? raw : undefined;
  ok(res, exportRepo.list(projectId));
});

router.get('/download/:fileName', (req: Request, res: Response) => {
  // 安全过滤：basename 防 `..` 路径穿越（攻击者请求 /download/..%2F..%2Fetc%2Fpasswd 可读任意文件）
  // path.join 不会阻止 `..` 跨目录，必须显式 basename
  const safe = path.basename(req.params.fileName);
  if (!safe || safe !== req.params.fileName) {
    return fail(res, 'INVALID', '非法文件名');
  }
  // 兜底：拒绝含 null byte / 绝对路径
  if (safe.includes('\0') || path.isAbsolute(safe)) {
    return fail(res, 'INVALID', '非法文件名');
  }
  res.download(path.join(EXPORT_DIR, safe));
});

export default router;
