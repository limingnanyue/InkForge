/**
 * 分析工具路由 —— 市场风向扫榜（风向标）+ 拆书分析
 * 参考 oh-story-claudecode 的"扫榜→拆文"方法论
 * 扫榜结果落库 market_scan 表，支持历史回看与趋势分析
 */
import { Router, type Request, type Response } from 'express';
import { providerRepo, marketScanRepo, genreRepo } from '../repos.js';
import { complete } from '../llm.js';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

// 默认模型/提供商
function getDefaultLLM(): { model: string; providerId?: string } {
  const p = providerRepo.getDefault();
  return { model: p?.models[0] || 'gpt-4o-mini', providerId: p?.id };
}

/**
 * 市场风向扫榜：分析某题材的市场热度、热门套路、读者画像、切入点建议
 * POST /api/v1/analyze/market
 * body: { genre, genreId?, webSearch?, period? }
 * 扫榜成功后落库 market_scan 表（风向标历史记录）
 */
router.post('/market', async (req: Request, res: Response) => {
  const { genre, genreId, webSearch, period } = req.body || {};
  if (!genre) return fail(res, 'INVALID', '题材必填');
  // genreId 可空（自定义题材时无 id）；若提供则校验存在
  if (genreId) {
    const g = genreRepo.get(genreId);
    if (!g) return fail(res, 'INVALID', `题材库无此 id: ${genreId}`);
  }
  const { model, providerId } = getDefaultLLM();

  const periodHint = period || '近三个月';
  // 注入题材说明 + 情绪映射（如有），让 LLM 输出更精准
  const genreMeta = genreId ? genreRepo.get(genreId) : null;
  const metaHint = genreMeta
    ? `\n题材参考信息：${genreMeta.description || '（无）'}\n核心情绪：${genreMeta.emotionMap || '（无）'}`
    : '';
  const prompt = `你是网文市场分析师。请对「${genre}」题材做市场风向扫榜分析，覆盖 ${periodHint}。${metaHint}

严格输出以下五个板块（用 markdown 二级标题 ## 分隔）：

## 市场热度
该题材当前在主流平台（起点/番茄/晋江/七猫）的热度等级（高/中/低），日更作品数预估，读者基数量级。

## 热门套路 TOP5
列出当前最吃香的 5 个套路模式，每个 50 字内，说明「确定性情绪满足点」（读者为什么会爽）。

## 读者画像
核心读者群体（性别/年龄/职业倾向）、阅读时段、付费意愿、最在意的爽点与雷点。

## 竞品红海度
同质化程度（红海/蓝海/细分蓝海），头部作品举例 2-3 本（可虚构典型代表作），新人切入难度评估。

## 切入点建议
给出 3 个差异化切入点，每个 60 字内，说明如何避开红海、找到细分蓝海。

要求：客观、数据化、避免空话。`;

  try {
    // 缓存优化：system 作为稳定段，跨多次扫榜调用命中
    const { text: result } = await complete({
      providerId, model, webSearch: !!webSearch,
      searchQuery: `${genre} 网文 热门 套路 2026 排行榜`,
      systemStable: '你是资深网文市场分析师，擅长扫榜与套路拆解，输出客观数据化分析。',
      messages: [
        { role: 'user', content: prompt },
      ],
      temperature: 0.6, maxTokens: 2048,
    });
    // 落库风向标历史
    const scan = marketScanRepo.create({
      genre, genreId, period: periodHint, webSearch: !!webSearch, content: result,
    });
    ok(res, { content: result, genre, period: periodHint, scanId: scan.id });
  } catch (e) {
    fail(res, 'LLM_ERROR', (e as Error).message, 500);
  }
});

/**
 * 扫榜历史（风向标）：列出最近的扫榜记录，支持按 genreId 过滤
 * GET /api/v1/analyze/market-scan?genreId=xxx
 */
router.get('/market-scan', (req: Request, res: Response) => {
  const raw = req.query.genreId;
  const genreId = typeof raw === 'string' ? raw : undefined;
  ok(res, marketScanRepo.list(genreId));
});

/**
 * 获取单条扫榜记录详情
 * GET /api/v1/analyze/market-scan/:id
 */
router.get('/market-scan/:id', (req: Request, res: Response) => {
  const scan = marketScanRepo.get(req.params.id);
  if (!scan) return fail(res, 'NOT_FOUND', '扫榜记录不存在', 404);
  ok(res, scan);
});

/**
 * 删除扫榜记录
 * DELETE /api/v1/analyze/market-scan/:id
 */
router.delete('/market-scan/:id', (req: Request, res: Response) => {
  marketScanRepo.delete(req.params.id);
  ok(res, { deleted: true });
});

/**
 * 拆书分析：拆解某作品的结构、人设、伏笔、节奏、可借鉴套路
 * POST /api/v1/analyze/teardown
 * body: { title, summary, webSearch?, focus? }
 */
router.post('/teardown', async (req: Request, res: Response) => {
  const { title, summary, webSearch, focus } = req.body || {};
  if (!title) return fail(res, 'INVALID', '作品名必填');
  const { model, providerId } = getDefaultLLM();

  const focusHint = focus ? `\n用户特别关注：${focus}` : '';
  const prompt = `你是网文结构拆解师，参考「拆文」方法论。请拆解作品《${title}》。

${summary ? `作品简介：${summary}` : '（无简介，请基于该作品名做分析）'}${focusHint}

严格输出以下六个板块（用 markdown 二级标题 ## 分隔）：

## 作品定位
题材归类、目标读者、核心卖点（一句话）。

## 结构拆解
开篇钩子 → 主线推进 → 高潮设计 → 结局收束，每段说明作者如何控制节奏与信息密度。

## 人设分析
主角成长弧（初始→转变→觉醒→巅峰）、关键配角功能（导师/对手/红颜/兄弟）、人设记忆点。

## 伏笔与回收
列出 3-5 个关键伏笔，说明埋设时机、回收时机、情绪回报。

## 节奏诊断
爽点密度评估（每章/每万字）、低谷期处理、章末钩子使用频率与效果。

## 可借鉴套路
提炼 3 个可直接复用到新作的商业套路，每个 60 字内，说明「确定性情绪满足点」。

要求：结构化、可操作，避免泛泛而谈。`;

  try {
    // 缓存优化：system 作为稳定段，跨多次拆书调用命中
    const { text: result } = await complete({
      providerId, model, webSearch: !!webSearch,
      searchQuery: `${title} 小说 剧情 人物 结局`,
      systemStable: '你是网文拆解专家，擅长把作品拆成可复用的商业结构。',
      messages: [
        { role: 'user', content: prompt },
      ],
      temperature: 0.6, maxTokens: 2560,
    });
    ok(res, { content: result, title });
  } catch (e) {
    fail(res, 'LLM_ERROR', (e as Error).message, 500);
  }
});

export default router;
