/**
 * 题材库路由 —— 内置 + 用户自定义题材的 CRUD
 * 取代前端硬编码常量，支持用户添加/编辑/删除自定义题材
 */
import { Router, type Request, type Response } from 'express';
import { genreRepo, providerRepo } from '../repos.js';
import { db } from '../db.js';
import { complete } from '../llm.js';
import { fetchSearchContext } from '../websearch.js';
import type { GenreCategory } from '../../shared/genres.js';

const router = Router();

const ok = (res: Response, data?: unknown) => res.json({ ok: true, data });
const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

// 校验 id slug：只允许小写字母/数字/短横线，长度 2-50
const ID_RE = /^[a-z0-9][a-z0-9-]{1,49}$/;
const VALID_CATEGORIES: GenreCategory[] = ['male', 'female', 'common'];

// GET /api/v1/genres —— 列出全部题材（按 category 分组返回前端可直接 optgroup）
router.get('/', (_req: Request, res: Response) => {
  ok(res, genreRepo.list());
});

// GET /api/v1/genres/:id
router.get('/:id', (req: Request, res: Response) => {
  const g = genreRepo.get(req.params.id);
  if (!g) return fail(res, 'NOT_FOUND', '题材不存在', 404);
  ok(res, g);
});

// POST /api/v1/genres —— 创建自定义题材
router.post('/', (req: Request, res: Response) => {
  const { id, label, category, description, emotionMap } = req.body || {};
  if (!id || !ID_RE.test(id)) return fail(res, 'INVALID', 'id 必填且仅允许小写字母/数字/短横线，2-50 字符');
  if (!label || typeof label !== 'string' || label.trim().length < 2) return fail(res, 'INVALID', 'label 必填且至少 2 字符');
  if (!category || !VALID_CATEGORIES.includes(category)) return fail(res, 'INVALID', 'category 必须为 male/female/common');
  if (genreRepo.get(id)) return fail(res, 'DUPLICATE', 'id 已存在', 409);
  try {
    const g = genreRepo.create({ id: id.toLowerCase(), label: label.trim(), category, description, emotionMap });
    ok(res, g);
  } catch (e) {
    fail(res, 'CREATE_FAILED', (e as Error).message, 500);
  }
});

// PATCH /api/v1/genres/:id —— 更新题材（内置题材可改 label/description/emotionMap，但 category 也可改）
router.patch('/:id', (req: Request, res: Response) => {
  const cur = genreRepo.get(req.params.id);
  if (!cur) return fail(res, 'NOT_FOUND', '题材不存在', 404);
  const { label, category, description, emotionMap } = req.body || {};
  if (category && !VALID_CATEGORIES.includes(category)) return fail(res, 'INVALID', 'category 必须为 male/female/common');
  if (label !== undefined && (typeof label !== 'string' || label.trim().length < 2)) return fail(res, 'INVALID', 'label 至少 2 字符');
  try {
    const g = genreRepo.update(req.params.id, { label, category, description, emotionMap });
    ok(res, g);
  } catch (e) {
    fail(res, 'UPDATE_FAILED', (e as Error).message, 500);
  }
});

// DELETE /api/v1/genres/:id —— 删除题材（内置题材不可删）
// 同步清理引用：project.genre_id 置空 + genre 留 label 兜底显示；market_scan.genre_id 置空（保留历史）
router.delete('/:id', (req: Request, res: Response) => {
  const cur = genreRepo.get(req.params.id);
  if (!cur) return fail(res, 'NOT_FOUND', '题材不存在', 404);
  if (cur.isBuiltin) return fail(res, 'FORBIDDEN', '内置题材不可删除（可编辑）', 403);
  try {
    const id = req.params.id;
    db.transaction(() => {
      // project: 置 genre_id=NULL，但保留 genre label 字段以兜底显示（避免项目题材显示空白）
      db.prepare("UPDATE project SET genre_id=NULL WHERE genre_id=?").run(id);
      // market_scan: 仅置 genre_id=NULL，历史报告内容（content 字段）不受影响
      db.prepare("UPDATE market_scan SET genre_id=NULL WHERE genre_id=?").run(id);
      genreRepo.delete(id);
    })();
    ok(res, { deleted: true });
  } catch (e) {
    fail(res, 'DELETE_FAILED', (e as Error).message, 500);
  }
});

// POST /api/v1/genres/:id/enrich
// AI 补全题材说明: 联网搜索(AnySearch) + LLM 生成详细 description + emotionMap
// 用户痛点: 内置题材 description 每条仅 10-20 字一句话,说明不完善
// 现方案: 调 AnySearch 搜"题材名 网文 套路 设定"抓 5 条摘要,再让 LLM 基于摘要
//        生成 80-150 字详细说明 + 3-5 个核心情绪标签,落库覆盖原 description/emotionMap
// 入参: { model?, providerId?, webSearch? }  (不传则回落 default 旗舰)
// 出参: { description, emotionMap }  (已落库)
router.post('/:id/enrich', async (req: Request, res: Response) => {
  try {
    const g = genreRepo.get(req.params.id);
    if (!g) return fail(res, 'NOT_FOUND', '题材不存在', 404);
    // 解析 model/providerId(不传则 default 旗舰), 与 analyze.ts 同款逻辑
    const p = (req.body?.providerId && providerRepo.get(req.body.providerId)) || providerRepo.getDefault();
    if (!p) return fail(res, 'INVALID', '未配置任何 LLM 提供商');
    const model = (req.body?.model && p.models.includes(req.body.model)) ? req.body.model : p.models[0];
    const wantWebSearch = req.body?.webSearch !== false;  // 默认开启联网搜索

    // 1) 联网搜索抓摘要(默认 provider 的 webSearch 配置)
    let searchCtx = '';
    if (wantWebSearch) {
      searchCtx = await fetchSearchContext(
        `${g.label} 网文 套路 设定 爽点 雷点`,
        p.webSearch?.enabled ? p.webSearch : { enabled: true, maxResults: 5 },
      );
    }

    // 2) LLM 基于摘要生成详细 description + emotionMap
    const prompt = `你是网文题材研究专家。请为「${g.label}」题材生成详细的题材说明与核心情绪映射。

${searchCtx ? `【联网搜索参考】\n${searchCtx}\n\n` : ''}题材当前信息(可能为简短一句话):
- description: ${g.description || '（无）'}
- emotionMap: ${g.emotionMap || '（无）'}

要求输出严格 JSON 格式(不要 markdown 代码块、不要其他文字):
{"description":"80-150 字详细说明,涵盖题材核心特征/世界观类型/常见套路/爽点雷点,供 LLM 写作 prompt 参考","emotionMap":"3-5 个核心情绪标签,斜杠分隔,如 爽感/逆袭/装逼打脸"}

说明:
- description 要具体,不能空话(避免"该题材很受欢迎"之类)
- emotionMap 是情绪标签,不是题材描述(如"爽感"而非"很爽")
- 若搜索结果为空,基于题材名 ${g.label} 自身常识生成`;
    const { text } = await complete({
      providerId: p.id, model,
      systemStable: '你是网文题材研究专家,擅长把题材特征提炼为 LLM 可用的 prompt 元信息。',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7, maxTokens: 512,
    });

    // 3) 解析 JSON(容错: 去 markdown 代码块 + 正则提取)
    let description = '';
    let emotionMap = '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*?"description"[\s\S]*?"emotionMap"[\s\S]*?\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (typeof obj.description === 'string') description = obj.description.trim();
        if (typeof obj.emotionMap === 'string') emotionMap = obj.emotionMap.trim();
      } catch { /* JSON 解析失败走兜底 */ }
    }
    // 兜底: 若解析失败,把整段 text 当 description
    if (!description && text.trim()) description = text.trim().slice(0, 200);
    if (!description) return fail(res, 'LLM_ERROR', 'AI 未能生成有效的题材说明', 500);

    // 4) 落库(内置题材也可覆盖 description/emotionMap)
    const updated = genreRepo.update(g.id, { description, emotionMap });
    ok(res, { description: updated.description, emotionMap: updated.emotionMap });
  } catch (e) {
    fail(res, 'ENRICH_FAILED', (e as Error).message || '题材说明补全失败', 500);
  }
});

export default router;
