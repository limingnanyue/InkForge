/**
 * 项目 + 章节 + 智能体状态 路由
 */
import { Router, type Request, type Response } from 'express';
import { projectRepo, chapterRepo, stateRepo, messageRepo, providerRepo } from '../repos.js';
import { complete } from '../llm.js';
import type { ProjectType } from '@shared/types';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

// ===== 项目 =====
router.get('/', (_req: Request, res: Response) => ok(res, projectRepo.list()));

router.post('/', (req: Request, res: Response) => {
  const { title, type, targetWords, summary, webSearchEnabled, genre, genreId } = req.body || {};
  if (!title || !type) return fail(res, 'INVALID', '标题和类型必填');
  if (!['long', 'short', 'script'].includes(type)) return fail(res, 'INVALID', '类型不合法');
  const project = projectRepo.create({ title, type: type as ProjectType, targetWords: targetWords || 0, summary, webSearchEnabled, genre, genreId });
  ok(res, project);
});

router.get('/:id', (req: Request, res: Response) => {
  const project = projectRepo.get(req.params.id);
  if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  ok(res, project);
});

router.patch('/:id', (req: Request, res: Response) => {
  // R2 修复：白名单过滤，防篡改 id/created_at/current_words 等字段
  // current_words 应由 updateWordCount 内部计算，不接受外部 PATCH 覆盖
  const body = req.body || {};
  const patch: Record<string, unknown> = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.summary === 'string') patch.summary = body.summary;
  if (typeof body.coverSeed === 'string') patch.coverSeed = body.coverSeed;
  if (typeof body.webSearchEnabled === 'boolean') patch.webSearchEnabled = body.webSearchEnabled;
  if (typeof body.genre === 'string') patch.genre = body.genre;
  if (typeof body.genreId === 'string' || body.genreId === null) patch.genreId = body.genreId;
  const project = projectRepo.update(req.params.id, patch);
  if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  ok(res, project);
});

router.delete('/:id', (req: Request, res: Response) => {
  projectRepo.delete(req.params.id);
  ok(res, { id: req.params.id });
});

// ===== 章节 =====
router.get('/:id/chapters', (req: Request, res: Response) => {
  ok(res, chapterRepo.tree(req.params.id));
});

router.post('/:id/chapters', (req: Request, res: Response) => {
  const { title, parentId, outline, content, orderIdx } = req.body || {};
  if (!title) return fail(res, 'INVALID', '章节标题必填');
  const chapter = chapterRepo.create({ projectId: req.params.id, parentId, title, outline, content, orderIdx });
  ok(res, chapter);
});

// ===== 智能体状态 =====
router.get('/:id/state', (req: Request, res: Response) => {
  const state = stateRepo.get(req.params.id);
  ok(res, state || stateRepo.update(req.params.id, {}));
});

router.patch('/:id/state', (req: Request, res: Response) => {
  const state = stateRepo.update(req.params.id, req.body || {});
  ok(res, state);
});

// ===== AI 生成：简介 + 封面提示词 =====
// 同步走 complete()（仿 analyze.ts 模式），支持前端透传 model/providerId
// 用法：前端 ProjectDetail 简介 Tab 加「AI 生成」按钮，调这两个接口

// 解析请求里的 model/providerId，不传则回落到 default provider 旗舰（与 daemon.runTask 一致）
function pickLLM(req: Request): { model: string; providerId?: string } {
  const { model, providerId } = req.body || {};
  if (model && providerId) {
    const p = providerRepo.get(providerId);
    if (p && p.models.includes(model)) return { model, providerId };
  }
  const p = providerRepo.getDefault();
  return { model: p?.models[0] || 'gpt-4o-mini', providerId: p?.id };
}

// POST /:id/generate-summary
// 基于项目标题/题材/创意/已有章节摘要生成一句话简介，落 project.summary
router.post('/:id/generate-summary', async (req: Request, res: Response) => {
  const project = projectRepo.get(req.params.id);
  if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  const state = stateRepo.get(project.id);
  const chapters = chapterRepo.listByProject(project.id);
  const { model, providerId } = pickLLM(req);

  // 章节摘要取最近 5 章作为内容样本（避免 prompt 过长）
  const recentSummaries = (state?.chapterSummaries || [])
    .slice(-5)
    .map((s, i) => `第${chapters.length - 5 + i + 1}章：${s.summary || ''}`)
    .filter(Boolean)
    .join('\n');

  const prompt = `请为这部作品生成一句话简介（80-150 字），要求：
- 概括核心冲突与卖点，不剧透关键反转
- 紧扣题材风格（${project.genre || '通用'}）
- 有钩子感，激发读者点击欲

作品信息：
- 标题：${project.title}
- 题材：${project.genre || '未指定'}
- 创意：${state?.idea || '（无）'}
- 目标字数：${project.targetWords}
${recentSummaries ? `- 最近章节摘要：\n${recentSummaries}` : ''}

直接输出简介正文，不要标题、不要解释、不要引号。`;

  try {
    const { text } = await complete({
      providerId, model,
      systemStable: '你是资深网文编辑，擅长用一句话抓住读者眼球。',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7, maxTokens: 512,
      projectId: project.id,
    });
    const summary = text.trim().replace(/^["'"「『]+|["'"」』]+$/g, '');
    const updated = projectRepo.update(project.id, { summary });
    ok(res, { summary: updated?.summary || summary });
  } catch (e) {
    fail(res, 'LLM_ERROR', (e as Error).message || '生成失败', 500);
  }
});

// POST /:id/generate-cover
// 基于项目信息生成封面图像提示词（中文描述 + 英文 prompt 双段），落 agent_state.cover
router.post('/:id/generate-cover', async (req: Request, res: Response) => {
  const project = projectRepo.get(req.params.id);
  if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  const state = stateRepo.get(project.id);
  const { model, providerId } = pickLLM(req);

  const prompt = `请为这部作品生成封面图像提示词，用于 AI 绘图（如 Stable Diffusion / Midjourney）。

作品信息：
- 标题：${project.title}
- 题材：${project.genre || '通用'}
- 创意：${state?.idea || '（无）'}
- 文风：${state?.setting || '（无设定）'}

要求输出两段：
1. 【中文描述】封面画面构思，30-80 字，描述主体、场景、氛围、关键视觉元素
2. 【英文 Prompt】可直接喂给 SD/MJ 的 prompt，含主体、风格、镜头、光线、画质标签，逗号分隔，50-100 词

格式：
中文：...
Prompt: ...

直接输出，不要解释。`;

  try {
    const { text } = await complete({
      providerId, model,
      systemStable: '你是资深插画师与 AI 绘图 prompt 工程师，擅长把文学作品转化为视觉画面。',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8, maxTokens: 1024,
      projectId: project.id,
    });
    const cover = text.trim();
    stateRepo.update(project.id, { cover });
    ok(res, { cover });
  } catch (e) {
    fail(res, 'LLM_ERROR', (e as Error).message || '生成失败', 500);
  }
});

// ===== 对话消息 =====
router.get('/:id/messages', (req: Request, res: Response) => {
  ok(res, messageRepo.listByProject(req.params.id));
});

export default router;
