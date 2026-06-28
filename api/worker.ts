/**
 * 守护进程 Worker 入口（独立进程）
 * 服务器部署：与 HTTP 服务分离运行，互不影响；崩溃后可独立重启续跑
 * 本地部署：可省略，HTTP 服务已内嵌 worker
 */
import { initDb } from './db.js';
import { startWorker } from './daemon.js';

initDb();
startWorker();
console.log('InkForge 守护进程已启动 · 轮询任务队列中…');

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
