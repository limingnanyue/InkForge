/**
 * 守护进程任务路由 —— 列表/详情/控制 + 守护状态 + SSE 日志流
 */
import { Router, type Request, type Response } from 'express';
import { taskRepo, taskLogRepo } from '../repos.js';
import { onStream } from '../daemon.js';

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
  const task = taskRepo.update(req.params.id, { status: 'paused' });
  ok(res, task);
});

router.post('/:id/resume', (req: Request, res: Response) => {
  const task = taskRepo.update(req.params.id, { status: 'queued' });
  ok(res, task);
});

// 失败重试：保留 checkpoint 续传，retry_count+1（超 max_retries 则 409）
router.post('/:id/retry', (req: Request, res: Response) => {
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
