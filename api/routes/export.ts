/**
 * 导出路由 —— 导出 + 下载 + 历史
 */
import { Router, type Request, type Response } from 'express';
import path from 'path';
import fs from 'fs';
import { exportProject } from '../exporter.js';
import { exportRepo } from '../repos.js';
import { EXPORT_DIR } from '../db.js';
import type { ExportFormat } from '@shared/types';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

// H4 修复(第十九轮): 安全删除导出文件,文件不存在视为已删成功(不阻断)
function safeDeleteFile(filePath: string): void {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(EXPORT_DIR, path.basename(filePath));
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (e) {
    console.warn(`[export] 删除文件失败 ${filePath}:`, (e as Error).message);
  }
}

router.post('/', (req: Request, res: Response) => {
  const { projectId, format, chapterRange } = req.body || {};
  if (!projectId || !format) return fail(res, 'INVALID', 'projectId 和 format 必填');
  if (!['txt', 'markdown', 'epub', 'docx'].includes(format)) return fail(res, 'INVALID', '格式不合法');
  try {
    const result = exportProject({ projectId, format: format as ExportFormat, chapterRange });
    ok(res, result);
  } catch (e) {
    // M8 修复：filterChapters 抛出的"格式错误/超出"类校验异常应返回 400（客户端错误）
    // 而非统一 500（让用户以为是服务端 bug）
    // B8 修复: "项目不存在"是资源不存在(404),不是参数非法(400),与 projects/generate 路由约定一致
    const msg = (e as Error).message || '';
    if (msg.includes('项目不存在')) return fail(res, 'NOT_FOUND', msg, 404);
    const isValidationError = msg.includes('格式错误') || msg.includes('超出总章数');
    fail(res, isValidationError ? 'INVALID' : 'EXPORT_FAILED', msg || '导出失败', isValidationError ? 400 : 500);
  }
});

router.get('/', (req: Request, res: Response) => {
  // query.projectId 运行期可能是 string | string[] | undefined（?projectId=a&projectId=b 场景）
  const raw = req.query.projectId;
  const projectId = typeof raw === 'string' ? raw : undefined;
  ok(res, exportRepo.list(projectId));
});

// H4 修复(第十九轮): 清空指定项目的全部导出记录 + 关联文件
// 放在 /:id 之前,避免被通配匹配(:projectId 误吞 "project" 字面量虽不会发生,显式靠前更稳)
router.delete('/project/:projectId', (req: Request, res: Response) => {
  const { projectId } = req.params;
  if (!projectId) return fail(res, 'INVALID', 'projectId 必填');
  try {
    const paths = exportRepo.clearByProject(projectId);
    paths.forEach(p => safeDeleteFile(p));
    ok(res, { deleted: paths.length });
  } catch (e) {
    fail(res, 'CLEAR_FAILED', (e as Error).message || '清空失败', 500);
  }
});

// H4 修复(第十九轮): 删除单条导出记录 + 关联文件
router.delete('/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) return fail(res, 'INVALID', 'id 必填');
  try {
    const filePath = exportRepo.delete(id);
    if (filePath === null) return fail(res, 'NOT_FOUND', '导出记录不存在', 404);
    safeDeleteFile(filePath);
    ok(res, { id });
  } catch (e) {
    fail(res, 'DELETE_FAILED', (e as Error).message || '删除失败', 500);
  }
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
