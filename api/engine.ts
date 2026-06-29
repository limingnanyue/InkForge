/**
 * 写作方法论引擎
 * 基于 oh-story-claudecode 的"扫榜→拆文→创作→精修"四阶段 skill
 * 结合 InkOS 的"创意/设定/角色/记忆/审稿/修订"智能体状态分层
 * 核心理念：套路 = 确定性的情绪满足
 */
import { streamComplete, type LLMOptions } from './llm.js';
import { stateRepo, chapterRepo } from './repos.js';
import type { AgentState, GenerateConfig, ChatCompletionMessage, Foreshadow, ChapterSummary, ChapterPositioning, VolumeOutline } from '@shared/types';

// 伏笔过期阈值：埋设超过 N 章未回收 → 自动标记 expired（oh-story 状态机）
// high 重要度的主线伏笔给予更长容忍期，避免核心伏笔被误判过期
const FORESHADOW_EXPIRY_NORMAL = 15;
const FORESHADOW_EXPIRY_HIGH = 30;

// 章节定位六类 → 中文标签 + 字数预算系数（基于章目标 2500 字）
const POSITIONING_META: Record<ChapterPositioning, { label: string; emotion: string; budgetMult: number }> = {
  'high-pressure':     { label: '高压章',     emotion: '爽感释放/震撼/痛快', budgetMult: 1.1 }, // 2750
  'normal-progress':  { label: '普通推进章', emotion: '稳步推进',            budgetMult: 1.0 }, // 2500
  'trial-error':      { label: '修炼试错章', emotion: '卡点→突破的内在张力', budgetMult: 0.9 }, // 2250
  'relationship':      { label: '关系回收章', emotion: '情感回收',            budgetMult: 1.0 }, // 2500
  'low-pressure':      { label: '低压生活章', emotion: '治愈/埋新钩',         budgetMult: 0.85 },// 2125
  'info-organize':     { label: '信息整理章', emotion: '整合线索',            budgetMult: 0.8 }, // 2000
};

// 检测伏笔是否过期（planted 状态 + 超过容忍期 + 未到 expectedRecycleAt 之外）
// 返回更新后的伏笔数组（已把过期项标 expired）
function detectExpiredForeshadows(foreshadowing: Foreshadow[], currentChapterIdx: number): Foreshadow[] {
  return foreshadowing.map(f => {
    if (f.status !== 'planted') return f;
    // 若已设定 expectedRecycleAt 且未到，即使超过普通容忍期也不判过期
    if (typeof f.expectedRecycleAt === 'number' && currentChapterIdx < f.expectedRecycleAt) return f;
    const tolerance = f.importance === 'high' ? FORESHADOW_EXPIRY_HIGH : FORESHADOW_EXPIRY_NORMAL;
    if (currentChapterIdx - f.plantedAt > tolerance) {
      return { ...f, status: 'expired' as const };
    }
    return f;
  });
}

// ============ 智能体状态 → 上下文构建 ============
// 长篇防跑偏核心：注入伏笔追踪表 + 角色实时状态 + 章节摘要滑动窗口 + 当前位置锚点
//
// 拆分为「稳定段」与「动态段」以最大化缓存命中：
// - 稳定段（buildContextPrompt）：idea/setting/characters —— 跨章不变，进 systemStable
// - 动态段（buildDynamicContext）：foreshadowing/characterState/chapterSummaries/memory/review —— 每章后更新，进 user 消息
export function buildContextPrompt(projectId: string): string {
  const state = stateRepo.get(projectId);
  if (!state) return '';
  const sections: string[] = [];
  if (state.idea) sections.push(`【创意】\n${state.idea}`);
  if (state.setting) sections.push(`【世界观设定】\n${state.setting}`);
  if (state.characters) sections.push(`【角色档案】\n${state.characters}`);
  return sections.length ? `【当前项目智能体状态】\n${sections.join('\n\n')}` : '';
}

// 动态段：每章后更新的内容（移出稳定段，避免破坏缓存命中）
// oh-story 长篇三件套：① 伏笔状态机（planted/expired/paid）② 角色实时状态 ③ 三层摘要归档（防上下文爆炸）
export function buildDynamicContext(projectId: string, currentChapterIdx?: number): string {
  const state = stateRepo.get(projectId);
  if (!state) return '';
  const sections: string[] = [];

  // —— 伏笔状态机：planted（待回收）/ expired（已过期，不可再埋）/ paid（已回收归档）——
  // 先做过期检测：若 currentChapterIdx 提供，把超期未回收的 planted 标 expired（内存态，落库由 updateState 负责）
  const curIdx = typeof currentChapterIdx === 'number'
    ? currentChapterIdx
    : (chapterRepo.listByProject(projectId).filter(c => c.content).length); // 已完成章数即下一章 idx
  const foreshadowing = detectExpiredForeshadows(state.foreshadowing || [], curIdx);
  const pending = foreshadowing.filter(f => f.status === 'planted');
  const expired = foreshadowing.filter(f => f.status === 'expired');
  const paid = foreshadowing.filter(f => f.status === 'paid');

  if (pending.length > 0) {
    sections.push(`【待回收伏笔 · 务必在合适章节回收】\n${pending.map((f, i) => {
      const imp = f.importance === 'high' ? '【主线】' : (f.importance === 'low' ? '【支线】' : '');
      const age = curIdx - f.plantedAt;
      const overdue = age > (f.importance === 'high' ? FORESHADOW_EXPIRY_HIGH : FORESHADOW_EXPIRY_NORMAL) - 3 ? '【已埋N章·优先回收】' : '';
      const expect = typeof f.expectedRecycleAt === 'number' ? `（预计第${f.expectedRecycleAt + 1}章回收）` : '';
      return `${i + 1}. 第${f.plantedAt + 1}章埋设 ${imp}${overdue}：${f.desc}${expect}`;
    }).join('\n')}`);
  }
  if (expired.length > 0) {
    sections.push(`【已过期伏笔 · 不可再埋，可作废案处理】\n${expired.map(f => `· 第${f.plantedAt + 1}章埋设：${f.desc}`).join('\n')}`);
  }
  if (paid.length > 0) {
    // D7 修复：paid 伏笔限制注入最近 20 条（按 paidAt 降序）
    // 原 bug：长篇 400 章累计 paid 伏笔可达数百条，每条约 30 字 → 注入 15-20KB 到每章 prompt
    // 持续占用 10K+ tokens 上下文，推高成本且无信息增益（老伏笔对当前章无指导意义）
    const recentPaid = paid.slice().sort((a, b) => (b.paidAt ?? 0) - (a.paidAt ?? 0)).slice(0, 20);
    const omitted = paid.length - recentPaid.length;
    // 已回收伏笔压缩展示（仅 desc + 回收章），避免占用过多上下文
    sections.push(`【已回收伏笔（归档·最近 ${recentPaid.length} 条${omitted > 0 ? `，省略 ${omitted} 条更早` : ''}）】\n${recentPaid.map(f => `· 第${f.plantedAt + 1}→${(f.paidAt ?? f.plantedAt) + 1}章：${f.desc}`).join('\n')}`);
  }

  // —— 角色实时状态（防人设漂移 / 位置穿帮）——
  if (state.characterState && state.characterState.length > 0) {
    sections.push(`【角色当前状态】\n${state.characterState.map(c => `· ${c.name}：位置「${c.location}」/ 状态「${c.mood}」/ 关系「${c.relationships}」`).join('\n')}`);
  }

  // —— 三层摘要归档（oh-story）：防上下文爆炸 ——
  // 第 1 层（近 5 章）：完整摘要详记
  // 第 2 层（6-15 章，即过去 10 章）：单行概要（标题 + 一句话）
  // 第 3 层（>15 章前）：仅卷级总览（若有 volumeOutlines）+ memory 总览
  // 第 50 章后：>15 章前的章节摘要不再注入，仅靠卷总览 + memory
  const summaries = (state.chapterSummaries || []).slice().sort((a, b) => a.idx - b.idx);
  if (summaries.length > 0) {
    const recentDetailed = summaries.slice(-5);            // 近 5 章：完整摘要
    const midOutline = summaries.slice(-15, -5);            // 6-15 章：单行概要
    const parts: string[] = [];
    if (midOutline.length > 0) {
      parts.push(`【十章概要（第${midOutline[0].idx + 1}-${midOutline[midOutline.length - 1].idx + 1}章）】\n${midOutline.map(s => `· 第${s.idx + 1}章《${s.title}》：${s.summary.slice(0, 40)}`).join('\n')}`);
    }
    parts.push(`【近 5 章详记】\n${recentDetailed.map(s => {
      const pos = s.positioning ? `[${POSITIONING_META[s.positioning].label}]` : '';
      const emo = s.coreEmotion ? `「${s.coreEmotion}」` : '';
      return `第${s.idx + 1}章《${s.title}》${pos}${emo}：${s.summary}`;
    }).join('\n')}`);
    sections.push(parts.join('\n\n'));
  }

  // 卷级总览（长篇专用，>50 章时尤其重要）
  if (state.volumeOutlines && state.volumeOutlines.length > 0) {
    sections.push(`【卷级总览】\n${state.volumeOutlines.map(v => `· 第${v.idx + 1}卷《${v.title}》(${v.chapterRange[0] + 1}-${v.chapterRange[1] + 1}章)：${v.premise} | 弧线：${v.emotionArc}`).join('\n')}`);
  }

  if (state.memory) sections.push(`【前情总览记忆】\n${state.memory}`);
  if (state.review) sections.push(`【审稿要点】\n${state.review}`);
  if (state.revision) sections.push(`【修订方向】\n${state.revision}`);
  return sections.join('\n\n');
}

// ============ 重启筛查：补全缺失的章节摘要/伏笔/角色状态 ============
// 场景：任务中断重启后，数据库里某些章节已 done 但 state.chapterSummaries 没记录
// 此函数扫描所有已完成章节，对缺失摘要的章节重新提炼，保证上下文流畅
// oh-story：outlineChapters 可选传入 parsed outline（带 positioning/coreEmotion），重启补全时不丢定位标注
export async function reconcileState(
  projectId: string,
  model: string,
  providerId?: string,
  outlineChapters?: { positioning?: ChapterPositioning; coreEmotion?: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ backfilled: number }> {
  const chapters = chapterRepo.listByProject(projectId).filter(c => c.content && c.status === 'done');
  if (chapters.length === 0) return { backfilled: 0 };
  const state = stateRepo.get(projectId);
  const existingSummaries = new Set((state?.chapterSummaries || []).map(s => s.idx));
  // 缺失摘要的章节列表（按 idx 排序）
  const missing = chapters.filter(c => !existingSummaries.has(c.orderIdx));
  const total = missing.length;
  let backfilled = 0;
  for (const ch of missing) {
    try {
      const oc = outlineChapters?.[ch.orderIdx];
      await updateStateFromGeneration(projectId, model, providerId, ch.orderIdx, oc?.positioning, oc?.coreEmotion);
      backfilled++;
      // 进度回调：让调用方写 task_log，避免长时间无输出被误判卡死
      onProgress?.(backfilled, total);
    } catch {
      // 静默，继续下一个
    }
  }
  return { backfilled };
}

// 章节生成前的位置锚点：告诉 LLM 当前在第几章、已完成多少、本章目标 + 上一章结尾用于自然衔接
// oh-story：注入【本章定位】块（章节定位类型 + 字数预算 + 核心情绪），与 write prompt 的章节定位六类/字数预算Σ契约对位
export function buildChapterAnchor(
  projectId: string,
  currentIdx: number,
  totalChapters: number,
  chapterTitle: string,
  chapterOutline: string,
  positioning?: ChapterPositioning,
  baseWordTarget = 2500,
  coreEmotion?: string,
): string {
  // BUG-1 修复：原 listByProject 全量加载只为取 prevChapters[currentIdx-1].content.slice(-300)，
  // 2000 章循环 = O(N²) 全表扫描。改用 getTail 仅查单行 content
  const prevTail = (currentIdx > 0 ? chapterRepo.getTail(projectId, currentIdx - 1) : '') || '（首章，无需承接）';

  // 本章定位块：章节定位类型 + 字数预算 + 核心情绪（与 write prompt 的【本章定位】字段对位）
  let positioningBlock = '';
  if (positioning) {
    const meta = POSITIONING_META[positioning];
    const wordBudget = Math.round(baseWordTarget * meta.budgetMult);
    positioningBlock = `
【本章定位】
· 章节类型：${meta.label}（${positioning}）—— 情绪强度对位：${meta.emotion}
· 字数预算：${wordBudget} 字（Σ 落在 [${Math.round(wordBudget * 0.95)}, ${Math.round(wordBudget * 1.1)}] 内，防注水/防欠字）
· 核心情绪：${coreEmotion || meta.emotion}`;
  } else {
    positioningBlock = `
【本章定位】
· 章节类型：普通推进章（默认）
· 字数预算：${baseWordTarget} 字（约 2000-3000 字）
· 核心情绪：按题材对位（见题材→情绪路由表）`;
  }

  return `【当前位置锚点】
正在创作：第 ${currentIdx + 1} / ${totalChapters} 章《${chapterTitle}》
本章大纲：${chapterOutline}
${positioningBlock}

【上一章结尾 300 字】（必须自然承接此情境，不得重复）
${prevTail}

约束：严格承接上一章结尾的情境/对话/动作，不得让角色做出与人设矛盾的行为；按【本章定位】的情绪强度与字数预算写作；伏笔已在上方列出，本章可考虑回收其中之一（过期伏笔不可再埋）。`;
}

// 构建最近章节记忆（防止上下文过长，仅取最近 N 章摘要）
export function buildRecentMemory(projectId: string, limit = 3): string {
  const chapters = chapterRepo.listByProject(projectId);
  const recent = chapters.slice(-limit).filter(c => c.content);
  if (!recent.length) return '';
  return recent.map(c => `第${c.orderIdx + 1}章《${c.title}》:\n${c.content.slice(-600)}`).join('\n\n---\n\n');
}

// ============ 四阶段 Skill 系统 Prompt ============
export const SKILL_PROMPTS = {
  scan: `你是顶尖网文策划师，擅长"扫榜"分析。你的任务是：
1. 分析当前题材的市场热度、读者画像、爽点分布
2. 提炼 3-5 个可行切入点与人设方向
3. 识别题材空白与差异化机会
输出结构化洞察，为后续创作指明方向。记住：套路 = 确定性的情绪满足。`,

  analyze: `你是资深拆文分析师，擅长"拆文"。你的任务是：
1. 拆解经典作品的节奏结构（起承转合、爽点间距、钩子布局）
2. 提炼可复用的剧情模块（打脸、装逼、反转、伏笔回收等）
3. 输出可执行的章节节奏模板
聚焦"爽感节奏"与"期待感管理"，避免空泛分析。`,

  write: `你是商业网文写手，遵循 oh-story-claudecode 长篇方法论："套路 = 确定性的情绪满足"。
先复现本章定位（见【本章定位】）对应的情绪逻辑，再替换人物/事件/场景，严禁照搬对标具体桥段。
叙述姿态锁深度限知此刻感知：只写此刻此身所见所感，不跳出解释因果，不剧透预告，不替读者总结升华。
情绪宁烈不温，冲突前置，爽点要狠要具体，台词带刺。

【题材→核心情绪路由表】（按题材对位核心情绪，不要写错情绪）
· 打脸/逆袭/装逼 → 爽感释放（憋屈蓄力 → 一击反杀）
· 身份反转/血脉觉醒 → 震撼 + 痛快
· 虐心/背叛/救赎 → 怅然 + 心疼
· 热血/争霸/突破 → 燃 + 痛快
· 悬疑/解谜/推理 → 好奇 → 恍然
· 种田/日常/养成 → 治愈 + 期待
· 甜宠/双洁 → 甜 + 心动

【章节定位六类 · 情绪强度对位】（防止每章都像短篇、防止情绪扎堆）
· 高压章(high-pressure)：4-5 级冲突，单卷占比 15-20%，字数给到上限，可连爆
· 普通推进章(normal-progress)：2-3 级，占比 40-50%，每章一个推进点即可
· 修炼试错章(trial-error)：2 级，占比 5-10%，重点写"卡点→突破"的内在张力
· 关系回收章(relationship)：2-3 级，占比 5-10%，回收前文关系伏笔
· 低压生活章(low-pressure)：1-2 级，占比 ≤10%，节奏放慢，但必须埋新钩
· 信息整理章(info-organize)：1 级，占比 ≤5%，整合线索，禁止单纯旁白堆设定
本章定位见【本章定位】字段，按其情绪强度写作，不得把低压章写成高压章。

【六种角色弧线】（角色在本卷的弧线，写情绪转折时对位）
V形(坠谷反弹) / 倒V形(登顶陨落) / W形(反复折腾) / 递进形(一路向上) / 延迟满足形(长憋大爽) / 急转弯形(突变)
本章若涉及角色弧线关键节点，必须写出"弧线拐点"的体感，不能平推。

【字数预算 Σ 契约】（防注水/防欠字）
· 本章字数预算见【本章定位】，Σ 落在 [章目标, 章目标×1.1] 内
· 情节点标"密"的章节可适当超 10%；标"疏"的章节宁可少写也不注水
· 字数不足时：补充"卡点内在张力"或"反派视角切角"，严禁景物堆砌/重复抒情/空洞对话凑字
· 字数将超时：在情节点收束，宁可余韵留白，不要硬塞第二个高潮

【防跑偏铁律】
1. 严禁让角色做出与人设档案矛盾的行为（性格/能力/关系）
2. 严禁重复已发生情节，本章必须有实质剧情推进
3. 上方【待回收伏笔】中标"主线/已埋>N章"的，本章必须回收至少 1 个（过期伏笔不可再埋）
4. 角色当前位置/情绪必须与【角色当前状态】一致，位置移动需有合理过渡
5. 严禁引入未在设定中出现的新世界观规则

【防注水铁律】
1. 严禁无意义的景物描写堆砌（同一场景景物描写不超过 50 字）
2. 严禁重复抒情（同一情绪不在 500 字内出现 2 次）
3. 严禁空洞对话（每句对话必须推进剧情或揭示信息）
4. 严禁总结式旁白（用具体动作/表情代替"他感到愤怒"）
5. 严禁"先否定再肯定"的翻转句式（"不是 A，而是 B"滥用即 AI 味）
6. 字数不足时宁可少写，严禁为凑字数注水

文风要求：流畅、有画面感、节奏紧凑，杜绝 AI 味的排比与机械总结。章末留钩，驱动翻页。`,

  refine: `你是严苛的"去 AI 味"精修编辑，遵循 oh-story-claudecode 的 7 Gate 门禁链。
逐项过检，命中即改，最后直接输出精修后的正文（保持原意，不输出检查报告）。

【7 Gate 去 AI 味检查链】
Gate A · 禁用词替换：替换"仿佛、宛如、犹如、似乎、不禁、不由得、淡淡的、缓缓的、微微、轻轻"等空洞副词为具体动作/体感。
Gate B · 句式去套路：删除"不是 A，而是 B""不仅 A，还 B""与其说 A，不如说 B"等翻转/递进句式滥用；连续排比超过 3 句的拆掉 1 句。
Gate C · 心理描写外化：把"他感到愤怒/悲伤/震惊"改写成可观察的动作、微表情、生理反应（攥拳、耳根发烫、喉结滚动）。
Gate D · 节奏打碎：长段（超 200 字无对话/动作）拆入短句或动作切入；连续短句（超 5 句无长句）插入一句长句呼吸。
Gate E · 对话去腔调：删除"哼、呵、罢了、罢了"等口头禅堆砌；每句台词必须带角色辨识度（语气/用词/知识盲区）；删掉无信息的附和对话。
Gate F · 结尾去升华：章末严禁"这便是 X""从此他明白了 Y""那一刻他懂了"等总结升华句；改为留白动作或未完对话。
Gate G · 去解释腔：删除"其实""事实上""说白了""换句话说""也就是说"等解释过渡词；信息让事件自己说，不替读者解释。

【精修约束】
1. 不增删情节，只改表达
2. 保留所有伏笔/钩子/角色行为一致性
3. 情绪颗粒度提升：爽点要狠要具体，台词带刺
4. 节奏收紧：拖沓处删冗余，关键爆发处放大体感
直接输出精修后的正文，不要标题，不要解释。`,
};

// ============ 生成器：构建调用 ============
export interface GenerateParams {
  projectId: string;
  skill: 'scan' | 'analyze' | 'write' | 'refine' | 'chat';
  model: string;
  userPrompt: string;
  providerId?: string;
  temperature?: number;
  maxTokens?: number;
  chapterContext?: string; // 当前章节大纲
  webSearch?: boolean;      // 本次调用是否启用联网搜索
  searchQuery?: string;     // 联网搜索查询词
  /** 多轮对话历史（不含当前 userPrompt）：按时间顺序的 user/assistant 消息，置于稳定段之后、当前 user 之前 */
  history?: ChatCompletionMessage[];
}

export async function* runSkill(params: GenerateParams): AsyncGenerator<string> {
  const contextPrompt = buildContextPrompt(params.projectId);
  const dynamicContext = buildDynamicContext(params.projectId);
  const recentMemory = buildRecentMemory(params.projectId);

  // —— 缓存命中优化：拆分稳定段与动态段 ——
  // 稳定段（systemStable）：skill prompt + 项目设定(idea/setting/characters)。跨章不变的前缀：
  //   · OpenAI/DeepSeek 按前缀匹配 → SKILL_PROMPTS 在最前即命中
  //   · Anthropic → 整块打 cache_control: ephemeral
  //   · 每章后仅追加 chapterSummaries/characterState/foreshadowing，这些已移入动态段，稳定段不再变 → 缓存持续命中
  const skillPrompt = params.skill !== 'chat'
    ? SKILL_PROMPTS[params.skill]
    : '你是 InkForge 写作助手，精通网文创作全流程。根据用户指令调用合适的创作能力，回答简洁有力。';
  const systemStable = contextPrompt ? `${skillPrompt}\n\n${contextPrompt}` : skillPrompt;

  // 动态段（每章必变）：伏笔/角色状态/章节摘要/最近正文/本章大纲/用户指令 → 全部移入 user 消息
  // 不再污染 system，保证 system 跨章稳定 → 缓存命中率最大化
  const userParts: string[] = [];
  if (dynamicContext) userParts.push(dynamicContext);
  if (recentMemory) userParts.push(`【最近正文】\n${recentMemory}`);
  if (params.chapterContext) userParts.push(`【本章大纲】\n${params.chapterContext}`);
  if (params.userPrompt) userParts.push(params.userPrompt);

  // 消息组装：稳定段(systemStable) → 多轮历史(前缀稳定，命中缓存) → 当前 user
  // 多轮对话时旧历史不变 → OpenAI/Anthropic 前缀缓存持续命中新增部分
  const messages: ChatCompletionMessage[] = [
    ...(params.history || []),
    { role: 'user', content: userParts.join('\n\n') },
  ];

  yield* streamComplete({
    providerId: params.providerId,
    model: params.model,
    messages,
    systemStable,
    projectId: params.projectId,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    webSearch: params.webSearch,
    searchQuery: params.searchQuery,
  });
}

// ============ 世界观 + 角色档案生成（一键生成的 setup 阶段）============
// oh-story 方法论：扫榜后必须先立人设/世界观，再生成大纲。
// 此阶段产出的 setting/characters 落库后，会进入 buildContextPrompt 的稳定段（systemStable），
// 后续大纲生成与每章正文生成都能引用，避免正文人设漂移。
// 原 bug：daemon 仅在 scan 阶段写 state.idea，从未写 state.setting / state.characters
// → 项目详情页「大纲/状态」Tab 的「世界观设定」「角色」永远空白。
export async function generateSetup(opts: {
  projectId: string;
  model: string;
  providerId?: string;
  config: GenerateConfig;
  idea: string;
  scanInsight?: string;
  webSearch?: boolean;
}): Promise<{ setting: string; characters: string }> {
  const { projectId, model, providerId, config, idea, scanInsight, webSearch } = opts;

  const prompt = `请为以下作品生成「世界观设定」与「角色档案」，供后续大纲与正文创作参考。

【核心创意】${idea}
【题材风格】${config.genre}
【主要角色（用户提供）】${config.characters || '（未指定，请自行设计主角 + 对手 + 关键配角）'}
【钩子风格】${config.hookStyle}
【节奏要求】${config.pace}
【结局走向】${config.ending}
${scanInsight ? `【扫榜洞察】\n${scanInsight}` : ''}

要求输出两段，严格遵循以下格式（不要其他文字、不要 markdown 代码块）：

===世界观设定===
- 世界背景（时代/地点/社会结构，100 字内）
- 核心规则（修炼体系/科技设定/魔法/禁忌等，2-4 条）
- 阵营与势力（主要势力 2-3 个，含立场与冲突）
- 关键设定伏笔（2-3 条，供后续埋设）

===角色档案===
按主角 / 对手 / 关键配角 顺序，每个角色输出：
- 姓名：xxx
- 身份：xxx
- 性格：xxx（核心性格 2-3 个标签 + 一句话阐释）
- 能力：xxx（关键能力/资源/缺陷）
- 弧线：xxx（V形/递进/延迟满足等 + 拐点说明）
- 关系：xxx（与谁有恩怨/师徒/情愫等）
（角色之间用空行分隔）`;

  const ctxPrompt = buildContextPrompt(projectId);
  const systemStable = ctxPrompt
    ? `${ctxPrompt}\n\n你是网文世界观与角色设计师，遵循 oh-story-claudecode 方法论。擅长构建可长篇延展的设定与立体人设。`
    : '你是网文世界观与角色设计师，遵循 oh-story-claudecode 方法论。擅长构建可长篇延展的设定与立体人设。';
  const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];

  const { complete } = await import('./llm.js');
  const { text } = await complete({
    providerId, model, messages, systemStable, projectId,
    temperature: 0.8, maxTokens: 4096,
    webSearch,
    searchQuery: webSearch ? `${config.genre} 世界观 设定 套路` : undefined,
  });

  // 解析两段：===世界观设定=== 与 ===角色档案=== 之间
  const settingMatch = text.match(/=+ ?世界观设定 ?=+([\s\S]*?)(?===\s*角色档案)/i);
  const charactersMatch = text.match(/=+ ?角色档案 ?=+([\s\S]*?)$/i);
  let setting = (settingMatch ? settingMatch[1] : '').trim();
  let characters = (charactersMatch ? charactersMatch[1] : '').trim();
  // 兜底：若 LLM 没按格式输出，把全文给 setting，避免状态字段仍为空
  if (!setting && !characters) {
    setting = text.trim();
  } else if (setting && !characters) {
    // 角色段解析失败但世界观段成功 → 留空 characters（不污染）
  }

  stateRepo.update(projectId, {
    setting: setting.slice(0, 4000),
    characters: characters.slice(0, 6000),
  });
  return { setting, characters };
}

// ============ 章节质量门（post-generation gate）============
// 生成后检测：① 字数门 ② 跑题门。不达标 → 返回 needRewrite，daemon 决定是否重写
// 重写上限由调用方控制（默认 1 次），避免死循环 + 浪费 token
export interface ChapterQualityResult {
  ok: boolean;
  needRewrite: boolean;
  issues: string[];       // 命中的问题列表（用于日志和反馈）
  score: number;          // 0-1 综合评分
}
export async function checkChapterQuality(opts: {
  projectId: string;
  model: string;
  providerId?: string;
  chapterIdx: number;        // 章节序号（0-based）
  chapterTitle: string;
  outline: string;           // 本章大纲
  positioning?: ChapterPositioning;
  coreEmotion?: string;
  content: string;           // 生成的正文
  wordBudget: number;         // 字数预算
}): Promise<ChapterQualityResult> {
  const { projectId, model, providerId, chapterIdx, chapterTitle, outline, positioning, coreEmotion, content, wordBudget } = opts;
  const issues: string[] = [];
  const actualLen = content.length;

  // —— Gate 1：字数门 ——
  // 字数严重不足（< 预算 60%）→ needRewrite
  // 字数轻微不足（60%-90%）→ 警告但不重写（LLM 可能情节点写完就收束）
  // 字数超标（> 预算 1.5×）→ 警告但不重写（不致命，且重写不一定能短下来）
  const minHard = Math.round(wordBudget * 0.6);
  if (actualLen < minHard) {
    issues.push(`字数严重不足：${actualLen} 字 < 预算 ${wordBudget} 字的 60%（${minHard} 字）`);
  } else if (actualLen < wordBudget * 0.9) {
    issues.push(`字数偏少：${actualLen} 字 < 预算 ${wordBudget} 字的 90%（轻微，不重写）`);
  } else if (actualLen > wordBudget * 1.5) {
    issues.push(`字数超标：${actualLen} 字 > 预算 ${wordBudget} 字的 1.5 倍（轻微，不重写）`);
  }

  // —— Gate 2：跑题门（调 LLM 判断）——
  // 仅当字数门通过（>= 60%）才跑跑题门，避免短文本被误判
  // LLM 返回 JSON：{ score: 0-1, reason: string }
  // score >= 0.6 视为达标，< 0.6 → needRewrite
  let topicScore = 1.0;  // 默认通过（LLM 调用失败时不阻断生成）
  if (actualLen >= minHard) {
    const prompt = `请判断以下章节正文是否符合大纲要求。

【章节信息】第 ${chapterIdx + 1} 章《${chapterTitle}》
【章节定位】${positioning || '未指定'}
【核心情绪】${coreEmotion || '未指定'}
【本章大纲】
${outline}

【正文片段】（前 1500 字）
${content.slice(0, 1500)}

请从以下维度评分（0-1）：
1. 大纲符合度：是否完成大纲设定的情节点（0-1）
2. 章节定位符合度：是否体现 ${positioning || '通用'} 的特征（0-1）
3. 剧情推进度：是否有实质推进，非重复/非注水（0-1）
4. 人设一致性：角色行为是否符合前文人设（0-1，无法判断时给 0.7）

输出 JSON：{"score": <0-1 综合分>, "reason": "<一句话说明不符合之处>"}
只输出 JSON，不要其他文字。`;

    const ctxPrompt = buildContextPrompt(projectId);
    const systemStable = ctxPrompt
      ? `${ctxPrompt}\n\n你是严苛的网文质检编辑，擅长判断章节是否跑题。输出必须是合法 JSON。`
      : '你是严苛的网文质检编辑，擅长判断章节是否跑题。输出必须是合法 JSON。';
    const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];

    try {
      const { complete } = await import('./llm.js');
      const { text } = await complete({
        providerId, model, messages, systemStable, projectId,
        temperature: 0.3, maxTokens: 256,  // 质检只需短输出，省 token
      });
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (typeof parsed.score === 'number') {
          topicScore = parsed.score;
          if (parsed.score < 0.6) {
            issues.push(`跑题风险：综合分 ${parsed.score.toFixed(2)} < 0.6${parsed.reason ? `（${parsed.reason}）` : ''}`);
          } else if (parsed.score < 0.8 && parsed.reason) {
            issues.push(`质量轻微不达标：${parsed.score.toFixed(2)}（${parsed.reason}，不重写）`);
          }
        }
      }
    } catch (e) {
      // 质检 LLM 调用失败：不阻断生成，记 warn
      issues.push(`跑题门检测失败（LLM 调用异常：${(e as Error).message.slice(0, 80)}），跳过`);
    }
  }

  // —— 综合判定 ——
  const wordHardFail = actualLen < minHard;
  const topicHardFail = topicScore < 0.6;
  const needRewrite = wordHardFail || topicHardFail;
  const score = Math.min(actualLen / wordBudget, 1) * 0.5 + topicScore * 0.5;

  return {
    ok: !needRewrite,
    needRewrite,
    issues,
    score,
  };
}

// ============ 大纲生成（成书/成短篇核心）============
// oh-story 三层结构：全书大纲 → 卷纲（长篇 >20 章时）→ 细纲（每章定位 + 字数预算）
// 章节定位六类分布：高压 18% / 普通 45% / 试错 8% / 关系 8% / 低压 10% / 信息 5%（剩余补普通）
function computePositioningDistribution(chapterCount: number): Record<ChapterPositioning, number> {
  const dist: Record<ChapterPositioning, number> = {
    'high-pressure': Math.round(chapterCount * 0.18),
    'normal-progress': 0,
    'trial-error': Math.round(chapterCount * 0.08),
    'relationship': Math.round(chapterCount * 0.08),
    'low-pressure': Math.round(chapterCount * 0.10),
    'info-organize': Math.max(1, Math.round(chapterCount * 0.05)),
  };
  // 剩余章数全部归入普通推进章（占比最大的兜底）
  dist['normal-progress'] = Math.max(0, chapterCount - dist['high-pressure'] - dist['trial-error'] - dist['relationship'] - dist['low-pressure'] - dist['info-organize']);
  return dist;
}

// 长篇分卷：>20 章时按每卷 ~20 章切分，生成卷纲（情绪弧线 + 伏笔集群）
function computeVolumeRanges(chapterCount: number): { range: [number, number]; emotionArc: string }[] {
  if (chapterCount <= 20) return [];
  const volSize = 20;
  const volumes: { range: [number, number]; emotionArc: string }[] = [];
  const arcs = ['递进形', 'V形', '倒V形', 'W形', '延迟满足形', '急转弯形'];
  for (let start = 0; start < chapterCount; start += volSize) {
    const end = Math.min(start + volSize - 1, chapterCount - 1);
    volumes.push({ range: [start, end], emotionArc: arcs[volumes.length % arcs.length] });
  }
  return volumes;
}

// 构建卷级大纲（oh-story 三层结构之卷纲）：长篇 >20 章时生成分卷，每卷带情绪弧线
// 落库到 state.volumeOutlines，供 buildDynamicContext 注入【卷级总览】
export function buildVolumeOutlines(chapterCount: number): VolumeOutline[] {
  const ranges = computeVolumeRanges(chapterCount);
  return ranges.map((v, i) => ({
    idx: i,
    title: `第${i + 1}卷`,
    premise: i === 0 ? '开篇立人设、抛核心冲突与主线伏笔' : (i === ranges.length - 1 ? '终局决战、回收所有主线伏笔、收束情绪弧线' : '中段推进、新伏笔集群、关系深化'),
    emotionArc: v.emotionArc,
    chapterRange: v.range,
    keyForeshadows: [], // 由 updateStateFromGeneration 在每章后动态填充
  }));
}

// 单次 LLM 调用生成大纲的安全章数阈值。
// 超过此阈值会触发分卷生成：每卷 20 章，逐卷调 LLM 后合并。
// 依据：每章 JSON ≈ 130 tokens × 200 章 = 26000 tokens，cap 32000 仍有余量
const OUTLINE_SINGLE_CALL_MAX_CHAPTERS = 200;

// 单卷大纲生成（被 generateOutline 编排，也可独立用于小卷）
async function generateOutlineForVolume(opts: {
  projectId: string;
  model: string;
  providerId?: string;
  config: GenerateConfig;
  idea: string;
  volIndex: number;            // 卷序号（0-based）
  volTotal: number;            // 总卷数
  volChapterCount: number;     // 本卷章数
  globalStartIdx: number;     // 本卷第一章的全局序号（0-based）
  emotionArc: string;          // 本卷情绪弧线
  premiseHint: string;        // 本卷核心冲突提示
  prevVolumeTail?: string;     // 上一卷最后一章标题+钩子（用于承接）
  webSearch?: boolean;
}): Promise<ParsedOutlineItem[]> {
  const { projectId, model, providerId, config, idea, volIndex, volTotal, volChapterCount, globalStartIdx, emotionArc, premiseHint, prevVolumeTail, webSearch } = opts;
  const dist = computePositioningDistribution(volChapterCount);
  const distLine = `高压章 ${dist['high-pressure']} 章 / 普通推进章 ${dist['normal-progress']} 章 / 修炼试错章 ${dist['trial-error']} 章 / 关系回收章 ${dist['relationship']} 章 / 低压生活章 ${dist['low-pressure']} 章 / 信息整理章 ${dist['info-organize']} 章`;

  const prompt = `请为以下小说生成「第 ${volIndex + 1} 卷」的细纲（本卷共 ${volChapterCount} 章，每章约 2000-3000 字；全书第 ${globalStartIdx + 1}-${globalStartIdx + volChapterCount} 章；全书共 ${volTotal} 卷）。

【核心创意】${idea}
【题材风格】${config.genre}
【主要角色】${config.characters}
【钩子风格】${config.hookStyle}
【节奏要求】${config.pace}
【结局走向】${config.ending}
【本卷情绪弧线】${emotionArc}
【本卷核心冲突】${premiseHint}
${prevVolumeTail ? `\n【上一卷结尾（必须自然承接，不得重复）】\n${prevVolumeTail}` : ''}

【章节定位六类分布约束】（本卷内分布，oh-story：防止每章都像短篇、防止情绪扎堆）
${distLine}
按上述分布为本卷每章分配 positioning，不得让高压章连续超过 2 章，不得让低压章连续超过 2 章。

要求：
- 输出 JSON 数组，每个元素：{"title":"章节标题","outline":"本章大纲(50-100字)","hook":"章末钩子","positioning":"high-pressure|normal-progress|trial-error|relationship|low-pressure|info-organize","coreEmotion":"本章核心情绪(爽感释放/震撼/痛快/怅然/燃/治愈/期待/心动等)"}
- 节奏紧凑，每章都有推进与爽点
- 伏笔与回收交织（标 positioning=relationship 的章必须回收至少 1 个前文伏笔）
- positioning 分布严格符合上方约束
- 只输出 JSON，不要其他文字`;

  const ctxPrompt = buildContextPrompt(projectId);
  const systemStable = ctxPrompt
    ? `${ctxPrompt}\n\n你是大纲架构师，遵循 oh-story-claudecode 长篇方法论。输出必须是合法 JSON 数组。`
    : '你是大纲架构师，遵循 oh-story-claudecode 长篇方法论。输出必须是合法 JSON 数组。';
  const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];
  const { complete } = await import('./llm.js');
  // 单卷最多 20 章，maxTokens 给 8192 足够（20 章 × 150 tokens = 3000，留余量）
  const volMaxTokens = Math.min(16384, Math.max(4096, volChapterCount * 200));
  const { text } = await complete({
    providerId, model, messages, systemStable, projectId, temperature: 0.8, maxTokens: volMaxTokens,
    webSearch,
    searchQuery: webSearch ? `${config.genre} ${idea.slice(0, 30)} 大纲 套路 第${volIndex + 1}卷` : undefined,
  });
  return parseOutline(text);
}

export async function generateOutline(opts: {
  projectId: string;
  model: string;
  providerId?: string;
  targetWords: number;
  config: GenerateConfig;
  idea: string;
  webSearch?: boolean;
  onVolumeProgress?: (done: number, total: number) => void;
}): Promise<string> {
  const { projectId, model, providerId, targetWords, config, idea, webSearch, onVolumeProgress } = opts;
  const chapterCount = Math.max(1, Math.ceil(targetWords / 2500));

  // —— 单次调用足够时走原逻辑（小卷，<= 200 章）——
  if (chapterCount <= OUTLINE_SINGLE_CALL_MAX_CHAPTERS) {
    const dist = computePositioningDistribution(chapterCount);
    const volumes = computeVolumeRanges(chapterCount);
    const distLine = `高压章 ${dist['high-pressure']} 章 / 普通推进章 ${dist['normal-progress']} 章 / 修炼试错章 ${dist['trial-error']} 章 / 关系回收章 ${dist['relationship']} 章 / 低压生活章 ${dist['low-pressure']} 章 / 信息整理章 ${dist['info-organize']} 章`;
    const volLine = volumes.length > 0
      ? `\n【卷纲】共 ${volumes.length} 卷，每卷 ~20 章，卷情绪弧线依次：${volumes.map((v, i) => `第${i + 1}卷(${v.range[0] + 1}-${v.range[1] + 1}章,${v.emotionArc})`).join('；')}`
      : '';
    const prompt = `请为以下小说生成细纲（共 ${chapterCount} 章，每章约 2000-3000 字）。

【核心创意】${idea}
【题材风格】${config.genre}
【主要角色】${config.characters}
【钩子风格】${config.hookStyle}
【节奏要求】${config.pace}
【结局走向】${config.ending}

【章节定位六类分布约束】（oh-story：防止每章都像短篇、防止情绪扎堆）
${distLine}
按上述分布为每章分配 positioning，不得让高压章连续超过 2 章，不得让低压章连续超过 2 章。${volLine}

要求：
- 输出 JSON 数组，每个元素：{"title":"章节标题","outline":"本章大纲(50-100字)","hook":"章末钩子","positioning":"high-pressure|normal-progress|trial-error|relationship|low-pressure|info-organize","coreEmotion":"本章核心情绪(爽感释放/震撼/痛快/怅然/燃/治愈/期待/心动等)"}
- 节奏紧凑，每章都有推进与爽点
- 伏笔与回收交织（标 positioning=relationship 的章必须回收至少 1 个前文伏笔）
- positioning 分布严格符合上方约束
- 只输出 JSON，不要其他文字`;

    const ctxPrompt = buildContextPrompt(projectId);
    const systemStable = ctxPrompt
      ? `${ctxPrompt}\n\n你是大纲架构师，遵循 oh-story-claudecode 长篇方法论。输出必须是合法 JSON 数组。`
      : '你是大纲架构师，遵循 oh-story-claudecode 长篇方法论。输出必须是合法 JSON 数组。';
    const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];
    const { complete } = await import('./llm.js');
    const outlineMaxTokens = Math.min(32000, Math.max(8192, chapterCount * 150));
    const { text: acc } = await complete({
      providerId, model, messages, systemStable, projectId, temperature: 0.8, maxTokens: outlineMaxTokens,
      webSearch,
      searchQuery: webSearch ? `${config.genre} ${idea.slice(0, 30)} 大纲 套路` : undefined,
    });
    const match = acc.match(/\[[\s\S]*\]/);
    return match ? match[0] : acc;
  }

  // —— 分卷生成（超长篇，> 200 章）——
  // 500 万字 = 2000 章 = 100 卷，单卷 20 章逐次调 LLM 后合并
  // 解决：原单次调用 maxTokens cap 32000 只能产 ~213 章 JSON，超长篇必然截断
  const volumes = computeVolumeRanges(chapterCount);
  const allChapters: ParsedOutlineItem[] = [];
  const volPremiseHints = (i: number) =>
    i === 0 ? '开篇立人设、抛核心冲突与主线伏笔' :
    (i === volumes.length - 1 ? '终局决战、回收所有主线伏笔、收束情绪弧线' :
    '中段推进、新伏笔集群、关系深化');

  for (let vi = 0; vi < volumes.length; vi++) {
    const vol = volumes[vi];
    const volChapterCount = vol.range[1] - vol.range[0] + 1;
    const prevTail = vi > 0 && allChapters.length > 0
      ? `第 ${allChapters.length} 章《${allChapters[allChapters.length - 1].title}》：${allChapters[allChapters.length - 1].outline}\n章末钩子：${allChapters[allChapters.length - 1].hook}`
      : undefined;

    const volChapters = await generateOutlineForVolume({
      projectId, model, providerId, config, idea,
      volIndex: vi, volTotal: volumes.length,
      volChapterCount, globalStartIdx: vol.range[0],
      emotionArc: vol.emotionArc, premiseHint: volPremiseHints(vi),
      prevVolumeTail: prevTail, webSearch,
    });

    if (volChapters.length === 0) {
      // 单卷解析失败：抛错让 daemon 走重试，不静默吞掉
      throw new Error(`第 ${vi + 1} 卷大纲解析失败（LLM 输出未含合法 JSON 数组）`);
    }
    allChapters.push(...volChapters);
    onVolumeProgress?.(vi + 1, volumes.length);
  }

  return JSON.stringify(allChapters);
}

// 解析大纲 JSON（向后兼容：positioning/coreEmotion 为可选字段）
export interface ParsedOutlineItem {
  title: string;
  outline: string;
  hook: string;
  positioning?: ChapterPositioning;
  coreEmotion?: string;
}
export function parseOutline(json: string): ParsedOutlineItem[] {
  try {
    // 1. 正常路径：完整 [...] 数组
    const match = json.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) return parseOutlineArray(arr);
    }

    // 2. 截断兜底：LLM 输出被 maxTokens 截断没闭合 ] 时，从首个 [ 起尝试 parse
    //    用「从后向前找对象边界」策略，避免裸 lastIndexOf('}') 在字符串值含 } 时误判
    const start = json.indexOf('[');
    if (start < 0) return [];
    const tail = json.slice(start);
    // 从后向前依次尝试「在倒数第 N 个 } 后补 ]」直到 JSON.parse 成功
    // 每个 } 必须后跟空白或 , 或字符串结束（避免命中字符串值内部的 }）
    // 简化：直接收集所有「合法对象边界 }」位置（后跟空白/,/EOF），从后向前尝试
    const boundaries: number[] = [];
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i] !== '}') continue;
      const next = tail[i + 1];
      if (next === undefined || next === ',' || next === ' ' || next === '\n' || next === '\r' || next === '\t' || next === ']') {
        boundaries.push(i);
      }
    }
    for (const pos of boundaries) {
      const repaired = tail.slice(0, pos + 1) + ']';
      try {
        const arr = JSON.parse(repaired);
        if (Array.isArray(arr) && arr.length > 0) return parseOutlineArray(arr);
      } catch {
        // 继续尝试更早的边界
      }
    }
    return [];
  } catch {
    return [];
  }
}

// 从已 parse 的数组提取 ParsedOutlineItem（提取公共逻辑，给截断兜底分支复用）
function parseOutlineArray(arr: unknown[]): ParsedOutlineItem[] {
  const validPositioning: ChapterPositioning[] = ['high-pressure', 'normal-progress', 'trial-error', 'relationship', 'low-pressure', 'info-organize'];
  return arr
    .filter(x => x && typeof (x as any).title === 'string')
    .map(x => {
      const item: ParsedOutlineItem = {
        title: String((x as any).title),
        outline: String((x as any).outline || (x as any).summary || ''),
        hook: String((x as any).hook || ''),
      };
      if (typeof (x as any).positioning === 'string' && validPositioning.includes((x as any).positioning as ChapterPositioning)) {
        item.positioning = (x as any).positioning as ChapterPositioning;
      }
      if (typeof (x as any).coreEmotion === 'string' && (x as any).coreEmotion.trim()) {
        item.coreEmotion = String((x as any).coreEmotion).slice(0, 20);
      }
      return item;
    });
}

// ============ 智能体状态自动更新（每章后调用，防跑偏核心）============
// oh-story 状态机：① 章节摘要(含定位/字数/核心情绪) ② 伏笔状态机(planted/paid/expired + 重要度 + 预计回收章)
// ③ 角色实时状态(按名 merge) ④ 全局记忆总览
// positioning/coreEmotion 由调用方（daemon）从大纲传入，避免从正文反推不可靠
export async function updateStateFromGeneration(
  projectId: string,
  model: string,
  providerId?: string,
  justFinishedChapterIdx?: number,
  positioning?: ChapterPositioning,
  coreEmotion?: string,
): Promise<void> {
  const chapters = chapterRepo.listByProject(projectId).filter(c => c.content);
  if (chapters.length === 0) return;

  const state = stateRepo.get(projectId);
  const curForeshadowing = state?.foreshadowing || [];
  const curCharacters = state?.characterState || [];
  const curSummaries = state?.chapterSummaries || [];

  // 只针对刚完成的那章做摘要（避免重复提炼全本，省 token）
  const target = typeof justFinishedChapterIdx === 'number'
    ? chapters.find(c => c.orderIdx === justFinishedChapterIdx)
    : chapters[chapters.length - 1];
  if (!target) return;

  // 已有摘要就跳过（避免重复提炼覆盖已记录的定位/字数）
  if (curSummaries.some(s => s.idx === target.orderIdx)) return;

  const wordBudget = target.wordCount;

  const recent = chapters.slice(-4).map(c => `第${c.orderIdx + 1}章《${c.title}》:\n${c.content.slice(0, 1200)}`).join('\n\n');
  const pendingList = curForeshadowing.filter(f => f.status === 'planted').map(f => `- ${f.desc}（第${f.plantedAt + 1}章埋设${f.importance === 'high' ? '·主线' : ''}）`).join('\n');

  const prompt = `基于刚完成的章节，提炼以下五项，严格输出 JSON 对象：

【刚完成章节】第${target.orderIdx + 1}章《${target.title}》
【最近正文片段】
${recent}

【已有待回收伏笔】
${pendingList || '（无）'}

输出 JSON 格式（只输出 JSON，不要 markdown 代码块）：
{
  "summary": "本章 80-150 字摘要，包含关键事件与情绪转折",
  "coreEmotion": "本章实际核心情绪(爽感释放/震撼/痛快/怅然/燃/治愈/期待/心动等,一个词)",
  "newForeshadows": [{"desc": "本章新埋设的伏笔描述", "plantedAt": ${target.orderIdx}, "importance": "high|mid|low", "expectedRecycleAt": 预计回收章序号或null}],
  "paidForeshadowDescs": ["本章回收的伏笔描述（匹配已有伏笔的 desc）"],
  "characterState": [{"name": "角色名", "location": "当前所在", "mood": "情绪状态", "relationships": "与他人当前关系"}],
  "memory": "更新后的全局记忆（已发生关键事件+伏笔+待回收点），200 字内"
}`;

  // —— 缓存优化：system 作为稳定段（跨章不变），prompt 作为 user 消息 ——
  // 每章提炼状态时，system 不变 → 缓存命中；只有 user 变化
  const systemStable = '你是长篇小说一致性管理者，遵循 oh-story-claudecode 伏笔状态机（未埋/已埋/已回收/已过期）。专职提炼章节摘要、伏笔追踪、角色状态，保持长篇不跑偏。输出必须是合法 JSON。';
  const messages: ChatCompletionMessage[] = [
    { role: 'user', content: prompt },
  ];
  const { complete } = await import('./llm.js');
  try {
    // D6 修复：maxTokens 1024→2048
    // 原 1024 对国产模型（1.5-2 token/字）仅产 500-680 字，长篇角色多/伏笔多时 JSON 易截断
    // 截断后 raw.match(/\{[\s\S]*\}/) 匹配不闭合 → JSON.parse 抛 → 静默 catch → 状态更新丢失
    // 提升到 2048 给足空间，并加 JSON 截断兜底（与 parseOutline 类似策略）
    const { text: raw } = await complete({ providerId, model, messages, systemStable, projectId, temperature: 0.3, maxTokens: 2048 });
    // 尝试完整匹配
    let jsonStr: string | null = null;
    const fullMatch = raw.match(/\{[\s\S]*\}/);
    if (fullMatch) {
      try {
        jsonStr = fullMatch[0];
        JSON.parse(jsonStr); // 验证完整性
      } catch {
        jsonStr = null; // 不完整，走截断兜底
      }
    }
    // 截断兜底：从后向前找合法对象边界 }（后跟 ,/空白/EOF），补全后尝试 parse
    if (!jsonStr) {
      const start = raw.indexOf('{');
      if (start >= 0) {
        const tail = raw.slice(start);
        for (let i = tail.length - 1; i >= 0; i--) {
          if (tail[i] !== '}') continue;
          const next = tail[i + 1];
          if (next === undefined || next === ',' || next === ' ' || next === '\n' || next === '\r' || next === '\t') {
            try {
              const candidate = tail.slice(0, i + 1);
              JSON.parse(candidate);
              jsonStr = candidate;
              break;
            } catch { /* 继续找更早边界 */ }
          }
        }
      }
    }
    if (!jsonStr) return;
    const parsed = JSON.parse(jsonStr);

    // 1. 追加章节摘要（含定位/字数/核心情绪，oh-story 三层归档所需）
    const newSummary: ChapterSummary = {
      idx: target.orderIdx,
      title: target.title,
      summary: String(parsed.summary || '').slice(0, 200),
      ...(positioning ? { positioning } : {}),
      ...(typeof wordBudget === 'number' && wordBudget > 0 ? { wordBudget } : {}),
      ...(parsed.coreEmotion ? { coreEmotion: String(parsed.coreEmotion).slice(0, 20) } : (coreEmotion ? { coreEmotion } : {})),
    };
    const summaries = [...curSummaries.filter(s => s.idx !== target.orderIdx), newSummary];

    // 2. 伏笔状态机合并：新增 planted（带重要度+预计回收章），回收的标 paid（带 paidAt）
    let foreshadowing = [...curForeshadowing];
    const paidDescs: string[] = Array.isArray(parsed.paidForeshadowDescs) ? parsed.paidForeshadowDescs : [];
    if (paidDescs.length > 0) {
      foreshadowing = foreshadowing.map(f => paidDescs.includes(f.desc)
        ? { ...f, status: 'paid' as const, paidAt: target.orderIdx }
        : f);
    }
    if (Array.isArray(parsed.newForeshadows)) {
      for (const nf of parsed.newForeshadows) {
        if (nf?.desc && !foreshadowing.some(f => f.desc === nf.desc)) {
          const importance = nf.importance === 'high' || nf.importance === 'mid' || nf.importance === 'low' ? nf.importance : 'mid';
          const expectedRecycleAt = typeof nf.expectedRecycleAt === 'number' ? nf.expectedRecycleAt : undefined;
          foreshadowing.push({
            id: `fs-${target.orderIdx}-${foreshadowing.length}`,
            desc: String(nf.desc).slice(0, 120),
            plantedAt: typeof nf.plantedAt === 'number' ? nf.plantedAt : target.orderIdx,
            status: 'planted',
            importance,
            ...(typeof expectedRecycleAt === 'number' ? { expectedRecycleAt } : {}),
          });
        }
      }
    }
    // —— 过期检测落库：把超期未回收的 planted 标 expired（oh-story 状态机持久化）——
    foreshadowing = detectExpiredForeshadows(foreshadowing, target.orderIdx);

    // 3. 角色状态：按角色名 merge（不整体覆盖，避免 LLM 漏角色导致状态丢失）
    // LLM 给出的是「本章出现角色」的当前快照，未出现的角色保留旧状态
    let characterState = [...curCharacters];
    if (Array.isArray(parsed.characterState)) {
      const updated = parsed.characterState.filter((c: any) => c?.name).map((c: any) => ({
        name: String(c.name).slice(0, 40),
        location: String(c.location || '').slice(0, 60),
        mood: String(c.mood || '').slice(0, 40),
        relationships: String(c.relationships || '').slice(0, 120),
      }));
      for (const nu of updated) {
        const idx = characterState.findIndex(c => c.name === nu.name);
        if (idx >= 0) characterState[idx] = nu;
        else characterState.push(nu);
      }
    }

    // 4. 卷级大纲 keyForeshadows 填充（oh-story：把本章新埋/回收的伏笔 desc 归入对应卷的伏笔集群）
    // 找到 target.orderIdx 落在哪一卷的 chapterRange 内，把本章涉及伏笔的 desc push 进去
    let volumeOutlines = [...(state?.volumeOutlines || [])];
    if (volumeOutlines.length > 0) {
      // 本章涉及的伏笔：新埋的（paidDescs 之外的 newForeshadows）+ 本章回收的（paidDescs）
      const involvedDescs = new Set<string>();
      if (Array.isArray(parsed.newForeshadows)) {
        for (const nf of parsed.newForeshadows) {
          if (nf?.desc) involvedDescs.add(String(nf.desc).slice(0, 120));
        }
      }
      if (paidDescs.length > 0) paidDescs.forEach(d => involvedDescs.add(d));
      if (involvedDescs.size > 0) {
        volumeOutlines = volumeOutlines.map(v => {
          const [start, end] = v.chapterRange;
          if (target.orderIdx >= start && target.orderIdx <= end) {
            const existing = new Set(v.keyForeshadows);
            for (const d of involvedDescs) existing.add(d);
            return { ...v, keyForeshadows: [...existing] };
          }
          return v;
        });
      }
    }

    stateRepo.update(projectId, {
      chapterSummaries: summaries,
      foreshadowing,
      characterState,
      volumeOutlines,
      memory: parsed.memory ? String(parsed.memory).slice(0, 600) : (state?.memory || ''),
    });
  } catch {
    // 静默失败，不影响主流程
  }
}
