/**
 * 写作方法论引擎
 * 基于 oh-story-claudecode 的"扫榜→拆文→创作→精修"四阶段 skill
 * 结合 InkOS 的"创意/设定/角色/记忆/审稿/修订"智能体状态分层
 * 核心理念：套路 = 确定性的情绪满足
 */
import { streamComplete, type LLMOptions } from './llm.js';
import { stateRepo, chapterRepo, genreRepo, projectRepo, providerRepo } from './repos.js';
import type { AgentState, GenerateConfig, ChatCompletionMessage, Foreshadow, CharacterState, ChapterSummary, ChapterPositioning, VolumeOutline, ChapterMemo, ProviderKind, EmotionBeat, ConflictLine } from '@shared/types';
import { getToneInstruction, getToneDensity, getToneDensityHint } from '@shared/tone-presets';

// 题材元信息注入: 反查 genreId 拿 description + emotionMap,拼成 prompt 段
// 原实现: 主线生成只用 config.genre(label),题材说明/情绪映射完全未注入,LLM 写作风格缺少题材特征引导
// 现改进: 世界观/分卷大纲/全书大纲 3 处 prompt 都注入题材元信息,让生成更有题材针对性

// M1 修复(第十七轮): 滑动窗口大纲 JSON.parse 失败 warn 去重 Set
// 避免每章 render 都打 warn 刷屏,每个 projectId 仅打一次
const _outlineParseWarnedProjectIds = new Set<string>();

function buildGenreHint(config: GenerateConfig): string {
  if (!config.genreId) return '';
  const g = genreRepo.get(config.genreId);
  if (!g) return '';
  const parts: string[] = [];
  if (g.description) parts.push(`题材说明：${g.description}`);
  if (g.emotionMap) parts.push(`核心情绪：${g.emotionMap}`);
  return parts.length ? `\n【题材元信息】\n${parts.join('\n')}` : '';
}

// 文风指令注入(第二十七轮新增): 原 config.tone 只透传不消费,选什么文风对生成结果零影响。
//   现: 在 setup/outline/write 三个核心 prompt 阶段注入【文风】段,含 tone label + instruction。
//   getToneInstruction 对未知 tone(如用户旧数据)降级返回正剧指令,保证向后兼容。
function buildToneHint(config: GenerateConfig): string {
  const tone = config.tone;
  if (!tone) return '';
  const instruction = getToneInstruction(tone);
  return `\n【文风】${tone}\n${instruction}`;
}

// 大纲 Σ 契约密疏点配比建议(根据 tone 的 emotionDensity 调整)
//   dense  → 密点×3 疏点×2(爽文/恶搞/甜宠/无限流/系统流)
//   normal → 密点×2 疏点×3(正剧/黑色幽默/虐恋/群像/悬疑)
//   sparse → 密点×1 疏点×4(慢热/治愈/年代文)
function buildToneDensityHint(config: GenerateConfig): string {
  const density = getToneDensity(config.tone);
  return getToneDensityHint(density);
}

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
export function buildContextPrompt(projectId: string, currentChapterIdx?: number): string {
  const state = stateRepo.get(projectId);
  if (!state) return '';
  const sections: string[] = [];
  if (state.idea) sections.push(`【创意】\n${state.idea}`);
  if (state.setting) sections.push(`【世界观设定】\n${state.setting}`);
  if (state.characters) sections.push(`【角色档案】\n${state.characters}`);
  // H1 修复(第十二轮): 注入全书大纲到稳定段,防长篇中段主线遗忘
  // H4 修复(第十五轮): 大纲改滑动窗口注入(当前章 ± 5 章 + 当前卷全章 + 其他卷 premise)
  //   原: 截断前 4000 字,200 章长篇丢 87% 大纲,后期章节看不到第 27 章后剧情规划
  //   现: 按当前章 idx 滑动窗口,稳定段只含与当前章相关的大纲片段,跨章稳定 + 后期不跑题
  //   无 currentChapterIdx 时降级到原截断策略(setup/scan 阶段调用)
  if (state.outline) {
    if (typeof currentChapterIdx === 'number' && state.volumeOutlines?.length) {
      // 滑动窗口: 当前卷全章 + 邻近 ± 5 章 + 其他卷 premise
      const curVol = state.volumeOutlines.find(v => currentChapterIdx >= v.chapterRange[0] && currentChapterIdx <= v.chapterRange[1]);
      if (curVol) {
        // 解析大纲 JSON 拿每章片段
        try {
          const items = JSON.parse(state.outline) as Array<{ title?: string; outline?: string; positioning?: string; coreEmotion?: string; hook?: string }>;
          const windowStart = Math.max(0, currentChapterIdx - 5);
          const windowEnd = Math.min(items.length, currentChapterIdx + 6);
          const nearby = items.slice(windowStart, windowEnd)
            .map((it, i) => `${windowStart + i + 1}. 《${it.title || ''}》${it.positioning ? `[${it.positioning}]` : ''}${it.coreEmotion ? `「${it.coreEmotion}」` : ''}: ${it.outline || ''}${it.hook ? `（钩子:${it.hook}）` : ''}`)
            .join('\n');
          const otherVols = state.volumeOutlines
            .filter(v => v.idx !== curVol.idx)
            .map(v => `· 第${v.idx + 1}卷《${v.title}》(${v.chapterRange[0] + 1}-${v.chapterRange[1] + 1}章): ${v.premise}（${v.emotionArc}）`)
            .join('\n');
          sections.push(`【全书大纲 · 滑动窗口(第${windowStart + 1}-${windowEnd}章详记 + 其他卷 premise)】\n当前卷(第${curVol.idx + 1}卷)详记:\n${nearby}\n\n其他卷概览:\n${otherVols}`);
        } catch (e) {
          // M1 修复(第十七轮): JSON 解析失败不再静默降级,打 console.warn 让滑动窗口失效可排查
          // 原: catch{} 完全无日志 → state.outline 非 JSON 时永久走截断,200 章长篇后期看不到第 27 章后剧情
          // 现: 打 warn 一次(按 projectId 去重避免刷屏),提示重新生成大纲
          if (!_outlineParseWarnedProjectIds.has(projectId)) {
            _outlineParseWarnedProjectIds.add(projectId);
            console.warn(`[buildContextPrompt] 项目 ${projectId} 的 outline 不是合法 JSON,滑动窗口注入失效,降级到截断前 4000 字。建议重新生成大纲。原始错误: ${(e as Error).message}`);
          }
          const outlineSnippet = state.outline.length > 4000 ? state.outline.slice(0, 4000) + '\n...(全书大纲节选)' : state.outline;
          sections.push(`【全书大纲主线】\n${outlineSnippet}`);
        }
      } else {
        const outlineSnippet = state.outline.length > 4000 ? state.outline.slice(0, 4000) + '\n...(全书大纲节选)' : state.outline;
        sections.push(`【全书大纲主线】\n${outlineSnippet}`);
      }
    } else {
      // 无 currentChapterIdx 或无 volumeOutlines: 降级到截断(setup/scan 阶段)
      const outlineSnippet = state.outline.length > 4000 ? state.outline.slice(0, 4000) + '\n...(全书大纲节选,完整大纲见 task.checkpoint)' : state.outline;
      sections.push(`【全书大纲主线】\n${outlineSnippet}`);
    }
  }
  // M2 修复(第十四轮): 注入题材元信息到稳定段,正文生成也能看到题材说明+情绪映射
  const project = projectRepo.get(projectId);
  if (project?.genreId) {
    const g = genreRepo.get(project.genreId);
    if (g) {
      const parts: string[] = [];
      if (g.description) parts.push(`题材说明：${g.description}`);
      if (g.emotionMap) parts.push(`核心情绪：${g.emotionMap}`);
      if (parts.length) sections.push(`【题材元信息】\n${parts.join('\n')}`);
    }
  }
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
      // 第二十六轮升级(伏笔状态机): expectedRecycleAt === 当前章 → 标【本章必须回收】硬提醒。
      //   原: 只有预计回收章的括号提示,LLM 不知"到章了"。现硬标红,LLM 必须本章兑现。
      const dueNow = typeof f.expectedRecycleAt === 'number' && f.expectedRecycleAt === curIdx ? '【本章必须回收·到期】' : '';
      const expect = typeof f.expectedRecycleAt === 'number' ? `（预计第${f.expectedRecycleAt + 1}章回收）` : '';
      return `${i + 1}. 第${f.plantedAt + 1}章埋设 ${imp}${overdue}${dueNow}：${f.desc}${expect}`;
    }).join('\n')}`);
  }
  // M2 修复(第十五轮): expired 伏笔限最近 10 条,防长篇后期 prompt 被撑爆
  // 原: expired 全量注入,400 章累积 50+ expired × 30 字 = 1500 字/章,且对当前章无指导意义
  //   expired「不可再埋,可作废案处理」,LLM 不需看到全部历史废案,只需最近的作参考
  // 现: 按 plantedAt 降序取最近 10 条,更早的归档到 memory
  if (expired.length > 0) {
    const recentExpired = expired.slice().sort((a, b) => b.plantedAt - a.plantedAt).slice(0, 10);
    const omittedExp = expired.length - recentExpired.length;
    sections.push(`【已过期伏笔 · 不可再埋${omittedExp > 0 ? `（最近 ${recentExpired.length} 条,省略 ${omittedExp} 条更早）` : ''}】\n${recentExpired.map(f => `· 第${f.plantedAt + 1}章埋设：${f.desc}`).join('\n')}`);
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
  // 第二十六轮重写(角色热度四态,参考 oh-story 热度四态 + inkos 角色矩阵):
  //   原: characterState.slice(-15) 全量注入最近 15 个 + 头部 5 个名字预警(M1 第十五轮)。
  //   问题: 主角若连续 6 章未出场被配角挤掉 slice(-15),buildDynamicContext 看不到主角状态 → 人设漂移。
  //   现: 按 lastSeenAt/recentAppearCount(updateStateFromGeneration 规则式补全)分四态分层注入:
  //     核心(rac>=5 或 lastSeenAt===curIdx) + 活跃(rac 2-4): 完整状态注入(最多 15 个)
  //     边缘(rac 1 或 lastSeenAt 在最近 20 章内) + 失踪(lastSeenAt 距 curIdx>20 章 或 rac 0): 仅名字(最多 10 个)
  //     主角保底: state.characters 第一个名字强制完整注入,即使被分到边缘/失踪
  //   旧数据无 lastSeenAt/recentAppearCount 时降级到原 slice(-15) + 防遗忘预警逻辑(向后兼容)。
  if (state.characterState && state.characterState.length > 0) {
    const allChars = state.characterState;
    const hasHeat = allChars.some(c => typeof c.lastSeenAt === 'number' || typeof c.recentAppearCount === 'number');
    const fmtFull = (c: CharacterState) => `· ${c.name}：位置「${c.location}」/ 状态「${c.mood}」/ 关系「${c.relationships}」`;
    if (!hasHeat) {
      // 旧数据降级: 原 slice(-15) + 头部 5 个防遗忘预警
      const recentChars = allChars.slice(-15);
      const omitted = allChars.length - recentChars.length;
      sections.push(`【角色当前状态${omitted > 0 ? `（最近 ${recentChars.length} 个,省略 ${omitted} 个更早角色）` : ''}】\n${recentChars.map(fmtFull).join('\n')}`);
      if (omitted > 0) {
        const forgotten = allChars.slice(0, Math.min(5, omitted)).map(c => c.name).filter(Boolean);
        if (forgotten.length > 0) {
          sections.push(`【久未出场角色 · 防遗忘】${forgotten.join('、')}（已超过 15 章未在最近活跃列表;若本章剧情涉及,可让其出场回顾,避免读者遗忘）`);
        }
      }
    } else {
      // 热度四态分组(优先级 core > active > edge > missing,互斥)
      const core: CharacterState[] = [];
      const active: CharacterState[] = [];
      const edge: CharacterState[] = [];
      const missing: CharacterState[] = [];
      for (const c of allChars) {
        const rac = typeof c.recentAppearCount === 'number' ? c.recentAppearCount : 0;
        const lsa = typeof c.lastSeenAt === 'number' ? c.lastSeenAt : -1;
        if (rac >= 5 || lsa === curIdx) core.push(c);
        else if (rac >= 2) active.push(c);                  // 2-4(rac>=5 已进 core)
        else if (rac >= 1 || (lsa >= 0 && lsa >= curIdx - 20)) edge.push(c);
        else missing.push(c);                                // lsa 距 curIdx>20 章 或 rac 0
      }
      // 主角识别: state.characters 第一个中文人名(2-4 字 + 后续 :/：/换行),失败降级 characterState[0]
      let protagonistName: string | null = null;
      if (state.characters) {
        const m = state.characters.match(/([\u4e00-\u9fa5]{2,4})\s*[：:\n]/);
        if (m && m[1]) protagonistName = m[1];
      }
      if (!protagonistName) protagonistName = allChars[0]?.name || null;

      // 完整注入: core + active,按 recentAppearCount 降序(同则 lastSeenAt 降序),最多 15
      const fullList = [...core, ...active]
        .sort((a, b) => (b.recentAppearCount ?? 0) - (a.recentAppearCount ?? 0) || (b.lastSeenAt ?? -1) - (a.lastSeenAt ?? -1))
        .slice(0, 15);
      // 名字注入: edge + missing,按 lastSeenAt 降序(最近见过优先),最多 10
      const nameList = [...edge, ...missing]
        .sort((a, b) => (b.lastSeenAt ?? -1) - (a.lastSeenAt ?? -1))
        .slice(0, 10);
      // 主角保底: 若主角不在完整注入集,且确实存在于 characterState,强制补完整状态
      const fullNames = new Set(fullList.map(c => c.name));
      const protagonist = protagonistName && !fullNames.has(protagonistName)
        ? allChars.find(c => c.name === protagonistName) ?? null
        : null;

      const lines: string[] = [];
      if (fullList.length > 0) {
        const coreNames = new Set(core.map(c => c.name));
        lines.push(`【角色当前状态 · 核心与活跃】（核心${core.length}/活跃${active.length},完整注入 ${fullList.length} 个）`);
        for (const c of fullList) {
          lines.push(`${coreNames.has(c.name) ? '【核心】' : '【活跃】'}${fmtFull(c)}`);
        }
      }
      if (protagonist) {
        lines.push(`【主角保底】${fmtFull(protagonist)}`);
      }
      if (nameList.length > 0) {
        const edgeNames = new Set(edge.map(c => c.name));
        const parts = nameList.map(c => edgeNames.has(c.name) ? `${c.name}【边缘】` : `${c.name}【失踪·可考虑回归】`);
        lines.push(`【边缘与失踪角色 · 仅名】（边缘${edge.length}/失踪${missing.length},列出 ${nameList.length} 个）：${parts.join('、')}`);
      }
      if (lines.length > 0) sections.push(lines.join('\n'));
    }
  }

  // —— 三层摘要归档（oh-story）：防上下文爆炸 ——
  // 第 1 层（近 5 章）：完整摘要详记
  // 第 2 层（6-15 章，即过去 10 章）：单行概要（标题 + 一句话）
  // 第 3 层（>15 章前）：H6 修复(第十二轮) 加远期卷摘要压缩层
  //   原: 16 章前摘要完全不注入 → 100+ 章长篇中段"失忆"
  //   现: 16 章前已完成的摘要按卷压缩,每卷取前 3 条摘要拼成"卷级已发生事件"注入
  //       既保留历史主线信息又控制 token,避免长篇失忆
  const summaries = (state.chapterSummaries || []).slice().sort((a, b) => a.idx - b.idx);
  if (summaries.length > 0) {
    const recentDetailed = summaries.slice(-5);            // 近 5 章：完整摘要
    const midOutline = summaries.slice(-15, -5);            // 6-15 章：单行概要
    const faraway = summaries.slice(0, -15);                // 16 章前：远期
    const parts: string[] = [];
    // H6 修复(第十四轮): 远期卷摘要改真压缩,优先用 volumeOutlines[].compactedSummary
    // 原: 远期摘要仅"采样 3 条 + 截断 30 字",非真压缩 → 30 字不足以承载关键事件,长篇失忆
    // 现: 每卷所有章节完成后由 daemon 触发 compactVolumeSummary 调 LLM 压缩成 3 句话
    //   (主线推进+伏笔状态+角色弧线),缓存到 compactedSummary,buildDynamicContext 优先用
    //   无 compactedSummary 时降级到原采样策略(向后兼容,旧库无此字段)
    if (faraway.length > 0) {
      const vols = state.volumeOutlines || [];
      if (vols.length > 0) {
        // 优先用 compactedSummary,无则降级到采样
        const volSummaries = vols.map(v => {
          const inVol = faraway.filter(s => s.idx >= v.chapterRange[0] && s.idx <= v.chapterRange[1]);
          if (inVol.length === 0) return null;
          if (v.compactedSummary) {
            // 真压缩:LLM 提炼的 3 句话,信息密度远高于采样
            return `· 第${v.idx + 1}卷《${v.title}》(第${v.chapterRange[0] + 1}-${v.chapterRange[1] + 1}章,共${inVol.length}章已完成):${v.compactedSummary}`;
          }
          // 降级:采样首/中/末章 + 截断 30 字
          const picks = inVol.length <= 3 ? inVol : [inVol[0], inVol[Math.floor(inVol.length / 2)], inVol[inVol.length - 1]];
          return `· 第${v.idx + 1}卷《${v.title}》(第${v.chapterRange[0] + 1}-${v.chapterRange[1] + 1}章,共${inVol.length}章已完成):${picks.map(s => `第${s.idx + 1}章${s.summary.slice(0, 30)}`).join(' / ')}（采样,未压缩）`;
        }).filter(Boolean);
        if (volSummaries.length > 0) {
          parts.push(`【远期卷摘要（第1-${faraway[faraway.length - 1].idx + 1}章,按卷压缩)】\n${volSummaries.join('\n')}`);
        }
      } else if (faraway.length > 0) {
        // 无卷大纲时,按每 10 章压缩
        const groups: ChapterSummary[][] = [];
        for (let i = 0; i < faraway.length; i += 10) groups.push(faraway.slice(i, i + 10));
        const groupLines = groups.map((g, gi) => {
          const picks = g.length <= 3 ? g : [g[0], g[Math.floor(g.length / 2)], g[g.length - 1]];
          return `· 第${gi * 10 + 1}-${gi * 10 + g.length}章:${picks.map(s => `第${s.idx + 1}章${s.summary.slice(0, 30)}`).join(' / ')}`;
        });
        parts.push(`【远期摘要(按10章压缩)】\n${groupLines.join('\n')}`);
      }
    }
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
  // M3 修复(第十四轮): 注入 keyForeshadows,让 LLM 知道本卷重点伏笔,正文可考虑回收
  // 原: 卷级总览只注入 premise + emotionArc,keyForeshadows 字段虽填充但 prompt 不可见
  //   → LLM 不知本卷有哪些待回收重点伏笔,可能错失回收时机
  if (state.volumeOutlines && state.volumeOutlines.length > 0) {
    sections.push(`【卷级总览】\n${state.volumeOutlines.map(v => {
      const kfs = v.keyForeshadows?.length ? ` | 重点伏笔：${v.keyForeshadows.slice(0, 5).join(' / ')}` : '';
      return `· 第${v.idx + 1}卷《${v.title}》(${v.chapterRange[0] + 1}-${v.chapterRange[1] + 1}章)：${v.premise} | 弧线：${v.emotionArc}${kfs}`;
    }).join('\n')}`);
  }

  // 升级2(情感线节奏 · CP向作品专用): 注入最近 5 个 beat + 下一章建议 beat 类型。
  //   节奏规律: 心动→靠近→日常糖→误解→分离→和好→升华(循环或递进),给 CP 向作品提供节奏锚点。
  //   state.emotionBeats 为空时跳过(非 CP 向作品不注入,避免 prompt 膨胀)。
  if (state.emotionBeats && state.emotionBeats.length > 0) {
    const beats = state.emotionBeats.slice().sort((a, b) => a.idx - b.idx);
    const recent5 = beats.slice(-5);
    // 下一章建议 beat 类型: 按节奏规律,取最近 beat 的下一个类型
    const rhythm: EmotionBeat['type'][] = ['心动', '靠近', '日常糖', '误解', '分离', '和好', '升华'];
    const lastType = recent5[recent5.length - 1]?.type;
    const lastIdx = lastType ? rhythm.indexOf(lastType) : -1;
    const nextSuggest = lastIdx >= 0 && lastIdx < rhythm.length - 1
      ? rhythm[lastIdx + 1]
      : (lastIdx === rhythm.length - 1 ? rhythm[2] /* 升华后回日常糖 */ : '心动');
    const beatsLines = recent5.map(b => `· 第${b.idx + 1}章[${b.type}]${b.characters.length ? `(${b.characters.join('×')})` : ''}：${b.desc}`).join('\n');
    sections.push(`【情感线节奏 · CP向作品】（最近 ${recent5.length} 个 beat）\n${beatsLines}\n→ 下一章建议 beat 类型:【${nextSuggest}】(节奏规律: 心动→靠近→日常糖→误解→分离→和好→升华,可循环或递进)`);
  }

  // 升级3(矛盾网状态 · 三层状态机): 注入 active 矛盾 + 最近 3 个 resolved 矛盾(检查 escalatedTo)。
  //   oh-story: 每解决一个矛盾必须激活或加深另一个,防单元剧化。
  //   resolved 矛盾若无 escalatedTo → 标【警告: 解决未激活新矛盾,可能单元剧化】硬提醒。
  //   state.conflictLines 为空时跳过(避免 prompt 膨胀)。
  if (state.conflictLines && state.conflictLines.length > 0) {
    const cls = state.conflictLines;
    const active = cls.filter(c => c.status === 'active');
    const resolved = cls.filter(c => c.status === 'resolved')
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
      .slice(0, 3);
    const levelLabel = (lv: string) => lv === 'book' ? '书级' : (lv === 'volume' ? '卷级' : '章级');
    const lines: string[] = [];
    if (active.length > 0) {
      lines.push(`· 当前运行中(active ${active.length} 个):`);
      for (const c of active.slice(0, 10)) {
        lines.push(`  - [${levelLabel(c.level)}] ${c.desc}${c.escalatedTo ? `(→升级自 ${c.escalatedTo})` : ''}`);
      }
    }
    if (resolved.length > 0) {
      lines.push(`· 最近解决(resolved ${resolved.length} 个,检查是否激活新矛盾):`);
      for (const c of resolved) {
        const warn = c.escalatedTo ? `(→已激活 ${c.escalatedTo})` : '【警告: 解决未激活新矛盾,可能单元剧化】';
        lines.push(`  - [${levelLabel(c.level)}] ${c.desc} ${warn}`);
      }
    }
    if (lines.length > 0) {
      sections.push(`【矛盾网状态 · 三层状态机】\n${lines.join('\n')}\n→ 铁律: 本章若解决矛盾,必须指定 escalatedTo 激活或加深新矛盾,防单元剧化`);
    }
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
): Promise<{ backfilled: number; issues: string[] }> {
  const chapters = chapterRepo.listByProject(projectId).filter(c => c.content && c.status === 'done');
  if (chapters.length === 0) return { backfilled: 0, issues: [] };
  const state = stateRepo.get(projectId);
  const existingSummaries = new Set((state?.chapterSummaries || []).map(s => s.idx));
  // 缺失摘要的章节列表（按 idx 排序）
  const missing = chapters.filter(c => !existingSummaries.has(c.orderIdx));
  const total = missing.length;
  let backfilled = 0;
  const allIssues: string[] = [];
  for (const ch of missing) {
    try {
      const oc = outlineChapters?.[ch.orderIdx];
      // M2 修复(第十七轮): 接住 issues 数组聚合,让 daemon 重启回填期也能看到伏笔误埋/状态告警
      // 原: 只 await 不接返回值 → H2 检测到的过期伏笔重埋在重启回填时静默丢失
      const result = await updateStateFromGeneration(projectId, model, providerId, ch.orderIdx, oc?.positioning, oc?.coreEmotion);
      if (result.issues.length > 0) {
        for (const issue of result.issues) allIssues.push(`第${ch.orderIdx + 1}章: ${issue}`);
      }
      backfilled++;
      // 进度回调：让调用方写 task_log，避免长时间无输出被误判卡死
      onProgress?.(backfilled, total);
    } catch (e) {
      // M6 修复(第十三轮): 不再静默吞错,打 console.warn 让重启回填失败可排查
      // 原: catch{} 完全无日志 → 80 章回填全失败时 task_log 一片空白,排查者无从下手
      console.warn(`[reconcileState] 第 ${ch.orderIdx + 1} 章补全失败:`, (e as Error).message);
      allIssues.push(`第${ch.orderIdx + 1}章补全失败: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  return { backfilled, issues: allIssues };
}

// ============ chapter_memo 七段契约（inkos chapter_memo + hook 账本硬对账）============
// 与 buildChapterAnchor 软约束互补: anchor 是 prompt 段落(软约束,靠 LLM 自觉遵守),
// memo 是结构化字段(硬契约,生成后由 verifyMemoCompliance 规则式硬对账)。
// 七段: ① 目标 ② 钩子 ③ 伏笔(埋/收/推) ④ 角色弧线 ⑤ 字数预算 ⑥ 情绪强度 ⑦ 承接要点
//
// 持久化说明: AgentState.chapterMemos 落库到 agent_state.chapter_memos_json(db.ts SCHEMA + migrateLegacySchema)。
// stateRepo.update 序列化 chapterMemos 写入该列,rowToState 反序列化回填。
// 此处模块级 Map 作为热缓存: getChapterMemos 优先读内存,miss(如重启后首次访问)时从 stateRepo.get
// 回填内存 Map。upsertChapterMemo 写内存 + 透传 stateRepo.update 落库,重启后不丢失。
const _chapterMemosByProject = new Map<string, ChapterMemo[]>();

export function getChapterMemos(projectId: string): ChapterMemo[] {
  const cached = _chapterMemosByProject.get(projectId);
  if (cached) return cached;
  // 热缓存 miss(如重启后首次访问): 从 stateRepo.get 读已落库的 chapterMemos 回填内存 Map
  try {
    const fromDb = stateRepo.get(projectId)?.chapterMemos;
    if (fromDb && fromDb.length > 0) {
      _chapterMemosByProject.set(projectId, fromDb);
      return fromDb;
    }
  } catch { /* 忽略,不影响主流程 */ }
  return [];
}

export function getChapterMemo(projectId: string, idx: number): ChapterMemo | undefined {
  return (_chapterMemosByProject.get(projectId) || []).find(m => m.idx === idx);
}

export function upsertChapterMemo(projectId: string, memo: ChapterMemo): ChapterMemo[] {
  const cur = _chapterMemosByProject.get(projectId) || [];
  const updated = [...cur.filter(m => m.idx !== memo.idx), memo];
  _chapterMemosByProject.set(projectId, updated);
  // 落库到 agent_state.chapter_memos_json,重启后 getChapterMemos 从 stateRepo.get 回填内存
  try { stateRepo.update(projectId, { chapterMemos: updated }); } catch { /* 忽略,不影响主流程 */ }
  return updated;
}

// 生成章节 memo(调 LLM 输出七段契约 JSON)。失败返回 null,不阻断生成(调用方跳过 memo 流程)。
// model/providerId 由调用方传入(daemon.ts 章节循环里已有),与 updateStateFromGeneration 的 LLM 调用模式一致。
export async function generateChapterMemo(
  projectId: string,
  currentIdx: number,
  totalChapters: number,
  chapterTitle: string,
  chapterOutline: string,
  positioning: ChapterPositioning | undefined,
  coreEmotion: string | undefined,
  wordBudget: number,
  wordMin: number | undefined,
  wordMax: number | undefined,
  model: string,
  providerId?: string,
): Promise<ChapterMemo | null> {
  // 取上一章末尾用于承接(参考 buildChapterAnchor 的 getTail)
  const prevTail = currentIdx > 0 ? chapterRepo.getTail(projectId, currentIdx - 1) : '';
  // 取待回收伏笔(参考 buildDynamicContext 的 pending 列表)
  const state = stateRepo.get(projectId);
  const pending = (state?.foreshadowing || [])
    .filter(f => f.status === 'planted')
    .slice(0, 15)
    .map(f => `- ${f.desc}（第${f.plantedAt + 1}章埋设${f.importance === 'high' ? '·主线' : ''}）`)
    .join('\n');

  const prompt = `请为以下章节生成「chapter_memo 七段契约」JSON,作为本章正文生成的硬契约。后续会做规则式硬对账(伏笔 desc 前 4 字关键词必须出现在正文,章末 200 字必须含钩子信号词)。

【章节信息】第 ${currentIdx + 1} / ${totalChapters} 章《${chapterTitle}》
【本章大纲】${chapterOutline}
【章节定位】${positioning || '未指定'}
【核心情绪】${coreEmotion || '未指定'}
【字数预算】${wordBudget} 字${wordMin && wordMax ? `（区间 ${wordMin}-${wordMax}）` : ''}

【上一章末尾 300 字】（用于承接要点,首章无）
${prevTail || '（首章,无上一章）'}

【待回收伏笔】（本章可考虑回收其一,过期伏笔不可再埋）
${pending || '（无）'}

输出 JSON,严格遵循以下七段契约结构(只输出 JSON,不要 markdown 代码块,不要其他文字):
{
  "objectives": "1.本章目标:必达情节点(从大纲提炼,2-4 个用分号分隔,具体到事件)",
  "hook": "2.本章钩子:章末 200 字悬念元素具体描述(具体到动作/物件/未解问题,不要笼统说'留悬念')",
  "plantForeshadows": ["3.本章埋设的伏笔 desc 列表(每个 desc 8-30 字,描述具体物件/线索/谜团,可空数组)"],
  "payForeshadows": ["3.本章回收的伏笔 desc 列表(从上方待回收伏笔中选,desc 尽量与原文一致,可空数组)"],
  "advanceForeshadows": ["3.本章推进的伏笔 desc 列表(已有伏笔的进一步线索推进,可空数组)"],
  "characterArcs": [{"name": "角色名", "arc": "本章弧线节点(如 V形坠谷反弹/递进新台阶/延迟满足拐点等)"}],
  "emotionIntensity": "6.情绪强度 + 核心情绪(如 '4级·爽感释放' / '2级·治愈',1-5 级)",
  "carryOver": "7.承接要点:上一章末尾场景 + 必须自然衔接的元素(首章可写'开篇直入主线')"
}`;

  const ctxPrompt = buildContextPrompt(projectId, currentIdx);
  const systemStable = ctxPrompt
    ? `${ctxPrompt}\n\n你是长篇写作结构化契约设计师,遵循 inkos chapter_memo 七段契约方法论。输出必须是合法 JSON,不要 markdown 代码块。`
    : '你是长篇写作结构化契约设计师,遵循 inkos chapter_memo 七段契约方法论。输出必须是合法 JSON,不要 markdown 代码块。';
  const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];

  try {
    const { complete } = await import('./llm.js');
    // maxTokens 控制在 800(任务要求精简,每章 +1 次 LLM 调用成本可控)
    const { text } = await complete({
      providerId, model, messages, systemStable, projectId,
      temperature: 0.4, maxTokens: 800,
    });
    // 提取 JSON(兼容 ```json 代码块包裹 + 末尾多余说明)
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      // 截断兜底:从后向前找合法对象边界 } 补全后尝试 parse(参考 updateStateFromGeneration)
      const start = match[0].indexOf('{');
      if (start < 0) return null;
      const tail = match[0].slice(start);
      let ok = false;
      for (let i = tail.length - 1; i >= 0; i--) {
        if (tail[i] !== '}') continue;
        const next = tail[i + 1];
        if (next === undefined || next === ',' || next === ' ' || next === '\n' || next === '\r' || next === '\t') {
          try { parsed = JSON.parse(tail.slice(0, i + 1)); ok = true; break; } catch { /* 继续找更早边界 */ }
        }
      }
      if (!ok) return null;
    }

    const asArr = (v: unknown): string[] => Array.isArray(v) ? v.map(x => String(x || '').slice(0, 120)).filter(Boolean) : [];
    const asCharArcs = (v: unknown): { name: string; arc: string }[] => {
      if (!Array.isArray(v)) return [];
      return v
        .filter((x: any) => x && typeof x.name === 'string')
        .map((x: any) => ({ name: String(x.name).slice(0, 40), arc: String(x.arc || '').slice(0, 80) }));
    };

    const memo: ChapterMemo = {
      idx: currentIdx,
      objectives: String(parsed.objectives || '').slice(0, 300) || `（第${currentIdx + 1}章目标,见大纲）`,
      hook: String(parsed.hook || '').slice(0, 200),
      plantForeshadows: asArr(parsed.plantForeshadows),
      payForeshadows: asArr(parsed.payForeshadows),
      advanceForeshadows: asArr(parsed.advanceForeshadows),
      characterArcs: asCharArcs(parsed.characterArcs),
      wordBudget,
      emotionIntensity: String(parsed.emotionIntensity || '').slice(0, 60) || (coreEmotion || '未指定'),
      carryOver: String(parsed.carryOver || '').slice(0, 200),
      createdAt: Date.now(),
    };
    return memo;
  } catch (e) {
    console.warn(`[generateChapterMemo] 第 ${currentIdx + 1} 章 memo 生成失败(跳过 memo 流程):`, (e as Error).message);
    return null;
  }
}

// 规则式硬对账(纯函数,不调 LLM): 检查正文是否兑现 memo 契约。
// ① plantForeshadows / payForeshadows 的每个 desc 取前 4 字作关键词,必须在正文出现
// ② hook 信号词检测: 章末 200 字含 ？/！/省略号/然而/不料 等之一(复用 checkChapterQuality 的 hookSignals 思路)
// 返回 passed=false + missing 列表(未兑现的伏笔 desc + 钩子缺失描述),供 checkChapterQuality 拼到重写 prompt。
export function verifyMemoCompliance(content: string, memo: ChapterMemo): { passed: boolean; missing: string[] } {
  const missing: string[] = [];
  // ① 伏笔 desc 关键词检测(取 desc 前 4 字作关键词,中文 desc 通常前 4 字足以定位)
  const checkForeshadow = (desc: string, kind: '埋设' | '回收' | '推进'): void => {
    if (!desc) return;
    const kw = desc.slice(0, 4);
    // 短 desc(< 4 字)走全等包含,避免短关键词误匹配
    const hit = kw.length < 4 ? content.includes(desc) : content.includes(kw);
    if (!hit) missing.push(`伏笔未兑现(${kind}):「${desc}」关键词「${kw}」未在正文出现`);
  };
  for (const d of memo.plantForeshadows) checkForeshadow(d, '埋设');
  for (const d of memo.payForeshadows) checkForeshadow(d, '回收');
  // advanceForeshadows 也检测(推进的伏笔应有线索出现)
  for (const d of memo.advanceForeshadows) checkForeshadow(d, '推进');

  // ② hook 信号词检测(章末 200 字)
  if (content.length > 500 && memo.hook) {
    const tail200 = content.slice(-200);
    const hookSignals = ['？', '！', '...', '……', '然而', '可是', '不料', '突然', '只见', '下一', '未完', '究竟', '难道', '谁知', '倒底', '到底'];
    const hasHook = hookSignals.some(s => tail200.includes(s));
    if (!hasHook) {
      missing.push(`章末钩子缺失:memo 钩子「${memo.hook.slice(0, 40)}」未在章末 200 字检测到悬念信号词(？/！/省略号/然而/不料等)`);
    }
  }

  return { passed: missing.length === 0, missing };
}

// 章节生成前的位置锚点：告诉 LLM 当前在第几章、已完成多少、本章目标 + 上一章结尾用于自然衔接
// oh-story：注入【本章定位】块（章节定位类型 + 字数预算 + 核心情绪），与 write prompt 的章节定位六类/字数预算Σ契约对位
// M3 修复(第十四轮): volumeCtx 加 keyForeshadows,本卷主线块注入重点伏笔,LLM 知本章可回收哪些
// H3 修复(第十九轮): 加 wordMin/wordMax 参数,用户配置的每章字数上下限注入 prompt,替代硬编码 budget*0.8/1.2
export function buildChapterAnchor(
  projectId: string,
  currentIdx: number,
  totalChapters: number,
  chapterTitle: string,
  chapterOutline: string,
  positioning?: ChapterPositioning,
  baseWordTarget = 2500,
  coreEmotion?: string,
  volumeCtx?: { idx: number; title: string; premise: string; emotionArc: string; keyForeshadows?: string[] } | null,
  wordMin?: number,
  wordMax?: number,
): string {
  // BUG-1 修复：原 listByProject 全量加载只为取 prevChapters[currentIdx-1].content.slice(-300)，
  // 2000 章循环 = O(N²) 全表扫描。改用 getTail 仅查单行 content
  const prevTail = (currentIdx > 0 ? chapterRepo.getTail(projectId, currentIdx - 1) : '') || '（首章，无需承接）';

  // H3 修复(第十九轮): 用户配置的上下限,不传则按 baseWordTarget*0.8/1.2 计算(向后兼容)
  const lo = wordMin ?? Math.round(baseWordTarget * 0.8);
  const hi = wordMax ?? Math.round(baseWordTarget * 1.2);

  // 本章定位块：章节定位类型 + 字数预算 + 核心情绪（与 write prompt 的【本章定位】字段对位）
  let positioningBlock = '';
  if (positioning) {
    const meta = POSITIONING_META[positioning];
    const wordBudget = Math.round(baseWordTarget * meta.budgetMult);
    // H3 修复(第十九轮): 定位章字数预算按 budgetMult 调整,但浮动区间用用户配置的 [lo, hi]
    // 原: 硬编码 wordBudget*0.95/1.1; 现: 保持浮动宽度一致,以 wordBudget 为中心 ±(hi-baseWordTarget)/(baseWordTarget-lo)
    const positioningLo = Math.max(lo, Math.round(wordBudget - (baseWordTarget - lo)));
    const positioningHi = Math.round(wordBudget + (hi - baseWordTarget));
    positioningBlock = `
【本章定位】
· 章节类型：${meta.label}（${positioning}）—— 情绪强度对位：${meta.emotion}
· 字数预算：${wordBudget} 字（Σ 落在 [${positioningLo}, ${positioningHi}] 内，防注水/防欠字）
· 核心情绪：${coreEmotion || meta.emotion}`;
  } else {
    positioningBlock = `
【本章定位】
· 章节类型：普通推进章（默认）
· 字数预算：${baseWordTarget} 字（约 ${lo}-${hi} 字）
· 核心情绪：按题材对位（见题材→情绪路由表）`;
  }

  // H2 修复(第十二轮): 注入本卷核心冲突 + 情绪弧线,防每章不知卷主线而跑题
  // 原: buildChapterAnchor 只注入本章定位 + 上一章结尾,LLM 看不到当前卷要解决什么主线冲突
  // 第二十六轮升级(长篇防跑偏): 注入【全书核心锚点】(state.idea 提炼),
  //   200+ 章中段 LLM 容易写独立单元脱离全书主线。每章硬注入核心创意作为主线锚点,
  //   提醒 LLM 本章不得彻底解决核心冲突(除非末章),只能推进/转折。
  const _projState = stateRepo.get(projectId);
  const ideaAnchor = _projState?.idea
    ? `\n【全书核心锚点】${_projState.idea.slice(0, 200)}${_projState.idea.length > 200 ? '…' : ''}
· 本章不得彻底解决全书核心冲突,只能推进或转折（除非是第 ${totalChapters} 章大结局）
· 所有支线最终须回归核心主线,不得写脱离核心锚点的独立单元`
    : '';
  // 现: 通过 volumeOutlines 反查当前章所属卷,注入【本卷主线】段
  // M3 修复(第十四轮): 加 keyForeshadows 注入,LLM 知本卷重点伏笔可考虑回收
  const volKfs = volumeCtx?.keyForeshadows?.length
    ? `\n· 本卷重点伏笔：${volumeCtx.keyForeshadows.slice(0, 5).join(' / ')}（可考虑本章回收其一）`
    : '';
  const volumeBlock = volumeCtx
    ? `
【本卷主线 · 第${volumeCtx.idx + 1}卷《${volumeCtx.title}》】
· 核心冲突：${volumeCtx.premise}
· 情绪弧线：${volumeCtx.emotionArc}${volKfs}
· 本章须推进本卷核心冲突,不得脱离卷主线写独立单元`
    : '';

  return `【当前位置锚点】
正在创作：第 ${currentIdx + 1} / ${totalChapters} 章《${chapterTitle}》
本章大纲：${chapterOutline}
${positioningBlock}${volumeBlock}${ideaAnchor}

【上一章结尾 300 字】（必须自然承接此情境，不得重复）
${prevTail}

约束：严格承接上一章结尾的情境/对话/动作，不得让角色做出与人设矛盾的行为；按【本章定位】的情绪强度与字数预算写作；${volumeCtx ? '推进【本卷主线】的核心冲突,不得跑题；' : ''}伏笔已在上方列出，本章可考虑回收其中之一（过期伏笔不可再埋）。

【本章大纲忠实度硬约束】（最高优先级，高于其他所有约束）
· 严格按上方【本章大纲】推进本章剧情，大纲列出的情节点必须全部落地，不得跳过、不得替换、不得偏离
· 不得擅自新增大纲未提及的重大事件/人物/能力/场景；可在细节处丰富，但主线节点必须按大纲写
· 当本章大纲与其他约束（承接/伏笔/节奏）出现张力时，优先遵循本章大纲，其他约束作为辅助而非替代
· 禁止用"承接需要/伏笔回收/节奏调整"为由绕过大纲已定的剧情走向

【伏笔硬对应规则】（参考 inkos hook 账本 + oh-story 伏笔状态机）
· 若本章回收伏笔,必须在正文写出≥60 字的可定位兑现段(具体动作/物件/对话),内心提及("他想起借条还在抽屉")不算兑现,必须写出真实场景
· "揭1埋1"硬底线:每回收 1 个伏笔,本章应新埋或推进至少 1 个伏笔,避免埋设耗尽后剧情悬空
· 过期伏笔(上方标"已过期")不可再埋,可作废案一笔带过

【核心冲突节奏保护】（oh-story 三规则）
· 非大结局章节(第 ${currentIdx + 1}/${totalChapters})禁止彻底解决全书核心冲突,只能推进或转折
· 章末 200 字必须包含悬念元素(钩子/未解问题/新威胁),不得平淡收尾
· 局部胜利必须伴随新的代价或风险(打赢了但暴露身份/获得宝物但引来强敌),不得纯爽收

【矛盾网三层状态机】（oh-story: 章级/卷级/书级矛盾同时运行,防单元剧化）
· 本章若引入新矛盾: 在正文写出矛盾的对立双方 + 矛盾层级(章级/卷级/书级)
· 本章若解决矛盾: 必须激活或加深另一个矛盾(escalatedTo),禁止"解决一个矛盾后无后续"的单元剧式收尾
· 三层矛盾须同时运行: 章级矛盾本章解决,卷级/书级矛盾持续推进,不得只写章级矛盾忽视长线
· 正文写完后,系统会提取本章 conflictLines 状态变化(见状态更新 prompt)`;
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
  // H4 修复(第十五轮): 透传当前章 idx 给 buildContextPrompt 做大纲滑动窗口注入
  currentChapterIdx?: number;
}

export async function* runSkill(params: GenerateParams): AsyncGenerator<string> {
  const contextPrompt = buildContextPrompt(params.projectId, params.currentChapterIdx);
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
【题材风格】${config.genre}${buildGenreHint(config)}${buildToneHint(config)}
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
（角色之间用空行分隔）

【文风基因注入要求】世界观与角色档案须自带上方【文风】基因：
- 甜宠/虐恋风：角色档案须显式标注 CP 关系（暧昧/情愫/对立吸引）、误会根源或情感纠葛
- 群像风：须含 2-3 个并列主角与势力关系图，无绝对主角
- 悬疑风：世界观须含 1-2 个待解谜题钩子，角色档案可含秘密/动机
- 系统流风：世界观须含系统规则（签到/任务/奖励体系），金手指依托系统
- 年代文风：世界观须含具体年代(70-90 年代)与时代符号（粮票/供销社等），金手指受限
- 恶搞风：角色档案可自带喜感标签与吐槽属性`;

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

// tokenCharRatio: 质检 maxTokens 适配国产模型(与 daemon.ts 同名函数同逻辑)
// 国产模型(deepseek/qwen/glm 等)中文 1 字≈1.5 token,OpenAI 系≈1.2,未知保守 1.5
// 缓存避免长篇循环内反复查 provider 表
const _tokenRatioCache = new Map<string, number>();
function tokenCharRatio(providerId?: string): number {
  if (!providerId) return 1.5;
  const cached = _tokenRatioCache.get(providerId);
  if (cached !== undefined) return cached;
  const provider = providerRepo.get(providerId);
  let ratio = 1.5;
  if (provider) {
    const CN_KINDS: ProviderKind[] = ['deepseek', 'qwen', 'glm', 'doubao', 'kimi', 'hunyuan', 'ernie'];
    const LIGHT_KINDS: ProviderKind[] = ['openai', 'anthropic', 'gemini', 'kilo'];
    if (CN_KINDS.includes(provider.kind)) ratio = 1.5;
    else if (LIGHT_KINDS.includes(provider.kind)) ratio = 1.2;
    else ratio = 1.5;
  }
  _tokenRatioCache.set(providerId, ratio);
  return ratio;
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
  // 第二十六轮新增: 用户配置的上下限(若有),字数门按此做硬判定而非 wordBudget*1.5
  chapterWordMin?: number;
  chapterWordMax?: number;
  // chapter_memo 七段契约(inkos): 若提供,则调用 verifyMemoCompliance 做规则式硬对账,
  // missing 项作为 issues 拼到重写 prompt 让 LLM 补齐(伏笔 desc 关键词 + 章末钩子信号词)
  memo?: ChapterMemo;
}): Promise<ChapterQualityResult> {
  const { projectId, model, providerId, chapterIdx, chapterTitle, outline, positioning, coreEmotion, content, wordBudget, chapterWordMin, chapterWordMax, memo } = opts;
  const issues: string[] = [];
  const actualLen = content.length;

  // —— Gate 1：字数门 ——
  // 第二十六轮修复(字数超标 BUG + 用户自定义上下限):
  //   用户诉求: ① 上下限由用户在一键生成(Generate 页)时自定义,不再用 wordBudget*1.5 这种与用户配置无关的
  //      硬性默认值; ② 生成中该检测还是得检测,超限(超用户配置上下限的容差)仍触发重写。
  //   原 bug: 字数门只用 wordBudget*1.5 判"超标轻微不重写",完全忽略用户配置的 chapterWordMax。
  //      用户设上限 3000、预算 2500,生成 4416 字 → 1.5×2500=3750,4416>3750 但只判"轻微不重写",
  //      用户自定义设定形同虚设。
  //   现: 字数门按用户配置的上下限做硬判定——
  //      · actualLen < chapterWordMin*0.7(或 wordBudget*0.6)→ 严重不足,needRewrite
  //      · actualLen > chapterWordMax*1.15(或 wordBudget*1.5)→ 严重超标,needRewrite 重写压缩
  //      · 介于 chapterWordMax 与 chapterWordMax*1.15 之间 → 容差内,警告保留(不重写)
  //      无 chapterWordMin/Max 时回落 wordBudget 比例(向后兼容单章/老任务)。
  const minHard = chapterWordMin ? Math.round(chapterWordMin * 0.7) : Math.round(wordBudget * 0.6);
  const hardMax = chapterWordMax ? Math.round(chapterWordMax * 1.15) : Math.round(wordBudget * 1.5);
  if (actualLen < minHard) {
    issues.push(`字数严重不足：${actualLen} 字 < ${chapterWordMin ? `配置下限 ${chapterWordMin} 字的 70%` : `预算 ${wordBudget} 字的 60%`}（${minHard} 字）`);
  } else if (chapterWordMin && actualLen < chapterWordMin) {
    issues.push(`字数偏少：${actualLen} 字 < 配置下限 ${chapterWordMin} 字（轻微，不重写）`);
  } else if (!chapterWordMin && actualLen < wordBudget * 0.9) {
    issues.push(`字数偏少：${actualLen} 字 < 预算 ${wordBudget} 字的 90%（轻微，不重写）`);
  } else if (actualLen > hardMax) {
    issues.push(`字数严重超标：${actualLen} 字 > ${chapterWordMax ? `配置上限 ${chapterWordMax} 字的 1.15 倍` : `预算 ${wordBudget} 字的 1.5 倍`}（${hardMax} 字），需重写压缩`);
  } else if (chapterWordMax && actualLen > chapterWordMax) {
    issues.push(`字数轻微超标：${actualLen} 字 > 配置上限 ${chapterWordMax} 字（15% 容差内，保留）`);
  } else if (!chapterWordMax && actualLen > wordBudget * 1.2) {
    issues.push(`字数超标：${actualLen} 字 > 预算 ${wordBudget} 字的 1.2 倍（轻微，不重写）`);
  }

  // —— Gate 2：跑题门（调 LLM 判断）——
  // 仅当字数达到 minHard 才跑 LLM 跑题门，避免短文本被误判
  // LLM 返回 JSON：{ score: 0-1, reason: string }
  // score >= 0.6 视为达标，< 0.6 → needRewrite
  let topicScore = 1.0;  // 默认通过（LLM 调用失败时不阻断生成）
  // 第二十五轮: 模型退化硬失败标志(末尾截断 / tier1 工程词泄漏) → 强制 needRewrite
  let degenerationHardFail = false;
  // 第二十六轮修复(字数门改用用户自定义上下限后的安全网): 规则式退化检测(末尾截断/工程词)移到
  //   minHard 门之外,无论字数是否达标都执行。字数门按用户配置上下限做硬判定(超容差触发重写),
  //   但若短文本(未触字数门硬失败)仍跳过退化检测,maxTokens 截断/工程词泄漏的废稿会带 issue 却
  //   needRewrite=false 直接通过 → 质量门形同虚设。退化检测属"模型故障信号"而非"字数边界",
  //   保留独立强制重写确保废稿被拦下重写。
  let degenerationIssue = '';
  {
    const trimmed = content.trimEnd();
    const tailChar = trimmed.slice(-1);
    const hasClosingPunct = /[。！？…」』"']/.test(tailChar);
    if (!hasClosingPunct && actualLen < wordBudget * 0.7) {
      issues.push(`疑似末尾截断：正文末尾无收束标点且字数 ${actualLen} < 预算 ${wordBudget} 的 70%,可能 maxTokens 用尽被截断`);
      degenerationIssue = `\n【疑似末尾截断】正文末尾无收束标点且字数不足,请补全章节结尾（自然收束于一个完整场景/钩子,不要为凑字数注水）。`;
      degenerationHardFail = true;
    }
    // 工程词检测:去掉首行(可能是章节标题,标题含"第X章"属正常)
    const bodyLines = content.split('\n');
    const bodyForCheck = bodyLines.length > 1 ? bodyLines.slice(1).join('\n') : content;
    const TIER1_WORDS = ['细纲', '情节点', '卷纲', '功能标签', '任务描述', '字数预算', '章节定位'];
    const TIER2_WORDS = ['本章', '下一章', '前一章', '上一章'];
    const tier1Hits = TIER1_WORDS.filter(w => bodyForCheck.includes(w));
    const tier2Hits = TIER2_WORDS.filter(w => bodyForCheck.includes(w));
    if (tier1Hits.length > 0) {
      issues.push(`工程词泄漏正文（tier1 blocking）：${tier1Hits.join('、')} 出现在正文,模型把大纲/指令原文吐入正文`);
      degenerationIssue += `\n【工程词泄漏】正文出现写作元词: ${tier1Hits.join('、')},请删除这些词及其所在句,用实际叙事替换。`;
      degenerationHardFail = true;
    } else if (tier2Hits.length > 0) {
      // tier2 advisory:角色真在读"第X章"可豁免,仅提示不重写
      issues.push(`工程词疑似泄漏（tier2 advisory,不重写）：${tier2Hits.join('、')} 出现在正文,请人工确认是否角色在故事内讨论章节`);
    }
  }

  // —— Gate 1.5：chapter_memo 七段契约硬对账（inkos hook 账本）——
  // 若调用方提供 memo,则调用 verifyMemoCompliance 做规则式硬对账:
  //   ① 伏笔 desc 关键词(前 4 字)必须在正文出现(埋设/回收/推进)
  //   ② 章末 200 字必须含钩子信号词(？/！/省略号/然而/不料等)
  // missing 项作为 issues 拼到重写 prompt 让 LLM 补齐;memoHardFail 触发 needRewrite。
  let memoHardFail = false;
  if (memo) {
    const compliance = verifyMemoCompliance(content, memo);
    if (!compliance.passed) {
      for (const m of compliance.missing) issues.push(`memo 契约未兑现：${m}`);
      memoHardFail = true;
    }
  }

  if (actualLen >= minHard) {
    // H1 修复(第十四轮): 跑题门增第 5 维「伏笔回收度」,relationship 章未回收扣分
    // H2 修复(第十五轮): 增第 6 维「AI 味检测」,正则预筛禁用词/翻转句/总结升华
    // H3 修复(第十五轮): 增第 7 维「卷主线推进度」,注入 volumeCtx 校验是否推进卷核心冲突
    // 第二十六轮性能优化: 原 3 次独立 stateRepo.get(L734/L783/L796)合并为 1 次,
    //   2000 章省 4000 次 SQLite 查询。
    const _state = stateRepo.get(projectId);
    // 待回收伏笔列表(供 LLM 判断本章是否回收)
    const pendingFs = (_state?.foreshadowing || [])
      .filter(f => f.status === 'planted')
      .slice(0, 15)
      .map(f => `- ${f.desc}（第${f.plantedAt + 1}章埋设${f.importance === 'high' ? '·主线' : ''}）`)
      .join('\n');
    const recycleBlock = positioning === 'relationship' && pendingFs
      ? `\n【待回收伏笔（本章必须回收至少 1 个）】\n${pendingFs}`
      : '';
    const recycleHint = positioning === 'relationship'
      ? `\n5. 伏笔回收度：本章为关系回收章,是否回收了至少 1 个上方【待回收伏笔】中的项（0-1,未回收给 ≤0.4,回收 1 个给 0.7+,回收多个给 1.0）`
      : `\n5. 伏笔回收度：本章非关系回收章,默认给 0.7（0-1）`;

    // H2 修复(第十五轮): AI 味正则预筛(7 Gate 禁用模式),命中数过多 → 直接判 0.4 + 加 issue
    // oh-story 7 Gate: A 禁用副词(仿佛/宛如/犹如/似乎/不禁/不由得/淡淡的/缓缓的)
    //   B 翻转句式(不是 A 而是 B / 并非 A,而是 B / 这便是 X)
    //   C 总结升华(本章.../至此.../就这样.../从此.../就这样,故事.../这便是...的全部)
    //   D 排比三连(三句相同句式排比)
    // 第二十五轮新增 Gate G(oh-story v0.6.18 解释腔/上帝感/安排感):
    //   · "之所以…是因为" 因果解释腔(替读者下结论)
    //   · "殊不知" / "多年以后" / "他不知道的是" 上帝视角剧透
    //   · "与其说…不如说" 翻转句跨句变体(B 门翻转句的软变体)
    // 注入到 prompt 让 LLM 二次确认,综合分按 7 维平均
    const AI_TASTE_PATTERNS = [
      /仿佛/g, /宛如/g, /犹如/g, /似乎/g, /不禁/g, /不由得/g, /淡淡的/g, /缓缓的/g,
      /不是.{0,30}而是/g, /并非.{0,30}而是/g, /这便是.{0,10}/g, /与其说.{0,30}不如说/g,
      /本章[^。]*。/g, /至此[^。]*。/g, /就这样[^。]*。/g, /从此[^。]*。/g,
      /之所以.{0,30}是因为/g, /殊不知/g, /多年以后/g, /(他|她)不知道的是/g,
    ];
    let aiTasteHits = 0;
    const hitPatterns: string[] = [];
    for (const p of AI_TASTE_PATTERNS) {
      const m = content.match(p);
      if (m) { aiTasteHits += m.length; if (m.length > 0) hitPatterns.push(`${p.source}×${m.length}`); }
    }
    // 命中数 > 8 视为 AI 味重,直接判 0.4 + 加 issue 触发重写
    const aiTasteScore = aiTasteHits > 12 ? 0.3 : (aiTasteHits > 8 ? 0.5 : (aiTasteHits > 4 ? 0.7 : 0.9));
    if (aiTasteHits > 8) {
      issues.push(`AI 味重：命中 ${aiTasteHits} 个禁用模式（${hitPatterns.slice(0, 3).join(' / ')}${hitPatterns.length > 3 ? '...' : ''}）`);
    }
    const aiTasteBlock = aiTasteHits > 4
      ? `\n【已检测到 AI 味命中 ${aiTasteHits} 处】命中模式: ${hitPatterns.slice(0, 5).join(' / ') || '无'}\n请重点检查是否仍有上述禁用模式未修改。`
      : '';

    // 第二十五轮新增(情绪母题扎堆检测,参考 oh-story v0.6.20「禁情绪母题扎堆」底线):
    //   相邻 3 章同情绪母题高位运行是比"每章像短篇"更隐蔽的疲劳源。
    //   检查当前章 coreEmotion 与前 2 章摘要的 coreEmotion 是否同母题 → 命中加 advisory issue
    //   (不强制重写,因可能是有意为之的连续高潮;仅提示作者差异化)
    let emotionClusterIssue = '';
    if (coreEmotion) {
      const recentSummaries = (_state?.chapterSummaries || [])
        .filter(s => s.idx < chapterIdx && s.coreEmotion)
        .sort((a, b) => b.idx - a.idx)
        .slice(0, 2);
      if (recentSummaries.length === 2 && recentSummaries.every(s => s.coreEmotion === coreEmotion)) {
        issues.push(`情绪母题扎堆（advisory,不重写）：本章与前 2 章 coreEmotion 均为「${coreEmotion}」,连续 3 章同情绪母题易致疲劳,建议下章换情绪/钩子方式差异化`);
        emotionClusterIssue = `\n【情绪母题扎堆】本章与前 2 章均为「${coreEmotion}」,如非有意为之的连续高潮,请在重写时换情绪/钩子方式差异化。`;
      }
    }

    // 第二十六轮升级(节奏门规则式检测): oh-story 节奏门要求章末 200 字含悬念元素。
    //   原: 节奏只靠字数进度间接判断,LLM 质检软判定。现加规则式硬检测:
    //   章末 200 字若无钩子信号词(？/！/省略号/悬念词),加 advisory issue(不重写,仅提示)。
    //   覆盖 buildChapterAnchor L404 "章末 200 字必须包含悬念元素" 的约束,质检回检。
    let hookIssue = '';
    if (actualLen > 500) {
      const tail200 = content.slice(-200);
      const hookSignals = ['？', '！', '...', '……', '然而', '可是', '不料', '突然', '只见', '下一', '未完', '究竟', '难道', '谁知', '倒底', '到底'];
      const hasHook = hookSignals.some(s => tail200.includes(s));
      if (!hasHook) {
        issues.push(`节奏门 advisory（不重写）：章末 200 字未检测到悬念元素（钩子/未解问题/新威胁信号词），建议结尾加悬念钩子提升追读`);
        hookIssue = `\n【章末钩子缺失】章末 200 字无悬念信号词,请重写时在结尾加钩子(疑问/反转/新威胁/未解问题)提升追读留存。`;
      }
    }

    // H3 修复(第十五轮): 卷主线推进度(第 7 维),注入 volumeCtx.premise
    // 原: prompt 写"本章须推进本卷核心冲突",但质量门不校验 → LLM 可写高分章节但完全脱离卷主线
    // 现: 反查当前章所属卷,注入 premise + emotionArc,LLM 判断本章是否推进卷核心冲突
    const curVol = _state?.volumeOutlines?.find(v => chapterIdx >= v.chapterRange[0] && chapterIdx <= v.chapterRange[1]);
    const volMainLineBlock = curVol
      ? `\n【本卷核心冲突】第${curVol.idx + 1}卷《${curVol.title}》: ${curVol.premise}（情绪弧线: ${curVol.emotionArc}）`
      : '';
    const volMainLineHint = curVol
      ? `\n7. 卷主线推进度：本章是否推进了上方【本卷核心冲突】（0-1,完全脱离给 ≤0.3,部分推进给 0.5-0.7,核心推进给 0.9-1.0）`
      : `\n7. 卷主线推进度：无卷大纲,默认给 0.7（0-1）`;

    const prompt = `请判断以下章节正文是否符合大纲要求。

【章节信息】第 ${chapterIdx + 1} 章《${chapterTitle}》
【章节定位】${positioning || '未指定'}
【核心情绪】${coreEmotion || '未指定'}
【本章大纲】
${outline}${recycleBlock}${volMainLineBlock}${aiTasteBlock}${degenerationIssue}${emotionClusterIssue}${hookIssue}

【正文片段】（前 1500 字）
${content.slice(0, 1500)}

请从以下维度评分（0-1）：
1. 大纲符合度：是否完成大纲设定的情节点（0-1）
2. 章节定位符合度：是否体现 ${positioning || '通用'} 的特征（0-1）
3. 剧情推进度：是否有实质推进，非重复/非注水（0-1）
4. 人设一致性：角色行为是否符合前文人设（0-1，无法判断时给 0.7）${recycleHint}
6. AI 味度：本章是否仍含禁用副词/翻转句式/总结升华/排比三连等 AI 套路（0-1,0=全是 AI 味,1=完全原创）${volMainLineHint}

输出 JSON：{"score": <0-1 综合分,6 维平均(大纲+定位+推进+人设+伏笔+AI味+卷主线)>, "reason": "<一句话说明不符合之处>"}
只输出 JSON，不要其他文字。`;

    const ctxPrompt = buildContextPrompt(projectId);
    const systemStable = ctxPrompt
      ? `${ctxPrompt}\n\n你是严苛的网文质检编辑，擅长判断章节是否跑题与 AI 味。输出必须是合法 JSON。`
      : '你是严苛的网文质检编辑，擅长判断章节是否跑题与 AI 味。输出必须是合法 JSON。';
    const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];

    try {
      const { complete } = await import('./llm.js');
      const { text } = await complete({
        providerId, model, messages, systemStable, projectId,
        temperature: 0.3, maxTokens: Math.round(384 * tokenCharRatio(providerId)),  // 质检只需短输出，省 token；384 基础值×tokenCharRatio 适配国产模型避免 JSON 截断
      });
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (typeof parsed.score === 'number') {
          // H2: AI 味命中过多时,把综合分压低(避免 LLM 给高分但实际 AI 味重)
          const finalScore = aiTasteHits > 8 ? Math.min(parsed.score, aiTasteScore) : parsed.score;
          topicScore = finalScore;
          if (finalScore < 0.6) {
            issues.push(`跑题/AI 味风险：综合分 ${finalScore.toFixed(2)} < 0.6${parsed.reason ? `（${parsed.reason}）` : ''}`);
          } else if (finalScore < 0.8 && parsed.reason) {
            issues.push(`质量轻微不达标：${finalScore.toFixed(2)}（${parsed.reason}，不重写）`);
          }
        }
      }
    } catch (e) {
      // 质检 LLM 调用失败：不阻断生成，记 warn
      issues.push(`跑题门检测失败（LLM 调用异常：${(e as Error).message.slice(0, 80)}），跳过`);
    }
  }

  // —— 综合判定 ——
  // 第二十六轮: wordHardFail 按用户配置的上下限容差判定,覆盖"严重不足"和"严重超标"。
  //   字数门是生成中质量门的核心一环,该检测还是得检测(超容差触发重写压缩/补全)。
  const wordHardFail = actualLen < minHard || actualLen > hardMax;
  const topicHardFail = topicScore < 0.6;
  // 第二十五轮: 模型退化(末尾截断 / tier1 工程词泄漏)也触发重写
  // chapter_memo: 七段契约硬对账未兑现(伏笔 desc 关键词缺失/章末钩子缺失)也触发重写,
  //   missing 项已拼入 issues,重写时 LLM 会补齐(inkos hook 账本硬对账)
  const needRewrite = wordHardFail || topicHardFail || degenerationHardFail || memoHardFail;
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
// 章节定位六类分布（oh-story v0.6.20 升级: 区间占比而非硬配额,以下取区间中点作为基线）
//   高压 15-20%(取 18) / 普通 40-50%(取 45) / 试错 5-10%(取 8) / 关系 5-10%(取 8)
//   低压 ≤10%(取 10) / 信息 ≤5%(取 5),剩余补普通推进章
// 注:这是均衡/长书基线,非硬配额。番茄短平快/男频事业线高压可到 30%+、呼吸章压到 5%;
//   女频/世情/追妻关系/低压可更多。checkChapterQuality 另做「相邻情绪母题扎堆」运行时校验
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
//
// 升级1(卷级伏笔集群填充): 原 keyForeshadows 创建时为空,完全依赖 updateStateFromGeneration
//   事后增量填充。问题: 首次大纲生成后 LLM 在 buildDynamicContext 看不到本卷伏笔规划;
//   reconcileState/续写场景下 foreshadowing 已有数据时,卷创建时仍是空的,要等逐章回填才补全。
//   现: 接受可选 foreshadowing 参数,卷创建时按 chapterRange 预填:
//     · plantedAt 落在本卷的伏笔(埋设来源) → 加入该卷 keyForeshadows
//     · expectedRecycleAt 落在本卷的伏笔(预计回收规划) → 加入该卷 keyForeshadows
//   首次大纲生成时 foreshadowing 为空 → keyForeshadows 为空数组(正常,后续逐章增量填充)
//   reconcileState/续写时 foreshadowing 已有数据 → 创建即预填,LLM 立即可见本卷伏笔集群
export function buildVolumeOutlines(chapterCount: number, foreshadowing?: Foreshadow[]): VolumeOutline[] {
  const ranges = computeVolumeRanges(chapterCount);
  const fs = foreshadowing || [];
  return ranges.map((v, i) => {
    const [start, end] = v.range;
    // 收集本卷伏笔: plantedAt 落在本卷(埋设来源) + expectedRecycleAt 落在本卷(回收规划)
    const volKfs = new Set<string>();
    for (const f of fs) {
      const plantedInVol = f.plantedAt >= start && f.plantedAt <= end;
      const recycleInVol = typeof f.expectedRecycleAt === 'number'
        && f.expectedRecycleAt >= start && f.expectedRecycleAt <= end;
      if (plantedInVol || recycleInVol) volKfs.add(f.desc);
    }
    return {
      idx: i,
      title: `第${i + 1}卷`,
      premise: i === 0 ? '开篇立人设、抛核心冲突与主线伏笔' : (i === ranges.length - 1 ? '终局决战、回收所有主线伏笔、收束情绪弧线' : '中段推进、新伏笔集群、关系深化'),
      emotionArc: v.emotionArc,
      chapterRange: v.range,
      keyForeshadows: [...volKfs], // 预填: 来自 state.foreshadowing 的本卷伏笔集群(后续 updateStateFromGeneration 增量补充)
    };
  });
}

// H6 修复(第十四轮): 远期卷摘要真压缩
// oh-story: 远期内容应"按卷压缩",而非采样首/中/末章 + 截断 30 字
// 调用时机: daemon 在每卷所有章节完成后触发一次,把该卷所有章节摘要调 LLM 压缩成 3 句话
//   ① 本卷主线推进 ② 本卷伏笔状态(埋设/回收/过期) ③ 本卷角色弧线变化
// 缓存到 volumeOutlines[idx].compactedSummary,buildDynamicContext 优先用
// 幂等: 已有 compactedSummary 时跳过(避免重复压缩)
export async function compactVolumeSummary(
  projectId: string,
  model: string,
  providerId: string | undefined,
  volIdx: number,
): Promise<string | null> {
  const state = stateRepo.get(projectId);
  if (!state) return null;
  const vols = state.volumeOutlines || [];
  const vol = vols.find(v => v.idx === volIdx);
  if (!vol) return null;
  // 幂等: 已有压缩结果则跳过
  if (vol.compactedSummary) return vol.compactedSummary;
  // 取本卷所有已完成的章节摘要
  const summaries = (state.chapterSummaries || [])
    .filter(s => s.idx >= vol.chapterRange[0] && s.idx <= vol.chapterRange[1])
    .sort((a, b) => a.idx - b.idx);
  if (summaries.length < 3) return null;  // 不足 3 章不压缩(信息量太少)
  // 本卷涉及的伏笔(从 keyForeshadows + 全局 foreshadowing 落在本卷章序号区间的)
  const volForeshadows = (state.foreshadowing || [])
    .filter(f => f.plantedAt >= vol.chapterRange[0] && f.plantedAt <= vol.chapterRange[1])
    .map(f => `- ${f.desc}（${f.status}${f.paidAt != null ? `,第${f.paidAt + 1}章回收` : ''}）`)
    .slice(0, 10)
    .join('\n');
  // 本卷涉及的角色(从 characterState 全量,无法精确按卷过滤)
  // 第二十六轮修复(远期卷摘要角色取错段): 原 slice(0, 8) 取头部=最久未出场角色,
  //   characterState 经 splice+push 重排后数组末尾才是最近活跃角色(L178-179 注释已说明)。
  //   喂 LLM 最久未出场角色的状态生成"卷级角色弧线"对当前卷毫无指导意义。
  //   现改 slice(-8) 取最近活跃角色,与 buildDynamicContext 的 slice(-15) 一致。
  // 第二十六轮优化(角色热度四态): 有 recentAppearCount 时优先取热度高的角色(对当前卷更有指导意义),
  //   无热度字段(旧数据)降级到原 slice(-8)(数组末尾=最近活跃)。均取 8 个上限不变。
  const volCharsSource = state.characterState || [];
  const volHasHeat = volCharsSource.some(c => typeof c.lastSeenAt === 'number' || typeof c.recentAppearCount === 'number');
  const volCharsPicked = volHasHeat
    ? volCharsSource.slice().sort((a, b) => (b.recentAppearCount ?? 0) - (a.recentAppearCount ?? 0) || (b.lastSeenAt ?? -1) - (a.lastSeenAt ?? -1)).slice(0, 8)
    : volCharsSource.slice(-8);
  const volChars = volCharsPicked
    .map(c => `- ${c.name}：${c.location} / ${c.mood} / ${c.relationships}`)
    .join('\n');

  const prompt = `请把以下「第 ${volIdx + 1} 卷」的所有章节摘要压缩成 3 句话,用于长篇写作的远期记忆注入。

【卷信息】第 ${volIdx + 1} 卷《${vol.title}》(第 ${vol.chapterRange[0] + 1}-${vol.chapterRange[1] + 1} 章,情绪弧线 ${vol.emotionArc})
【卷核心冲突】${vol.premise}

【本卷各章摘要（共 ${summaries.length} 章）】
${summaries.map(s => `第${s.idx + 1}章《${s.title}》${s.positioning ? `[${POSITIONING_META[s.positioning].label}]` : ''}${s.coreEmotion ? `「${s.coreEmotion}」` : ''}：${s.summary}`).join('\n')}

【本卷伏笔状态】
${volForeshadows || '（无）'}

【本卷角色状态】
${volChars || '（无）'}

输出格式（3 句话,每句不超过 80 字,不要其他文字）：
1. 主线推进：本卷主线发生了什么关键事件、推进到什么程度
2. 伏笔状态：本卷埋设/回收/过期了哪些关键伏笔
3. 角色弧线：本卷主要角色的弧线变化（位置/关系/能力/情绪转折）`;

  const ctxPrompt = buildContextPrompt(projectId);
  const systemStable = ctxPrompt
    ? `${ctxPrompt}\n\n你是长篇小说一致性管理者,擅长把长篇章节摘要压缩成信息密度高的卷级总览。输出 3 句话,不要 markdown。`
    : '你是长篇小说一致性管理者,擅长把长篇章节摘要压缩成信息密度高的卷级总览。输出 3 句话,不要 markdown。';
  const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];
  const { complete } = await import('./llm.js');
  try {
    const { text } = await complete({ providerId, model, messages, systemStable, projectId, temperature: 0.3, maxTokens: 512 });
    const compacted = text.trim().slice(0, 500);  // 3 句话约 200-300 字,上限 500 防止 LLM 输出超长
    if (compacted.length < 30) return null;  // 输出过短视为失败
    // 落库到 volumeOutlines[idx].compactedSummary
    const updatedVols = vols.map(v => v.idx === volIdx ? { ...v, compactedSummary: compacted } : v);
    stateRepo.update(projectId, { volumeOutlines: updatedVols });
    return compacted;
  } catch {
    return null;  // 静默失败,不阻断主流程
  }
}

// 单次 LLM 调用生成大纲的安全章数阈值。
// 超过此阈值会触发分卷生成：每卷 20 章，逐卷调 LLM 后合并。
// 依据：每章 JSON ≈ 130 tokens × 200 章 = 26000 tokens，cap 32000 仍有余量
const OUTLINE_SINGLE_CALL_MAX_CHAPTERS = 200;

// 单卷大纲生成（被 generateOutline 编排，也可独立用于小卷）
// 单卷失败时本地重试 1 次：避免单卷瞬时抖动导致整个 book 任务重试（重试会从 checkpoint 续传，但浪费已成功卷的 LLM 调用）
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
  chapterWordBudget?: number;  // 每章字数预算（默认 2500，影响 prompt 中的"每章约 X 字"提示）
  // H3 修复(第十九轮): 每章字数上下限,不传则按 budget*0.8/1.2 计算
  chapterWordMin?: number;
  chapterWordMax?: number;
}): Promise<ParsedOutlineItem[]> {
  const { projectId, model, providerId, config, idea, volIndex, volTotal, volChapterCount, globalStartIdx, emotionArc, premiseHint, prevVolumeTail, webSearch } = opts;
  const chapterWordBudget = opts.chapterWordBudget ?? 2500;
  // H3 修复(第十九轮): 用用户配置的上下限替代硬编码 budget*0.8/1.2
  const chapterWordMin = opts.chapterWordMin ?? Math.round(chapterWordBudget * 0.8);
  const chapterWordMax = opts.chapterWordMax ?? Math.round(chapterWordBudget * 1.2);
  const dist = computePositioningDistribution(volChapterCount);
  const distLine = `高压章 ${dist['high-pressure']} 章 / 普通推进章 ${dist['normal-progress']} 章 / 修炼试错章 ${dist['trial-error']} 章 / 关系回收章 ${dist['relationship']} 章 / 低压生活章 ${dist['low-pressure']} 章 / 信息整理章 ${dist['info-organize']} 章`;

  const prompt = `请为以下小说生成「第 ${volIndex + 1} 卷」的细纲（本卷共 ${volChapterCount} 章，每章约 ${chapterWordMin}-${chapterWordMax} 字；全书第 ${globalStartIdx + 1}-${globalStartIdx + volChapterCount} 章；全书共 ${volTotal} 卷）。

【核心创意】${idea}
【题材风格】${config.genre}${buildGenreHint(config)}${buildToneHint(config)}
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
- 【内容忠实度约束】（最高优先级）：章细必须严格依据【核心创意】【主要角色】【世界观设定】展开，不得擅自新增角色/能力体系/世界观规则/主线支线；若方法论约束（黄金三章/矛盾网/positioning 配额）与用户创意冲突，以用户创意为准，方法论仅作参考
- 节奏紧凑，每章都有推进与爽点
- 伏笔与回收交织（标 positioning=relationship 的章必须回收至少 1 个前文伏笔）
- positioning 分布严格符合上方约束
- 【字数预算Σ契约】(oh-story v0.6.19):每章大纲 outline 末尾标注本章情节点密/疏配比,如"密点×2(爽点/反转,各≥250字) + 疏点×3(过场,各≈40字)";密点展开写、疏点带过,Σ 落在[${chapterWordMin}, ${chapterWordMax}]内
- 【文风密度配比】当前文风为「${config.tone || '正剧'}」,按其 emotionDensity 调整每章密疏点配比建议：${buildToneDensityHint(config)}(示例配比,可按章节定位微调,但总体倾向须符合文风)
- 【黄金三章】第1章大纲必须 800 字内触发主线冲突且前 300 字最后一句反转;第2章金手指"做出来";第3章锁定可量化短期目标
- 【矛盾网三层】全书保持 2-3 条矛盾线同时运行(章级 2-3 章解决/卷级卷末解决/书级大结局解决),每次解决一个矛盾必须激活或加深另一个
- 只输出 JSON，不要其他文字`;

  const ctxPrompt = buildContextPrompt(projectId);
  const systemStable = ctxPrompt
    ? `${ctxPrompt}\n\n你是大纲架构师，遵循 oh-story-claudecode 长篇方法论。输出必须是合法 JSON 数组。`
    : '你是大纲架构师，遵循 oh-story-claudecode 长篇方法论。输出必须是合法 JSON 数组。';
  const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];
  const { complete } = await import('./llm.js');
  // 第二十六轮修复(分卷大纲截断BUG,与单次分支89章BUG同源): 原 chapterCount * 200 + 下限 4096
  //   偏低,单卷 20 章 × ~300 tokens/章(含Σ契约注解) = 6000 > 4096,LLM 截断 → parseOutline
  //   救出 17-19 章 → L1547 章数校验 throw → 本地重试 2 次 maxTokens 不变仍截断 → daemon
  //   重试耗尽 failed。现与单次分支(L1468)一致: 系数 350 + 下限 8192。
  //   20 章 → max(8192, 7000) = 8192,留足余量,截断不再发生。
  const volMaxTokens = Math.min(16384, Math.max(8192, volChapterCount * 350));
  // 单卷输出 ~3000 tokens，正常 30-90s，给 8 分钟 wall timeout 容忍长上下文处理
  const volWallTimeout = 8 * 60 * 1000;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await complete({
        providerId, model, messages, systemStable, projectId, temperature: 0.8, maxTokens: volMaxTokens,
        webSearch,
        searchQuery: webSearch ? `${config.genre} ${idea.slice(0, 30)} 大纲 套路 第${volIndex + 1}卷` : undefined,
        wallTimeoutMs: volWallTimeout,
      });
      const parsed = parseOutline(text);
      if (parsed.length > 0) return parsed;
      lastErr = new Error(`第 ${volIndex + 1} 卷大纲解析为空（LLM 未输出合法 JSON 数组）`);
    } catch (e) {
      lastErr = e as Error;
    }
    // 第 1 次失败时记录但不抛错，继续第 2 次尝试
  }
  // 本地重试 2 次都失败 → 抛错让上层（daemon）走断点续传重试
  throw lastErr ?? new Error(`第 ${volIndex + 1} 卷大纲生成失败`);
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
  /**
   * 断点续传：已生成卷的累积 chapters（JSON 字符串解析后的数组）。
   * daemon 在重试时把已完成的卷数据传入，本函数从对应卷继续生成。
   * 缺省（首次生成）传 undefined。
   */
  prevVolumes?: ParsedOutlineItem[];
  /**
   * checkpoint 回写钩子：每完成一卷后调用，让 daemon 持久化进度。
   * 接收当前已完成卷的累积 chapters 与已完成卷数。
   */
  onVolumeCheckpoint?: (accumulated: ParsedOutlineItem[], doneVolumes: number, totalVolumes: number) => void;
  /** 每章字数预算：影响章数估算与 prompt 中的"每章约 X 字"提示，默认 2500 */
  chapterWordBudget?: number;
  // H3 修复(第十九轮): 每章字数上下限,不传则按 budget*0.8/1.2 计算
  chapterWordMin?: number;
  chapterWordMax?: number;
}): Promise<string> {
  const { projectId, model, providerId, targetWords, config, idea, webSearch, onVolumeProgress, prevVolumes, onVolumeCheckpoint } = opts;
  // 每章字数预算：用户可配置，默认 2500（影响章数估算与 prompt 中的字数提示）
  const chapterWordBudget = opts.chapterWordBudget ?? 2500;
  // H3 修复(第十九轮): 用用户配置的上下限替代硬编码 budget*0.8/1.2
  const chapterWordMin = opts.chapterWordMin ?? Math.round(chapterWordBudget * 0.8);
  const chapterWordMax = opts.chapterWordMax ?? Math.round(chapterWordBudget * 1.2);
  const chapterCount = Math.max(1, Math.ceil(targetWords / chapterWordBudget));

  // —— 单次调用足够时走原逻辑（小卷，<= 200 章）——
  if (chapterCount <= OUTLINE_SINGLE_CALL_MAX_CHAPTERS) {
    // 单次大纲生成无法中途断点（一次 LLM 调用），但重试时如果 prevVolumes 已有数据则直接返回
    if (prevVolumes && prevVolumes.length >= chapterCount) {
      return JSON.stringify(prevVolumes);
    }
    const dist = computePositioningDistribution(chapterCount);
    const volumes = computeVolumeRanges(chapterCount);
    const distLine = `高压章 ${dist['high-pressure']} 章 / 普通推进章 ${dist['normal-progress']} 章 / 修炼试错章 ${dist['trial-error']} 章 / 关系回收章 ${dist['relationship']} 章 / 低压生活章 ${dist['low-pressure']} 章 / 信息整理章 ${dist['info-organize']} 章`;
    const volLine = volumes.length > 0
      ? `\n【卷纲】共 ${volumes.length} 卷，每卷 ~20 章，卷情绪弧线依次：${volumes.map((v, i) => `第${i + 1}卷(${v.range[0] + 1}-${v.range[1] + 1}章,${v.emotionArc})`).join('；')}`
      : '';
    const prompt = `请为以下小说生成细纲（共 ${chapterCount} 章，每章约 ${chapterWordMin}-${chapterWordMax} 字）。

【核心创意】${idea}
【题材风格】${config.genre}${buildGenreHint(config)}${buildToneHint(config)}
【主要角色】${config.characters}
【钩子风格】${config.hookStyle}
【节奏要求】${config.pace}
【结局走向】${config.ending}

【章节定位六类分布约束】（oh-story：防止每章都像短篇、防止情绪扎堆）
${distLine}
按上述分布为每章分配 positioning，不得让高压章连续超过 2 章，不得让低压章连续超过 2 章。${volLine}

要求：
- 输出 JSON 数组，每个元素：{"title":"章节标题","outline":"本章大纲(50-100字)","hook":"章末钩子","positioning":"high-pressure|normal-progress|trial-error|relationship|low-pressure|info-organize","coreEmotion":"本章核心情绪(爽感释放/震撼/痛快/怅然/燃/治愈/期待/心动等)"}
- 【内容忠实度约束】（最高优先级）：章细必须严格依据【核心创意】【主要角色】【世界观设定】展开，不得擅自新增角色/能力体系/世界观规则/主线支线；若方法论约束（黄金三章/矛盾网/positioning 配额）与用户创意冲突，以用户创意为准，方法论仅作参考
- 节奏紧凑，每章都有推进与爽点
- 伏笔与回收交织（标 positioning=relationship 的章必须回收至少 1 个前文伏笔）
- positioning 分布严格符合上方约束
- 【字数预算Σ契约】(oh-story v0.6.19):每章大纲 outline 末尾标注本章情节点密/疏配比,如"密点×2(爽点/反转,各≥250字) + 疏点×3(过场,各≈40字)";密点展开写、疏点带过,Σ 落在[${chapterWordMin}, ${chapterWordMax}]内
- 【文风密度配比】当前文风为「${config.tone || '正剧'}」,按其 emotionDensity 调整每章密疏点配比建议：${buildToneDensityHint(config)}(示例配比,可按章节定位微调,但总体倾向须符合文风)
- 【黄金三章】第1章大纲必须 800 字内触发主线冲突且前 300 字最后一句反转;第2章金手指"做出来";第3章锁定可量化短期目标
- 【矛盾网三层】全书保持 2-3 条矛盾线同时运行(章级 2-3 章解决/卷级卷末解决/书级大结局解决),每次解决一个矛盾必须激活或加深另一个
- 只输出 JSON，不要其他文字`;

    const ctxPrompt = buildContextPrompt(projectId);
    const systemStable = ctxPrompt
      ? `${ctxPrompt}\n\n你是大纲架构师，遵循 oh-story-claudecode 长篇方法论。输出必须是合法 JSON 数组。`
      : '你是大纲架构师，遵循 oh-story-claudecode 长篇方法论。输出必须是合法 JSON 数组。';
    const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];
    const { complete } = await import('./llm.js');
    // 第二十六轮修复(89章BUG 根因#1): 原 chapterCount * 150 估算偏低,实际每章 JSON
    //   (title + outline 50-100字 + hook + positioning + coreEmotion + Σ契约密疏点注解 + JSON结构)
    //   约 200-340 tokens/章。150 系数导致 120 章仅给 18000 tokens,LLM 在 ~89 章处被
    //   max_tokens 截断,parseOutline 截断兜底救出 89 章后被单次分支静默接受(根因#2)。
    //   现改 350 tokens/章(按实际上限 340 + 余量),120 章 → 42000 tokens(被 cap 到 32000),
    //   按 ~250 tokens/章中位数算可完整输出 ~128 章 > 120,截断不再发生。
    //   注: cap 32000 对 >150 章场景仍可能不足(200章需 50000+),此时校验#2 会抛错,
    //   daemon 重试仍截断则 maxRetries 耗尽失败(不再静默少章),用户可改用更大 budget
    //   降章数或接受分卷生成(>200 章自动走分卷分支,有单卷章数校验)。
    const outlineMaxTokens = Math.min(32000, Math.max(8192, chapterCount * 350));
    // 200 章输出 ~30000 tokens，正常 2-5 分钟，给 12 分钟 wall timeout 避免误杀（远超 5 分钟默认）
    const outlineWallTimeout = chapterCount > 100 ? 12 * 60 * 1000 : 8 * 60 * 1000;
    const { text: acc } = await complete({
      providerId, model, messages, systemStable, projectId, temperature: 0.8, maxTokens: outlineMaxTokens,
      webSearch,
      searchQuery: webSearch ? `${config.genre} ${idea.slice(0, 30)} 大纲 套路` : undefined,
      wallTimeoutMs: outlineWallTimeout,
    });
    // 第二十六轮修复(滑动窗口 JSON.parse 失败): 原返回 match[0](LLM 原始子串)，
    //   state.outline 可能含尾随逗号/代码块标记/额外字段 → buildContextPrompt 的
    //   JSON.parse(state.outline)(L84)失败降级到前 4000 字截断 → 章节生成时
    //   滑动窗口失效,LLM 看不到±5邻章大纲,跨章一致性差,间接放大章细偏离。
    //   现与分卷分支一致,走 parseOutline 标准化后 JSON.stringify,确保 state.outline
    //   始终是严格合法 JSON,滑动窗口稳定生效。parseOutline 已增强兼容(嵌套/字段变体)。
    const parsed = parseOutline(acc);
    if (parsed.length > 0) {
      // 第二十六轮修复(89章BUG 根因#2): 单次分支加章数校验,防 LLM 输出被 maxTokens
      //   截断后 parseOutline 救出部分章节被静默接受(原只检查 length>0,89/120 也会通过)。
      //   参照分卷分支 L1527-1529 的 throw 保护:低于期望章数 90% 视为截断,抛错让 daemon
      //   重试(配合根因#1 提高系数,重试时 maxTokens 足够完整输出)。允许 10% 浮动避免
      //   LLM 自然少输出 1-2 章时误触发重试。重试仍截断则 maxRetries 耗尽 → 任务 failed,
      //   不再静默少章误导用户。
      if (parsed.length < chapterCount * 0.9) {
        throw new Error(`大纲章节数不足：${parsed.length}/${chapterCount}（LLM 输出可能被 maxTokens 截断，已提高 token 预算并重试）`);
      }
      return JSON.stringify(parsed);
    }
    // 兜底: parseOutline 全失败时仍返回原始子串(至少 daemon.ts 会再 parse 一次+诊断)
    const match = acc.match(/\[[\s\S]*\]/);
    return match ? match[0] : acc;
  }

  // —— 分卷生成（超长篇，> 200 章）——
  // 500 万字 = 2000 章 = 100 卷，单卷 20 章逐次调 LLM 后合并
  // 解决：原单次调用 maxTokens cap 32000 只能产 ~213 章 JSON，超长篇必然截断
  // 断点续传：prevVolumes 已有 N 卷数据时，从第 N+1 卷继续生成（避免重试从头开始永远卡在同一卷）
  const volumes = computeVolumeRanges(chapterCount);
  const allChapters: ParsedOutlineItem[] = prevVolumes ? [...prevVolumes] : [];
  // 跳过已完成的卷（基于已累积的章节数推算）
  let startVolIdx = 0;
  if (allChapters.length > 0) {
    const doneChapters = allChapters.length;
    startVolIdx = Math.floor(doneChapters / 20);  // 每 20 章一卷
    // 已完成的卷数也回写日志
    if (startVolIdx > 0 && onVolumeProgress) {
      for (let i = 0; i < startVolIdx; i++) onVolumeProgress(i + 1, volumes.length);
    }
  }
  const volPremiseHints = (i: number) =>
    i === 0 ? '开篇立人设、抛核心冲突与主线伏笔' :
    (i === volumes.length - 1 ? '终局决战、回收所有主线伏笔、收束情绪弧线' :
    '中段推进、新伏笔集群、关系深化');

  for (let vi = startVolIdx; vi < volumes.length; vi++) {
    const vol = volumes[vi];
    const volChapterCount = vol.range[1] - vol.range[0] + 1;
    const prevTail = allChapters.length > 0
      ? `第 ${allChapters.length} 章《${allChapters[allChapters.length - 1].title}》：${allChapters[allChapters.length - 1].outline}\n章末钩子：${allChapters[allChapters.length - 1].hook}`
      : undefined;

    const volChapters = await generateOutlineForVolume({
      projectId, model, providerId, config, idea,
      volIndex: vi, volTotal: volumes.length,
      volChapterCount, globalStartIdx: vol.range[0],
      emotionArc: vol.emotionArc, premiseHint: volPremiseHints(vi),
      prevVolumeTail: prevTail, webSearch,
      chapterWordBudget,
      // H3 修复(第十九轮): 透传用户配置的上下限
      chapterWordMin, chapterWordMax,
    });

    if (volChapters.length === 0) {
      // 单卷解析失败：抛错让 daemon 走重试，不静默吞掉
      throw new Error(`第 ${vi + 1} 卷大纲解析失败（LLM 输出未含合法 JSON 数组）`);
    }
    // BUG-6 修复：单卷返回章节数不足时也抛错（本地重试 2 次都返回不足才到这）
    // 原代码：只检查 length===0，LLM 输出被截断返回 15/20 章时会被静默 push，
    //   checkpoint 回写不完整的卷，重试时该卷被覆盖重做，且后续章节错位
    if (volChapters.length < volChapterCount) {
      throw new Error(`第 ${vi + 1} 卷大纲章节数不足：${volChapters.length}/${volChapterCount}（LLM 输出可能被截断）`);
    }
    allChapters.push(...volChapters);
    onVolumeProgress?.(vi + 1, volumes.length);
    // 每完成一卷回写 checkpoint：daemon 重试时从该卷后继续，避免从头开始
    onVolumeCheckpoint?.(allChapters, vi + 1, volumes.length);
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
  // 第二十六轮修复(大纲解析失败重试3次放弃): 原 parseOutline 失败时静默返回 [],
  //   daemon.ts:435 拿到空数组抛"大纲解析失败",重试时解析同一个已持久化的 outline 字符串
  //   → 必然 3 次都失败(内容不变结果不变)。增强解析兼容性 + 失败时打诊断日志。
  //   常见 LLM 输出格式问题:
  //   1. 数组被包在对象里: {"volumes":[...]} 或 {"chapters":[...]} 或 {"outline":[...]}
  //      原 /\[[\s\S]*\]/ 贪婪匹配可能拿到非章节数组(如 volumes 数组,元素无 title 字段)
  //   2. 字段名变体: chapterTitle/name/章名/章节名 而非 title → filter 全部丢弃
  //   3. ```json 代码块包裹 + 末尾多余说明文字
  //   4. maxTokens 截断未闭合 ] (原有兜底,保留)
  const diag = { rawLen: json.length, head: json.slice(0, 200), reason: '' };
  try {
    // 1. 正常路径：完整 [...] 数组
    const match = json.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) {
          const items = parseOutlineArray(arr);
          if (items.length > 0) return items;
          // 数组 parse 成功但 filter 全空 → 可能字段名不匹配,尝试宽松映射
          const loose = parseOutlineArrayLoose(arr);
          if (loose.length > 0) {
            console.warn(`[parseOutline] 严格字段校验全空,宽松映射恢复 ${loose.length} 项(原 ${arr.length} 项)。原文头部: ${diag.head}`);
            return loose;
          }
          diag.reason = `数组 parse 成功但 title 字段全空(arr.length=${arr.length})`;
        } else {
          diag.reason = '匹配到 [...] 但 JSON.parse 结果非数组';
        }
      } catch (e1) {
        diag.reason = `匹配到 [...] 但 JSON.parse 失败: ${(e1 as Error).message}`;
      }
    } else {
      diag.reason = '未匹配到 [...] 数组';
    }

    // 1.5 兼容:数组被包在对象里。找含 title/chapterTitle 字段最多的数组(递归一层)
    //    覆盖 {"volumes":[{"chapters":[...]}]} / {"chapters":[...]} 等
    if (diag.reason.includes('title') || diag.reason.includes('非数组') || diag.reason.includes('未匹配')) {
      try {
        const obj = JSON.parse(json.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, ''));
        const nested = findChapterArrayInObject(obj);
        if (nested && nested.length > 0) {
          const items = parseOutlineArray(nested);
          if (items.length > 0) {
            console.warn(`[parseOutline] 顶层是对象,从嵌套数组恢复 ${items.length} 项。原文头部: ${diag.head}`);
            return items;
          }
          const loose = parseOutlineArrayLoose(nested);
          if (loose.length > 0) {
            console.warn(`[parseOutline] 嵌套数组+宽松映射恢复 ${loose.length} 项。原文头部: ${diag.head}`);
            return loose;
          }
        }
      } catch { /* 不是对象,继续兜底 */ }
    }

    // 2. 截断兜底：LLM 输出被 maxTokens 截断没闭合 ] 时，从首个 [ 起尝试 parse
    //    用「从后向前找对象边界」策略，避免裸 lastOfDay('}') 在字符串值含 } 时误判
    const start = json.indexOf('[');
    if (start < 0) {
      if (!diag.reason) diag.reason = '未找到 [ 起始符';
      console.warn(`[parseOutline] 解析失败(${diag.reason})。原文长度=${diag.rawLen} 头部=${diag.head}`);
      return [];
    }
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
        if (Array.isArray(arr) && arr.length > 0) {
          const items = parseOutlineArray(arr);
          if (items.length > 0) return items;
          const loose = parseOutlineArrayLoose(arr);
          if (loose.length > 0) {
            console.warn(`[parseOutline] 截断兜底+宽松映射恢复 ${loose.length} 项。原文头部: ${diag.head}`);
            return loose;
          }
        }
      } catch {
        // 继续尝试更早的边界
      }
    }
    if (!diag.reason) diag.reason = '截断兜底也未能 parse 出非空数组';
    console.warn(`[parseOutline] 全部解析路径失败(${diag.reason})。原文长度=${diag.rawLen} 头部=${diag.head}`);
    return [];
  } catch (e) {
    console.warn(`[parseOutline] 顶层异常: ${(e as Error).message}。原文长度=${diag.rawLen} 头部=${diag.head}`);
    return [];
  }
}

// 第二十六轮修复: 在对象里递归找"看起来像章节数组"的数组(含 title/chapterTitle 字段的对象居多)
//   覆盖 {"volumes":[{"chapters":[...]}]} / {"data":{"chapters":[...]}} 等
function findChapterArrayInObject(obj: unknown, depth = 0): unknown[] | null {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  if (Array.isArray(obj)) {
    // 检查数组元素是否像章节(至少 1/3 元素含 title/chapterTitle 字段)
    if (obj.length > 0) {
      const chapterLike = obj.filter(x => x && typeof x === 'object' && (
        typeof (x as any).title === 'string' ||
        typeof (x as any).chapterTitle === 'string' ||
        typeof (x as any).name === 'string'
      )).length;
      if (chapterLike >= Math.max(1, Math.ceil(obj.length / 3))) return obj;
    }
    return null;
  }
  // 对象:递归每个数组类型字段
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      const found = findChapterArrayInObject(v, depth + 1);
      if (found) return found;
    } else if (v && typeof v === 'object') {
      const found = findChapterArrayInObject(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
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

// 第二十六轮修复(parseOutline 宽松映射): 严格字段校验全空时回退到此函数。
//   兼容 LLM 输出字段名变体:
//   title: title / chapterTitle / name / chapterName / 章名 / 章节名 / 章节标题
//   outline: outline / summary / desc / description / 大纲 / 摘要 / 内容
//   hook: hook / 章末钩子 / cliffhanger
//   positioning: positioning / 定位 / chapterType / type
//   coreEmotion: coreEmotion / emotion / 情绪 / core_emotion
function parseOutlineArrayLoose(arr: unknown[]): ParsedOutlineItem[] {
  const validPositioning: ChapterPositioning[] = ['high-pressure', 'normal-progress', 'trial-error', 'relationship', 'low-pressure', 'info-organize'];
  const pickStr = (x: any, keys: string[]): string => {
    for (const k of keys) {
      const v = x?.[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  };
  return arr
    .map(x => {
      if (!x || typeof x !== 'object') return null;
      const title = pickStr(x as any, ['title', 'chapterTitle', 'name', 'chapterName', '章名', '章节名', '章节标题', '章标题']);
      if (!title) return null;  // 标题是必须的,没有则跳过
      const outline = pickStr(x as any, ['outline', 'summary', 'desc', 'description', '大纲', '摘要', '内容', 'chapterOutline']);
      const hook = pickStr(x as any, ['hook', '章末钩子', 'cliffhanger', '钩子']);
      const item: ParsedOutlineItem = { title, outline, hook };
      const posRaw = pickStr(x as any, ['positioning', '定位', 'chapterType', 'type']);
      if (posRaw && validPositioning.includes(posRaw as ChapterPositioning)) {
        item.positioning = posRaw as ChapterPositioning;
      }
      const emo = pickStr(x as any, ['coreEmotion', 'emotion', '情绪', 'core_emotion', '核心情绪']);
      if (emo) item.coreEmotion = emo.slice(0, 20);
      return item;
    })
    .filter((x): x is ParsedOutlineItem => x !== null);
}

// ============ oh-story 章节定位六类分布校验 ============
// H3 修复(第十三轮): 原 computePositioningDistribution 算出目标分布仅注入 prompt 文字约束,
// LLM 完全可全部输出 normal-progress,引擎不会发现 → oh-story 节奏控制方法论形同虚设
// 本函数统计实际计数,与目标比例比较,偏差 > 30% 时返回 warn 描述(由调用方打 task_log)
// 不强制重生成,避免 LLM 卡死循环;仅打日志让用户可见,后续可人工介入调整大纲
// 第二十五轮优化(oh-story v0.6.20): 固定百分比 → 区间占比校验
//   旧版用固定 0.18/0.45/0.08/0.08/0.10/0.05 + 绝对偏差 0.30 判定 → 题材分档时误报
//   (番茄短平快高压可到 30%+,女频关系/低压可更多)。新版按区间上下界判定:
//   超过区间上界才告警(高压过多/信息章过多),低于下界且为非普通推进章才告警(缺呼吸/缺关系)
export function checkPositioningDistribution(items: ParsedOutlineItem[]): {
  ok: boolean;
  actual: Record<ChapterPositioning, number>;
  target: Record<ChapterPositioning, number>;
  warnings: string[];
} {
  const total = items.length;
  const actual: Record<ChapterPositioning, number> = {
    'high-pressure': 0, 'normal-progress': 0, 'trial-error': 0,
    'relationship': 0, 'low-pressure': 0, 'info-organize': 0,
  };
  for (const it of items) {
    if (it.positioning && actual[it.positioning] !== undefined) actual[it.positioning]++;
  }
  const target = computePositioningDistribution(total);
  const warnings: string[] = [];
  // 第二十五轮: 改区间占比校验(oh-story v0.6.20)。区间=[下,上],单位为占比
  //   高压 15-20% / 普通 40-50% / 试错 5-10% / 关系 5-10% / 低压 ≤10% / 信息 ≤5%
  //   普通/试错/关系"低于下界"不告警(题材可能本就少),仅"高压/信息超过上界"告警,
  //   避免题材分档(番茄高压多/女频关系多)的误报
  const RATIO_RANGE: Record<ChapterPositioning, [number, number]> = {
    'high-pressure': [0.15, 0.30],     // 上界放宽到 30%(番茄分档)
    'normal-progress': [0.30, 0.60],  // 区间放宽
    'trial-error': [0.02, 0.15],
    'relationship': [0.02, 0.20],
    'low-pressure': [0.00, 0.15],
    'info-organize': [0.00, 0.08],     // 信息章上界 8%
  };
  for (const k of Object.keys(actual) as ChapterPositioning[]) {
    if (total === 0) continue;
    const actualRatio = actual[k] / total;
    const hi = RATIO_RANGE[k][1];
    if (actualRatio > hi + 0.05) {  // 超区间上界 +5% 容差才告警
      warnings.push(
        `${POSITIONING_META[k].label}实际 ${actual[k]} 章(${(actualRatio * 100).toFixed(0)}%)超过区间上界 ${(hi * 100).toFixed(0)}%,节奏可能失衡`,
      );
    }
  }
  // 无 positioning 的章节也算异常(若 LLM 全没输出 positioning,actual 全 0)
  const noPositioningCount = items.filter(it => !it.positioning).length;
  if (noPositioningCount > total * 0.5) {
    warnings.push(`${noPositioningCount}/${total} 章未分配 positioning(LLM 未遵守 oh-story 章节定位约束)`);
  }
  return { ok: warnings.length === 0, actual, target, warnings };
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
): Promise<{ issues: string[] }> {
  const chapters = chapterRepo.listByProject(projectId).filter(c => c.content);
  if (chapters.length === 0) return { issues: [] };
  // H1 修复(第十六轮): 收集 issues 让 daemon 层 warn 可见
  // 原: catch{} 静默吞错,LLM 返回非法 JSON 时 daemon 不触发 try/catch → 用户无感知状态更新失败
  // 现: 函数返回 issues 数组,catch 改 throw 让 daemon 接管 warn 日志
  const issues: string[] = [];

  const state = stateRepo.get(projectId);
  const curForeshadowing = state?.foreshadowing || [];
  const curCharacters = state?.characterState || [];
  const curSummaries = state?.chapterSummaries || [];

  // 只针对刚完成的那章做摘要（避免重复提炼全本，省 token）
  const target = typeof justFinishedChapterIdx === 'number'
    ? chapters.find(c => c.orderIdx === justFinishedChapterIdx)
    : chapters[chapters.length - 1];
  if (!target) return { issues };

  // 已有摘要就跳过（避免重复提炼覆盖已记录的定位/字数）
  if (curSummaries.some(s => s.idx === target.orderIdx)) return { issues };

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
  "newForeshadows": [{"desc": "本章新埋设的伏笔描述", "plantedAt": ${target.orderIdx}, "importance": "high|mid|low", "expectedRecycleAt": 预计回收章序号(主线伏笔建议 ${target.orderIdx + 5}-${target.orderIdx + 15} 章后回收,支线 ${target.orderIdx + 3}-${target.orderIdx + 8} 章,长线伏笔可设 ${target.orderIdx + 20}-${target.orderIdx + 30} 章或 null)}],
  "paidForeshadowDescs": ["本章回收的伏笔描述（尽量匹配已有伏笔的 desc 原文,允许小幅出入）"],
  "characterState": [{"name": "角色名", "location": "当前所在", "mood": "情绪状态", "relationships": "与他人当前关系"}],
  "emotionBeats": [{"type": "心动|靠近|误解|分离|和好|升华|日常糖|虐点", "characters": ["CP角色名1","CP角色名2"], "desc": "本章情感节点描述(8-30字)"}],
  "conflictLines": [{"id": "c-{章节}-{序号}", "desc": "本章矛盾描述", "level": "chapter|volume|book", "status": "active|resolved|escalated", "introducedAt": 引入章序号, "resolvedAt": 解决章序号(仅resolved填), "escalatedTo": "升级到的矛盾id(解决一个矛盾必须激活或加深另一个,防单元剧化)"}],
  "memory": "更新后的全局记忆（已发生关键事件+伏笔+待回收点），200 字内"
}
注意:emotionBeats/conflictLines 为可选字段,本章确有情感节点/矛盾状态变化时才输出,无则省略或输出空数组。CP向作品(甜宠/虐恋)优先输出 emotionBeats;所有题材都应输出 conflictLines(若本章有矛盾引入/解决/升级)。`;
  // M7 修复(第十四轮): expectedRecycleAt 加预算引导 + paidForeshadowDescs 允许小幅出入
  // 原: prompt 仅说"预计回收章序号或null",LLM 不知该填多少 → 经常不填或乱填
  //   → 过期检测失效(无 expectedRecycleAt 时只能用统一容忍期,主线/支线不分级)
  //   → paidDescs 全等匹配失败(M5 已修),prompt 也提示"允许小幅出入"双保险

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
    if (!jsonStr) return { issues };
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
    // M5 修复(第十四轮): paid 匹配改 fuzzyMatch,防 LLM 输出 desc 与 planted desc 略有出入时全等失败
    // 原: paidDescs.includes(f.desc) 字符串全等 → LLM 漏字/换词/截断时伏笔永远不标 paid → 长篇伏笔堆积
    // 现: 双向 includes + 短串长度门槛(>=4 字符) 避免短串误匹配(如"剑"误中所有含"剑"的 desc)
    let foreshadowing = [...curForeshadowing];
    const paidDescs: string[] = Array.isArray(parsed.paidForeshadowDescs) ? parsed.paidForeshadowDescs : [];
    if (paidDescs.length > 0) {
      foreshadowing = foreshadowing.map(f => {
        const hit = paidDescs.some(d => {
          if (!d) return false;
          // L2 修复(第十七轮): 短 desc(< 4 字符,如「剑」「玉佩」)走精确全等,避免误匹配也避免跳过
          // 原: d.length < 4 直接 return false → 短伏笔永远命中失败 → 永远 planted → 最终 expired
          // 现: 短串精确全等,既避免「剑」误中所有含「剑」的 desc,又能让短伏笔正常回收
          if (d.length < 4) return f.desc === d;
          return f.desc.includes(d) || d.includes(f.desc);
        });
        return hit ? { ...f, status: 'paid' as const, paidAt: target.orderIdx } : f;
      });
    }
    if (Array.isArray(parsed.newForeshadows)) {
      for (const nf of parsed.newForeshadows) {
        if (!nf?.desc) continue;
        // H2 修复(第十六轮): 过期伏笔被误埋检测
        // oh-story: expired 伏笔「不可再埋」,但 LLM 后期可能"忘记"已过期伏笔而重新埋设相同 desc
        // 原: newForeshadows 仅用全等去重(f.desc === nf.desc),不查 expired 列表 → 重复条目
        // 现: 用 fuzzyMatch(双向 includes) 对比 expired 伏笔 desc,命中则跳过 push + 记 warn
        const expiredList = foreshadowing.filter(f => f.status === 'expired');
        const isExpiredDuplicate = expiredList.some(f => {
          if (!nf.desc) return false;
          // L2 修复(第十七轮): 短 desc 走精确全等,避免短伏笔跳过误埋检测
          if (nf.desc.length < 4) return f.desc === nf.desc;
          return f.desc.includes(nf.desc) || nf.desc.includes(f.desc);
        });
        if (isExpiredDuplicate) {
          // 跳过 push,记到 issues 让 daemon 层 warn
          issues.push(`LLM 试图重新埋设已过期伏笔（已跳过）:${String(nf.desc).slice(0, 40)}`);
          continue;
        }
        if (!foreshadowing.some(f => f.desc === nf.desc)) {
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
    // 第二十三轮修复(记忆错乱 BUG): 原 characterState[idx] = nu 原地覆盖,角色位置不变
    //   → 主角第1章建立后在数组头部,中间出场 15+ 配角后,buildDynamicContext slice(-15) 永远取不到主角
    //   → 长篇后期主角人设从上下文消失,LLM 可能写出与主角人设矛盾的行为(位置/关系/情绪漂移)
    //   现: 本章出现角色移到数组末尾(标记最近活跃),slice(-15) 优先保留最近出场角色含主角
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
        if (idx >= 0) {
          characterState.splice(idx, 1); // 移除旧位置
          characterState.push(nu);        // 追加到末尾(最近活跃)
        } else {
          characterState.push(nu);
        }
      }
      // 防御:characterState 超过 50 个时裁剪保留末尾 50 个(主角必在最近活跃区)
      // 原: 永不裁剪,200 章累积 80+ 角色 → stateRepo JSON 序列化变慢,但注入已裁剪
      // 现: 50 上限足够覆盖长篇所有活跃角色,超出的多为一次性龙套
      if (characterState.length > 50) characterState = characterState.slice(-50);
    }

    // 第二十六轮新增(角色热度四态): merge 后补 lastSeenAt / recentAppearCount(规则式计算)
    // LLM 返回的 characterState 仅含 name/location/mood/relationships,merge 时 nu 是新对象会丢热度字段,
    // 需在 merge 后遍历重算并补回。recentAppearCount 用含本章的新 summaries 滑动窗口(最近10章出场次数)。
    // lastSeenAt: 角色名出现在本章正文(target.content) → 更新为 justFinishedIdx;否则保留旧值
    //   (非出场角色经 [...curCharacters] 浅拷贝保留旧 ref,lastSeenAt 不丢;出场角色 nu 丢字段但本章必命中)
    // 性能: O(N角色 × 10摘要),N≤50 时可接受;只在每章后算一次,buildDynamicContext 直接读缓存值
    {
      const justFinishedIdx = target.orderIdx;
      const chapterContent = target.content || '';
      const windowStart = justFinishedIdx - 9;
      const windowSummaries = summaries.filter(s => s.idx >= windowStart && s.idx <= justFinishedIdx);
      characterState = characterState.map(c => {
        const name = c.name;
        // 第二十六轮修复(角色热度单字名误匹配): 原 chapterContent.includes(name) 对单字名
        //   (如"林")会匹配"树林""竹林",双字名也可能匹配无关词,导致 appeared 永真、
        //   recentAppearCount 飙升 → 该角色永久占据 core 层挤掉真活跃角色。
        //   现: name.length>=2 用 includes(误匹配概率低,可接受);name.length<2(单字名)
        //   改用称谓边界匹配(名字后跟说/道/看/笑/想/某/师父/师兄/师姐/老/小/公子/小姐等
        //   常见称呼或标点),降低误匹配。仍无法完全消除,但单字名极少且此规则过滤绝大多数
        //   "树林/竹林"类误命中。匹配失败则保持旧热度(不虚高)。
        let appeared: boolean;
        if (name.length >= 2) {
          appeared = chapterContent.includes(name);
        } else if (name.length === 1) {
          // 单字名: 要求后跟称谓词或标点才算出场(避免"树林"误匹配"林")
          appeared = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:说|道|看|笑|想|某|师父|师兄|师姐|师弟|师妹|老|小|公子|小姐|爷|叔|婶|公|儿|[，。！？,!?])`).test(chapterContent);
        } else {
          appeared = false;
        }
        // recentAppearCount 同样: 单字名用称谓边界匹配摘要,避免"林"在每章摘要都命中
        const countName = (s: string): boolean => {
          if (name.length < 2) {
            return new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:说|道|看|笑|想|某|师父|师兄|师姐|师弟|师妹|老|小|公子|小姐|爷|叔|婶|公|儿|[，。！？,!?])`).test(s);
          }
          return s.includes(name);
        };
        const recentAppearCount = windowSummaries.filter(s => s.summary && countName(s.summary)).length;
        const lastSeenAt = appeared ? justFinishedIdx : c.lastSeenAt;
        return { ...c, lastSeenAt, recentAppearCount };
      });
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

    // 升级2(情感线节点追踪): 解析 LLM 返回的 emotionBeats(CP向作品),merge 到 state.emotionBeats
    //   LLM 不返回时跳过(非 CP 向作品不强制)。try/catch 容错,字段缺失/类型错不阻断主流程。
    //   merge 策略: 按 idx 去重(同章覆盖),保留旧 beat 保留新 beat 推进。
    let emotionBeats = [...(state?.emotionBeats || [])];
    try {
      if (Array.isArray(parsed.emotionBeats) && parsed.emotionBeats.length > 0) {
        const validTypes = ['心动', '靠近', '误解', '分离', '和好', '升华', '日常糖', '虐点'];
        const newBeats: EmotionBeat[] = [];
        for (const eb of parsed.emotionBeats) {
          if (!eb || typeof eb !== 'object') continue;
          const type = validTypes.includes(eb.type) ? eb.type : '日常糖';
          const characters = Array.isArray(eb.characters)
            ? eb.characters.filter((c: any) => typeof c === 'string').map((c: string) => c.slice(0, 20)).slice(0, 4)
            : [];
          const desc = String(eb.desc || '').slice(0, 80);
          if (!desc) continue;
          newBeats.push({ idx: target.orderIdx, type, characters, desc });
        }
        if (newBeats.length > 0) {
          // 按 idx 去重: 同章旧 beat 移除,新 beat 追加(保留其他章节)
          const otherBeats = emotionBeats.filter(b => b.idx !== target.orderIdx);
          emotionBeats = [...otherBeats, ...newBeats];
          // 防御: 超过 200 个时裁剪保留末尾 200 个(最近 beat 优先)
          if (emotionBeats.length > 200) emotionBeats = emotionBeats.slice(-200);
        }
      }
    } catch { /* 容错: emotionBeats 解析失败不阻断状态更新 */ }

    // 升级3(矛盾网三层状态机): 解析 LLM 返回的 conflictLines,merge 到 state.conflictLines
    //   LLM 不返回时跳过。try/catch 容错。merge 策略: 按 id 去重(同 id 覆盖状态)。
    let conflictLines = [...(state?.conflictLines || [])];
    try {
      if (Array.isArray(parsed.conflictLines) && parsed.conflictLines.length > 0) {
        const validLevels = ['chapter', 'volume', 'book'];
        const validStatuses = ['active', 'resolved', 'escalated'];
        for (const cl of parsed.conflictLines) {
          if (!cl || typeof cl !== 'object') continue;
          const id = String(cl.id || `c-${target.orderIdx}-${conflictLines.length}`).slice(0, 40);
          const desc = String(cl.desc || '').slice(0, 120);
          if (!desc) continue;
          const level = validLevels.includes(cl.level) ? cl.level : 'chapter';
          const status = validStatuses.includes(cl.status) ? cl.status : 'active';
          const introducedAt = typeof cl.introducedAt === 'number' ? cl.introducedAt : target.orderIdx;
          const resolvedAt = typeof cl.resolvedAt === 'number' ? cl.resolvedAt : undefined;
          const escalatedTo = typeof cl.escalatedTo === 'string' && cl.escalatedTo ? String(cl.escalatedTo).slice(0, 40) : undefined;
          // 按 id 去重覆盖(状态从 active→resolved/escalated 时更新)
          const existing = conflictLines.findIndex(c => c.id === id);
          const newCl: ConflictLine = { id, desc, level, status, introducedAt, ...(resolvedAt !== undefined ? { resolvedAt } : {}), ...(escalatedTo !== undefined ? { escalatedTo } : {}) };
          if (existing >= 0) conflictLines[existing] = newCl;
          else conflictLines.push(newCl);
        }
        // 防御: 超过 100 个时裁剪保留末尾 100 个(活跃矛盾优先)
        if (conflictLines.length > 100) conflictLines = conflictLines.slice(-100);
      }
    } catch { /* 容错: conflictLines 解析失败不阻断状态更新 */ }

    stateRepo.update(projectId, {
      chapterSummaries: summaries,
      foreshadowing,
      characterState,
      volumeOutlines,
      emotionBeats,
      conflictLines,
      memory: parsed.memory ? String(parsed.memory).slice(0, 600) : (state?.memory || ''),
    });
    return { issues };
  } catch (e) {
    // H1 修复(第十六轮): 不再静默吞错,改 throw 让 daemon 层 try/catch 接管打 warn
    // 原: catch{} 完全无日志 → daemon 不知状态更新失败,用户无感知 → 长篇后期状态陈旧
    // 现: throw 上抛,daemon 已有 try/catch 打 warn 日志(不阻断正文生成)
    throw new Error(`状态更新失败(第${target.orderIdx + 1}章): ${(e as Error).message}`);
  }
}
