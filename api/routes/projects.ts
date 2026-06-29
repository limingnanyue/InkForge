/**
 * 项目 + 章节 + 智能体状态 路由
 */
import { Router, type Request, type Response } from 'express';
import { projectRepo, chapterRepo, stateRepo, messageRepo, providerRepo, taskRepo } from '../repos.js';
import { complete } from '../llm.js';
import { PLATFORM_STYLES, inferGenreStyle, supportsTextRendering } from '../cover-styles.js';
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
  // R2 修复：白名单 + 类型校验，防篡改 projectId/updatedAt 等字段
  // projectId 由 path 参数决定，updatedAt 由 repo 自动管理
  const body = req.body || {};
  const patch: Record<string, unknown> = {};
  // 字符串字段（智能体状态七件套：创意/设定/角色/记忆/审稿/修订/封面）
  for (const k of ['idea', 'setting', 'characters', 'memory', 'review', 'revision', 'cover'] as const) {
    if (typeof body[k] === 'string') patch[k] = body[k];
  }
  // 数组字段（结构化状态机：伏笔/角色实时状态/三层摘要归档/卷纲）
  // B5 修复: 对数组元素做基本结构校验,过滤掉非对象/缺关键字段的脏数据,防前端渲染时崩溃
  if (Array.isArray(body.foreshadowing)) {
    patch.foreshadowing = body.foreshadowing.filter(
      (f: unknown) => f && typeof f === 'object' && typeof (f as any).desc === 'string'
    );
  }
  if (Array.isArray(body.characterState)) {
    patch.characterState = body.characterState.filter(
      (c: unknown) => c && typeof c === 'object' && typeof (c as any).name === 'string'
    );
  }
  if (Array.isArray(body.chapterSummaries)) {
    patch.chapterSummaries = body.chapterSummaries.filter(
      (s: unknown) => s && typeof s === 'object' && typeof (s as any).idx === 'number'
    );
  }
  if (Array.isArray(body.volumeOutlines)) {
    patch.volumeOutlines = body.volumeOutlines.filter(
      (v: unknown) => v && typeof v === 'object' && typeof (v as any).title === 'string'
    );
  }
  const state = stateRepo.update(req.params.id, patch);
  ok(res, state);
});

// ===== AI 生成：简介 + 封面提示词 =====
// 同步走 complete()（仿 analyze.ts 模式），支持前端透传 model/providerId
// 用法：前端 ProjectDetail 简介 Tab 加「AI 生成」按钮，调这两个接口

// 解析请求里的 model/providerId，不传则回落到 default provider 旗舰（与 daemon.runTask 一致）
// G3 修复：原逻辑仅当 model 与 providerId 同时存在才校验，二者仅传其一时全部丢弃用户选择
// 现分两段：先定 provider（指定 providerId 不存在则回落 default），再定 model（不在 provider.models 则回落旗舰）
function pickLLM(req: Request): { model: string; providerId?: string } {
  const { model, providerId } = req.body || {};
  const p = (providerId && providerRepo.get(providerId)) || providerRepo.getDefault();
  if (!p) throw new Error('未配置任何 LLM 提供商');
  const validModel = model && p.models.includes(model) ? model : p.models[0];
  return { model: validModel, providerId: p.id };
}

// POST /:id/generate-summary
// 基于项目标题/题材/创意/已有章节摘要生成一句话简介，落 project.summary
router.post('/:id/generate-summary', async (req: Request, res: Response) => {
  const project = projectRepo.get(req.params.id);
  if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  const state = stateRepo.get(project.id);
  const { model, providerId } = pickLLM(req);

  // G2 修复：原 chapters.length - 5 + i + 1 在章数<5 时为负/0，且 chapters 与 chapterSummaries 不同源
  // 改用 ChapterSummary.idx（= chapter.orderIdx）作为权威序号
  const recentSummaries = (state?.chapterSummaries || [])
    .slice(-5)
    .map(s => `第${(s.idx ?? 0) + 1}章：${s.summary || ''}`)
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

// 封面风格预设表：key → { 名称, 中文风格描述, 英文风格关键词 }
// 升级：支持多种风格切换，书名/作者输入由前端透传
export const COVER_STYLES: Record<string, { name: string; zh: string; en: string }> = {
  realistic:  { name: '写实摄影', zh: '电影级写实摄影风，注重光影与材质质感', en: 'cinematic photography, hyperrealistic, dramatic lighting, ultra-detailed, 8k' },
  anime:      { name: '动漫',     zh: '日式动漫插画风格，色彩明亮，线条柔和', en: 'anime style, vibrant colors, clean line art, studio anime key visual' },
  oil:        { name: '油画',     zh: '古典油画质感，厚重笔触，深邃色调',     en: 'oil painting, classical baroque, thick brush strokes, rich tones' },
  watercolor: { name: '水彩',     zh: '水彩插画，柔和晕染，淡雅色调',         en: 'watercolor painting, soft washes, delicate pastel palette' },
  cyberpunk:  { name: '赛博朋克', zh: '赛博朋克霓虹夜景，强对比高饱和',       en: 'cyberpunk, neon-lit night, high contrast, futuristic cityscape' },
  fantasy:    { name: '奇幻',     zh: '史诗奇幻插画，宏大场景，魔幻氛围',     en: 'epic fantasy illustration, sweeping landscape, magical atmosphere' },
  aesthetic:  { name: '唯美插画', zh: '唯美插画，柔光朦胧，氛围感强',         en: 'aesthetic illustration, soft glow, dreamy mood, painterly' },
  retro:      { name: '复古',     zh: '复古海报风格，颗粒质感，怀旧色调',     en: 'retro poster, vintage halftone, faded palette, grain texture' },
  monochrome: { name: '黑白',     zh: '黑白插画，强光影对比，戏剧氛围',       en: 'monochrome, high-contrast black and white, dramatic shadow' },
  inkwash:    { name: '东方水墨', zh: '东方水墨写意，留白意境，文人画风',     en: 'Chinese ink wash painting, traditional literati style, negative space' },
};

// POST /:id/generate-cover
// 基于项目信息 + 平台风格 + 题材推断 生成封面图像提示词（中文描述 + 英文 prompt 双段），落 agent_state.cover
// 升级(参考 oh-story-claudecode/skills/story-cover):
//   1. 平台风格库(番茄/起点/晋江/知乎盐言/七猫/刺猬猫/通用)
//   2. 题材推断规则(书名关键词→题材→风格标签+色彩+光效)
//   3. 提示词公式: [平台风格]+[文字层]+[题材风格]+[人物]+[背景]+[色彩]+[光效]+[通用修饰]
//   4. 文字层指令: GPT-Image-2 支持中文渲染时,直接 "Title text '书名' at top center" 一步到位
router.post('/:id/generate-cover', async (req: Request, res: Response) => {
  const project = projectRepo.get(req.params.id);
  if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
  const state = stateRepo.get(project.id);
  const { model, providerId } = pickLLM(req);
  const body = req.body || {};
  // 兼容旧 style 参数 + 新 platform 参数(优先 platform)
  const platformKey = (typeof body.platform === 'string' && body.platform) ? body.platform
    : (typeof body.style === 'string' && body.style) ? body.style : 'generic';
  const platform = PLATFORM_STYLES[platformKey] || PLATFORM_STYLES.generic;
  // 书名默认回落到 project.title，允许前端覆盖（如想用副标题）
  const bookTitle = (typeof body.bookTitle === 'string' && body.bookTitle.trim())
    ? body.bookTitle.trim() : project.title;
  // 作者署名（可选）
  const author = (typeof body.author === 'string' && body.author.trim())
    ? body.author.trim() : '';
  // 文风（可选）
  const tone = (typeof body.tone === 'string' && body.tone) ? body.tone : '通用';
  // 题材推断(oh-story 规则: 书名关键词→题材→风格标签)
  const genreStyle = inferGenreStyle(bookTitle, project.genre);

  const prompt = `请为这部作品生成封面图像提示词，用于 AI 绘图（GPT-Image-2 / Stable Diffusion / Midjourney）。

作品信息：
- 书名：${bookTitle}
- 作者：${author || '（未署名）'}
- 题材：${project.genre || '通用'}（推断风格：${genreStyle.label}）
- 创意：${state?.idea || '（无）'}
- 世界观设定：${state?.setting || '（无设定）'}
- 文风：${tone}
- 目标平台：${platform.label}
- 平台视觉风格关键词：${platform.keywords}
- 书名字体：${platform.titleFont}
- 作者名字体：${platform.authorFont}
- 题材风格标签：${genreStyle.styleTag}
- 色彩指令：${genreStyle.palette}
- 光效指令：${genreStyle.lighting}

要求输出两段：
1. 【中文描述】封面画面构思，30-80 字，描述主体人物(具体到服饰/动作/表情)、场景(前景/中景/远景三层)、氛围、关键视觉元素，需呼应书名与题材
2. 【英文 Prompt】可直接喂给 GPT-Image-2 / SD / MJ 的 prompt，遵循公式:
   [平台风格] + [文字层] + [题材风格] + [人物描述] + [背景三层] + [色彩指令] + [光效指令] + [通用修饰]
   逗号分隔，60-120 词

文字层处理(关键):
- 若目标图像模型是 GPT-Image-2 / dall-e-3 / seedream 等支持中文渲染的模型,文字层用指令:
  "Title text '${bookTitle}' at top center in ${platform.titleFont}"
  ${author ? `"Author name '${author}' at bottom center in ${platform.authorFont}"` : '（无作者署名则不加作者文字层）'}
- 若目标模型不支持中文渲染(SD/FLUX 等),文字层改为:
  "negative space at top and bottom for title text overlay, book cover layout, no text in image"
  (后期由前端 canvas 叠加书名作者)

务必包含题材风格关键词: ${genreStyle.styleTag}
务必包含色彩指令: ${genreStyle.palette}
务必包含光效指令: ${genreStyle.lighting}
末尾加通用修饰: "professional book cover design, high detail digital painting, portrait orientation 2:3 ratio, no watermark"

格式：
中文：...
Prompt: ...

直接输出，不要解释。`;

  try {
    const { text } = await complete({
      providerId, model,
      systemStable: `你是资深网文封面设计师与 AI 绘图 prompt 工程师，参考 oh-story 方法论，擅长把文学作品转化为视觉画面，精通 ${platform.label} 平台风格与 ${genreStyle.label} 题材。`,
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

// POST /:id/cover-preview
// H2+H3 修复(第十一轮): 封面预览图后端代理
// 原方案前端直连第三方 provider 的 /images/generations 有两个问题:
//   1) CORS 阻断: OpenAI/KKAPI 等不返回 Access-Control-Allow-Origin, 浏览器预检直接拒绝
//   2) apiKey 暴露: Authorization Bearer 从浏览器明文发往第三方域名, DevTools/扩展/MITM 可抓
// 现方案: 前端只调自己的 /api/v1/projects/:id/cover-preview, 后端拿 apiKey 调第三方,
//        返回 base64 图片数据, apiKey 永不离开服务端
// 入参: { prompt: string, providerId: string, model: string, bookTitle?: string, author?: string }
//   - providerId/model 必填(指定用哪个 provider 的哪个图像模型)
//   - prompt 是英文 Prompt(从 coverDraft 提取)
//   - bookTitle/author 可选,用于检测图像模型是否已渲染文字层
// 出参: { image: string, textRendered: boolean }  // textRendered=true 时图像已含书名作者,前端跳过 canvas 叠加
router.post('/:id/cover-preview', async (req: Request, res: Response) => {
  try {
    const project = projectRepo.get(req.params.id);
    if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
    const { prompt, providerId, model } = req.body || {};
    if (typeof prompt !== 'string' || !prompt.trim()) return fail(res, 'INVALID', 'prompt 必填');
    if (typeof providerId !== 'string' || !providerId) return fail(res, 'INVALID', 'providerId 必填');
    if (typeof model !== 'string' || !model) return fail(res, 'INVALID', 'model 必填');
    const provider = providerRepo.get(providerId);
    if (!provider) return fail(res, 'NOT_FOUND', 'provider 不存在', 404);
    if (!provider.models.includes(model)) return fail(res, 'INVALID', `模型 ${model} 不在该 provider 列表中`);
    if (!provider.apiKey && provider.kind !== 'ollama' && provider.kind !== 'kilo') {
      return fail(res, 'INVALID', `provider ${provider.name} 未配置 API Key`);
    }

    // 检测图像模型是否支持中文文字渲染(oh-story 备注: gpt-image-2 等可直接渲染中文)
    // 支持: prompt 已含 Title text/Author name 指令,图像一步到位含书名作者,前端跳过 canvas 叠加
    // 不支持: prompt 含 negative space 指令,前端 canvas 叠加兜底
    const textRendered = supportsTextRendering(model);

    // 调 OpenAI 兼容 /images/generations
    const ep = provider.baseUrl.replace(/\/+$/, '') + '/images/generations';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.kind !== 'ollama' && provider.kind !== 'kilo') {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
    // oh-story 备注: gpt-image-2 始终返回 base64,请求体不要带 response_format(旧 DALL-E 参数,gpt-image 系列不支持)
    // 故对 gpt-image 系列不传 response_format,其他模型仍传 b64_json
    const reqBody: Record<string, unknown> = {
      model,
      prompt: prompt.trim(),
      n: 1,
      size: '1024x1536',  // oh-story 默认 2:3 竖版比例
    };
    if (!textRendered) {
      // 非 gpt-image 系列(如 dall-e-3)显式要 b64_json
      reqBody.response_format = 'b64_json';
    }
    const upstream = await fetch(ep, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
    });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      return fail(res, 'UPSTREAM_ERROR',
        `${provider.name} · ${model} 图片生成失败（${upstream.status}）${errText ? ': ' + errText.slice(0, 300) : ''}`,
        502);
    }
    const json = await upstream.json() as { data?: Array<{ b64_json?: string; url?: string }> };
    const item = json.data?.[0];
    if (!item) return fail(res, 'UPSTREAM_ERROR', '图像供应商未返回 data 字段', 502);

    let dataUrl: string;
    if (item.b64_json) {
      dataUrl = `data:image/png;base64,${item.b64_json}`;
    } else if (item.url) {
      // 部分 provider 返回 url, 后端再下载转 base64
      const imgResp = await fetch(item.url);
      if (!imgResp.ok) return fail(res, 'UPSTREAM_ERROR', `下载图像失败（${imgResp.status}）`, 502);
      const buf = Buffer.from(await imgResp.arrayBuffer());
      dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    } else {
      return fail(res, 'UPSTREAM_ERROR', '图像供应商返回 data 字段不含 b64_json 或 url', 502);
    }
    ok(res, { image: dataUrl, textRendered });
  } catch (e) {
    fail(res, 'COVER_PREVIEW_FAILED', (e as Error).message || '封面预览生成失败', 500);
  }
});

// POST /:id/refine-book
// 整书精修：批量精修项目所有已生成章节，入队守护进程任务
// 透传 model/providerId（不传则后端回落到 default 旗舰），断点续传由 daemon 处理
router.post('/:id/refine-book', async (req: Request, res: Response) => {
  try {
    const project = projectRepo.get(req.params.id);
    if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);
    // 校验：项目必须有已生成内容的章节
    const chapters = chapterRepo.listByProject(project.id).filter(c => c.content && c.content.length > 100);
    if (chapters.length === 0) return fail(res, 'NO_CONTENT', '项目无已生成内容的章节，无可精修对象', 400);
    // 并发去重：同项目已有 queued/running 的 refine-book 任务时拒绝，防并发精修损坏 content
    const existing = taskRepo.list(project.id).some(t =>
      t.type === 'refine-book' && (t.status === 'queued' || t.status === 'running')
    );
    if (existing) return fail(res, 'CONFLICT', '已有整书精修任务在进行中，请等待完成或先取消', 409);
    // 透传模型选择（pickLLM 分两段校验：providerId 优先，回落到 default）
    const { model, providerId } = pickLLM(req);
    const task = taskRepo.create({
      projectId: project.id,
      type: 'refine-book',
      config: { projectId: project.id, model, providerId },
    });
    ok(res, task);
  } catch (e) {
    fail(res, 'LLM_ERROR', (e as Error).message || '派发失败', 500);
  }
});

// ===== 对话消息 =====
router.get('/:id/messages', (req: Request, res: Response) => {
  ok(res, messageRepo.listByProject(req.params.id));
});

export default router;
