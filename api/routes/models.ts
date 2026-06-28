/**
 * 模型中心路由 —— 提供商 CRUD + 连通性测试 + 余额查询 + 拉取远端模型 + 模型聚合
 */
import { Router, type Request, type Response } from 'express';
import { providerRepo } from '../repos.js';
import { testProvider, listModels, getBalance, listAvailableModels } from '../llm.js';
import type { ProviderKind } from '@shared/types';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

// 全部 13 种 kind（2026 年 6 月）
const VALID_KINDS: ProviderKind[] = [
  'openai', 'anthropic', 'gemini',
  'deepseek', 'qwen', 'glm', 'doubao', 'kimi', 'hunyuan', 'ernie',
  'kilo', 'ollama', 'custom',
];

router.get('/providers', (_req: Request, res: Response) => ok(res, providerRepo.list()));

router.post('/providers', (req: Request, res: Response) => {
  const { name, kind, baseUrl, apiKey, models } = req.body || {};
  if (!name || !kind || !baseUrl) return fail(res, 'INVALID', '名称、类型、baseUrl 必填');
  if (!VALID_KINDS.includes(kind)) return fail(res, 'INVALID', '类型不合法');
  ok(res, providerRepo.create({ name, kind: kind as ProviderKind, baseUrl, apiKey, models }));
});

router.patch('/providers/:id', (req: Request, res: Response) => {
  const provider = providerRepo.update(req.params.id, req.body || {});
  if (!provider) return fail(res, 'NOT_FOUND', '提供商不存在', 404);
  ok(res, provider);
});

router.delete('/providers/:id', (req: Request, res: Response) => {
  providerRepo.delete(req.params.id);
  ok(res, { id: req.params.id });
});

router.post('/providers/:id/test', async (req: Request, res: Response) => {
  const result = await testProvider(req.params.id);
  ok(res, result);
});

router.post('/providers/:id/default', (req: Request, res: Response) => {
  providerRepo.setDefault(req.params.id);
  ok(res, { id: req.params.id });
});

// 余额查询（仅 DeepSeek / Kimi 提供接口，其余返回说明）
router.get('/providers/:id/balance', async (req: Request, res: Response) => {
  const result = await getBalance(req.params.id);
  ok(res, result);
});

// 拉取远端可用模型列表（写入 provider.models）
router.post('/providers/:id/fetch-models', async (req: Request, res: Response) => {
  const provider = providerRepo.get(req.params.id);
  if (!provider) return fail(res, 'NOT_FOUND', '提供商不存在', 404);
  const result = await listAvailableModels(req.params.id);
  if (!result.ok || result.models.length === 0) {
    return ok(res, { ok: false, models: provider.models, message: result.message || '未拉取到模型' });
  }
  // 合并去重后写回
  const merged = Array.from(new Set([...result.models, ...provider.models]));
  const updated = providerRepo.update(req.params.id, { models: merged });
  ok(res, { ok: true, models: merged, fetched: result.models.length, provider: updated });
});

router.get('/', (_req: Request, res: Response) => ok(res, listModels()));

export default router;
