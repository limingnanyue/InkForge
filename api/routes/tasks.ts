/**
 * 守护进程任务路由 —— 列表/详情/控制 + 守护状态 + SSE 日志流
 */
import { Router, type Request, type Response } from 'express';
import { taskRepo, taskLogRepo } from '../repos.js';
import { onStream, cancelToken } from '../daemon.js';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });

router.get('/', (req: Request, res: Response) => {
  const projectId = req.query.projectId as string | undefined;
  ok(res, taskRepo.list(projectId));
});

router.get('/:id', (req: Request, res: Response) => {
  const task = taskRepo.get(req.params.id);
  if (!task) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在' } });
  ok(res, task);
});

router.get('/:id/logs', (req: Request, res: Response) => {
  ok(res, taskLogRepo.listByTask(req.params.id));
});

router.post('/:id/pause', (req: Request, res: Response) => {
  const cur = taskRepo.get(req.params.id);
  if (!cur) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在' } });
  // 状态守卫：仅 running/queued 可 pause。done/failed 状态调 pause 会丢失完成/失败语义
  if (cur.status !== 'running' && cur.status !== 'queued') {
    return res.status(409).json({ ok: false, error: { code: 'INVALID_STATUS', message: `当前状态 ${cur.status} 不可暂停` } });
  }
  // running 中：通过 cancel token 让 worker 在章节边界主动停止
  if (cur.status === 'running') cancelToken(req.params.id);
  // BUG-7 修复：用 CAS 更新防 TOCTOU 竞态
  // 场景：状态守卫检查后、update 执行前 worker 恰好完成标记 done，原 update 会无脑覆盖 done 为 paused
  // CAS 保证只在仍是 running/queued 时才置 paused，已完成任务不被覆盖
  const task = taskRepo.updateIfStatusIn(req.params.id, ['running', 'queued'], { status: 'paused' });
  if (!task) {
    return res.status(409).json({ ok: false, error: { code: 'INVALID_STATUS', message: '任务状态已变更（可能已完成），不可暂停' } });
  }
  ok(res, task);
});

// resume：仅 paused/failed 状态可继续，从 checkpoint 续传（与 continue 端点一致）
// 原 bug：直接置 queued 无状态校验，对 done 任务调 resume 会重新入队，worker 从 checkpoint 续传会重复生成
router.post('/:id/resume', (req: Request, res: Response) => {
  const task = taskRepo.resumeFromCheckpoint(req.params.id);
  if (!task) return res.status(409).json({ ok: false, error: { code: 'INVALID_STATUS', message: '仅已暂停或失败的任务可继续' } });
  ok(res, task);
});

// 失败重试：保留 checkpoint 续传，retry_count+1（超 max_retries 则 409）
router.post('/:id/retry', (req: Request, res: Response) => {
  // 状态守卫：仅 failed 可 retry。
  //   running → retryCount+1 后 worker 失败重试时基于已被 +1 的 retryCount 再 +1，跳过一次重试机会
  //   queued   → 任务尚未开始何来重试，语义错误
  //   done     → 已完成不应重试，对 refine-book 等长任务会无谓累加 retryCount
  //   paused   → 应走 resume，不应走 retry
  const cur = taskRepo.get(req.params.id);
  if (!cur) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在' } });
  if (cur.status !== 'failed') {
    return res.status(409).json({ ok: false, error: { code: 'INVALID_STATUS', message: `当前状态 ${cur.status} 不可重试，仅 failed 可重试` } });
  }
  const task = taskRepo.retry(req.params.id);
  if (!task) return res.status(409).json({ ok: false, error: { code: 'RETRY_EXHAUSTED', message: '重试次数已耗尽（max_retries）' } });
  ok(res, task);
});

// 查看进度并继续：仅 paused/failed 状态可继续，从 checkpoint 续传
router.post('/:id/continue', (req: Request, res: Response) => {
  const task = taskRepo.resumeFromCheckpoint(req.params.id);
  if (!task) return res.status(409).json({ ok: false, error: { code: 'INVALID_STATUS', message: '仅已暂停或失败的任务可继续' } });
  ok(res, task);
});

router.post('/:id/cancel', (req: Request, res: Response) => {
  // 通过 cancel token 让运行中的 worker 在章节边界主动停止，再删除任务
  cancelToken(req.params.id);
  taskRepo.delete(req.params.id);
  ok(res, { id: req.params.id });
});

// 守护进程状态
router.get('/daemon/status', (_req: Request, res: Response) => {
  const tasks = taskRepo.list();
  ok(res, {
    running: tasks.filter(t => t.status === 'running').length,
    queued: tasks.filter(t => t.status === 'queued').length,
    done: tasks.filter(t => t.status === 'done').length,
    failed: tasks.filter(t => t.status === 'failed').length,
    total: tasks.length,
  });
});

// SSE 实时任务流（订阅事件总线）
router.get('/stream/events', (req: Request, res: Response) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(':connected\n\n');
  const off = onStream(event => {
    res.write(`data:${JSON.stringify(event)}\n\n`);
  });
  const keep = setInterval(() => res.write(':ping\n\n'), 15000);
  req.on('close', () => { off(); clearInterval(keep); });
});

export default router;
