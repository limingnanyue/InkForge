/**
 * Express 应用 —— 注册所有路由 + 数据库初始化
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import projectRoutes from './routes/projects.js';
import chapterRoutes from './routes/chapters.js';
import chatRoutes from './routes/chat.js';
import generateRoutes from './routes/generate.js';
import taskRoutes from './routes/tasks.js';
import modelRoutes from './routes/models.js';
import exportRoutes from './routes/export.js';
import analyzeRoutes from './routes/analyze.js';
import usageRoutes from './routes/usage.js';
import genreRoutes from './routes/genres.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
initDb();

const app: express.Application = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 静态资源：导出文件
import { EXPORT_DIR } from './db.js';
app.use('/exports', express.static(EXPORT_DIR));

// API v1 路由
app.use('/api/v1/projects', projectRoutes);
app.use('/api/v1/chapters', chapterRoutes);
app.use('/api/v1/chat', chatRoutes);
app.use('/api/v1/generate', generateRoutes);
app.use('/api/v1/tasks', taskRoutes);
app.use('/api/v1/models', modelRoutes);
app.use('/api/v1/exports', exportRoutes);
app.use('/api/v1/analyze', analyzeRoutes);
app.use('/api/v1/usage', usageRoutes);
app.use('/api/v1/genres', genreRoutes);

// 健康检查
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, message: 'InkForge 墨铸 · 服务在线' });
});

// 生产环境：托管前端构建产物（dist/）
// 本地开发由 Vite Dev Server 负责，不走这里
const FRONTEND_DIST = path.resolve(__dirname, '..', 'dist');
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  // SPA 兜底：非 /api 路径统一回退到 index.html
  app.get(/^\/(?!api|exports).*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

// 404（仅 API 路径走到这里）
app.use((req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `路径不存在: ${req.method} ${req.url}` } });
});

// 错误处理
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[InkForge Error]', error);
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
});

export default app;
