/**
 * HTTP 服务入口（本地开发）
 * 守护进程由独立 worker.ts 运行
 */
import app from './app.js';
import { startWorker } from './daemon.js';

const PORT = process.env.PORT || 3001;

// 本地模式下，HTTP 服务内嵌启动一个 worker（服务器部署可独立运行 worker 进程）
if (process.env.INKFORGE_EMBED_WORKER !== 'false') {
  startWorker();
  console.log('守护进程已随服务启动（本地模式）');
}

const server = app.listen(PORT, () => {
  console.log(`InkForge 墨铸 · 服务就绪 → http://localhost:${PORT}`);
});

// 优雅退出：给现有请求 2s 收尾时间，超时强制 exit
// 否则 SSE 长连接（/api/v1/tasks/stream/events 持久 keep-alive）会让 server.close 永久挂起，
// 进程不退出但 worker loop 实际已死，表现为任务永远 queued 不被消费
function shutdown(signal: string): void {
  console.log(`收到 ${signal}，开始关闭…`);
  let exited = false;
  const forceTimer = setTimeout(() => {
    if (exited) return;
    console.warn(`server.close 2s 未完成（疑似 SSE 长连接未断），强制 exit`);
    process.exit(1);
  }, 2000);
  server.close((err) => {
    exited = true;
    clearTimeout(forceTimer);
    if (err) { console.error('server.close 出错:', err.message); process.exit(1); }
    else process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
