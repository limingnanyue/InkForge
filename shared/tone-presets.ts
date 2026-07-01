/**
 * 统一文风指令库 —— 前后端共享
 * 取代 Generate.tsx 5 项硬编码文风 + 后端"只透传不消费"的 tone 字段
 *
 * 每个文风包含：
 *  - id:        slug 风格持久化 ID
 *  - label:     中文显示名（与 GenerateConfig.tone 字段一致，向后兼容旧数据）
 *  - instruction: 注入 LLM prompt 的文风指令（具体可执行，如"每章至少 1 个糖点"而非"写得甜一点"）
 *  - emotionDensity: 情节点密度，影响大纲 Σ 契约密疏点配比（dense/normal/sparse）
 *      · dense  → 密点×3 疏点×2
 *      · normal → 密点×2 疏点×3
 *      · sparse → 密点×1 疏点×4
 *  - applicableTypes: 适用项目类型，空数组表示全适用（与 shared/genres.ts 同语义）
 *      · 短篇只显示 applicableTypes 含 'short' 的项
 *      · 长篇无限制（全显示）
 *
 * 注意：label 字段为 GenerateConfig.tone 持久化值，向后兼容旧数据（如用户旧项目 tone='爽文'）
 *      故 label 不可改名，新增文风只能追加。
 */
import type { ProjectType } from './types';

export type EmotionDensity = 'dense' | 'normal' | 'sparse';

export interface TonePreset {
  id: string;            // slug 风格 ID（如 'shuang'）
  label: string;         // 显示名 + 持久化值（如"爽文"）
  instruction: string;   // 注入 LLM prompt 的文风指令
  emotionDensity: EmotionDensity;
  applicableTypes: ProjectType[]; // 空数组=全适用
}

// ============ 文风预设表（13 项 = 现有 5 + 新增 8） ============
export const TONE_PRESETS: TonePreset[] = [
  // —— 现有 5 项（label 与旧数据兼容，不可改名）——
  {
    id: 'shuang',
    label: '爽文',
    instruction: '爽点密集，每章至少 1 个爽点（打脸/升级/逆袭/获宝），台词带刺有张力，节奏快不拖沓，金手指主动出击。情绪直给、体感焊接，避免长段铺垫。',
    emotionDensity: 'dense',
    applicableTypes: [],
  },
  {
    id: 'manre',
    label: '慢热',
    instruction: '铺垫细腻，情绪缓慢累积，前 10 章建立世界观与人物，爽点延迟满足，重氛围与心理描写。可多用低压章与关系回收章，但每章仍须有推进点。',
    emotionDensity: 'sparse',
    applicableTypes: [],
  },
  {
    id: 'zhengju',
    label: '正剧',
    instruction: '克制厚重，逻辑严密，台词正式，冲突有据可依，避免夸张与巧合，适合权谋/正史向。情绪收着写，靠事件张力而非形容词堆砌。',
    emotionDensity: 'normal',
    applicableTypes: [],
  },
  {
    id: 'egao',
    label: '恶搞',
    instruction: '密集玩梗与吐槽，打破第四面墙，元叙事，角色自带喜感，剧情荒诞但自洽，适合网游/系统/日常。每章至少 1 处玩梗或吐槽，台词口语化带网感。',
    emotionDensity: 'dense',
    applicableTypes: [],
  },
  {
    id: 'heiseyoumo',
    label: '黑色幽默',
    instruction: '冷峻反讽，荒诞中的悲凉，笑中带泪，表面搞笑内核沉重，适合末世/荒诞/社会讽刺。台词冷峭克制，反转处用荒诞对照悲剧内核。',
    emotionDensity: 'normal',
    applicableTypes: [],
  },

  // —— 新增 8 项 ——
  {
    id: 'tianchong',
    label: '甜宠',
    instruction: '高糖低虐，每章至少 1 个糖点（互动/告白/日常甜），CP 互动占比≥40%，台词带撩，双向奔赴，少误会多撒糖。角色档案须标注 CP 关系，禁用分离/误会拖戏套路。',
    emotionDensity: 'dense',
    applicableTypes: ['long', 'short'],
  },
  {
    id: 'zhiyu',
    label: '治愈',
    instruction: '低冲突，情绪缓慢上升，细节流，重日常与陪伴感，结尾留余韵，台词温和，适合种田/日常/养成。每章 1 处温暖细节收束，禁用强反派/血腥冲突。',
    emotionDensity: 'sparse',
    applicableTypes: ['long', 'short'],
  },
  {
    id: 'nuelian',
    label: '虐恋',
    instruction: '误解-分离-火葬场-(可选)破镜重圆，情绪 V 形/W 形，每卷至少 1 次虐点（误会/错过/牺牲），台词带痛感，适合古言/仙侠言情。角色档案须标注情感纠葛与误会根源。',
    emotionDensity: 'normal',
    applicableTypes: ['long', 'short'],
  },
  {
    id: 'qunxiang',
    label: '群像',
    instruction: '多 POV 切换，每章至少 2 条线并行，无绝对主角，各角色弧线交织，重势力博弈与关系网，适合争霸/宫斗/家族。角色档案须含多主角设定与势力关系图。',
    emotionDensity: 'normal',
    applicableTypes: [],
  },
  {
    id: 'xuanyi',
    label: '悬疑',
    instruction: '每章埋 1 个谜 + 揭 1 个旧谜，禁上帝视角剧透，线索前置公平，反转有据，台词含暗示，适合推理/惊悚/无限流悬疑向。大纲须标注每章"埋/揭"谜题清单。',
    emotionDensity: 'normal',
    applicableTypes: [],
  },
  {
    id: 'wuxianliu',
    label: '无限流',
    instruction: '副本制，每副本独立规则 + 主线伏笔串联，副本间有结算与奖励，副本内高压生存/解谜，适合无限流/逃生。大纲须按副本分段，每副本首章须交代规则与通关条件。',
    emotionDensity: 'dense',
    applicableTypes: ['long'],
  },
  {
    id: 'xitongliu',
    label: '系统流',
    instruction: '系统提示框文案 + 任务驱动节奏，每章至少 1 次系统交互（签到/任务/奖励/升级），金手指依托系统，适合系统流/签到流。系统文案用【】方括号包裹，仿游戏 UI 风格。',
    emotionDensity: 'dense',
    applicableTypes: ['long'],
  },
  {
    id: 'niandaiwen',
    label: '年代文',
    instruction: '70-90 年代背景，时代细节考据（粮票/供销社/下海/知青），金手指受限，慢热生活流，重人情世故与时代变迁。世界观须含具体年份与时代符号，禁用现代科技/网络梗。',
    emotionDensity: 'sparse',
    applicableTypes: ['long'],
  },
];

// label → preset 快速映射（label 是 GenerateConfig.tone 持久化值）
export const TONE_MAP: Record<string, TonePreset> = TONE_PRESETS.reduce(
  (acc, p) => { acc[p.label] = p; return acc; },
  {} as Record<string, TonePreset>,
);

// 正剧作为未知 tone 的降级（克制厚重，最通用）
const FALLBACK_PRESET = TONE_MAP['正剧'] ?? TONE_PRESETS[2];

/**
 * 取文风指令（注入 LLM prompt 用）
 * 未知 tone（如用户旧数据 tone='未知风格'）降级返回正剧指令，保证向后兼容
 */
export function getToneInstruction(label?: string): string {
  if (!label) return FALLBACK_PRESET.instruction;
  return (TONE_MAP[label] ?? FALLBACK_PRESET).instruction;
}

/**
 * 取文风情节点密度（影响大纲 Σ 契约密疏点配比）
 * 未知 tone 降级返回 'normal'
 */
export function getToneDensity(label?: string): EmotionDensity {
  if (!label) return 'normal';
  return (TONE_MAP[label] ?? FALLBACK_PRESET).emotionDensity;
}

/**
 * 取完整 preset（前端可能需要 instruction 摘要、applicableTypes 等）
 * 未知 tone 降级返回正剧 preset
 */
export function getTonePreset(label?: string): TonePreset {
  if (!label) return FALLBACK_PRESET;
  return TONE_MAP[label] ?? FALLBACK_PRESET;
}

/**
 * 根据 emotionDensity 给出大纲 Σ 契约密疏点配比建议文本
 * 用于 generateOutline / generateOutlineForVolume 的 prompt 注入
 *  - dense  → 密点×3 疏点×2
 *  - normal → 密点×2 疏点×3
 *  - sparse → 密点×1 疏点×4
 */
export function getToneDensityHint(density: EmotionDensity): string {
  switch (density) {
    case 'dense':  return '密点×3(爽点/反转/CP互动,各≥250字) + 疏点×2(过场,各≈40字)';
    case 'sparse': return '密点×1(本章核心高潮,≥250字) + 疏点×4(铺垫/氛围/过场,各≈60字)';
    case 'normal':
    default:       return '密点×2(爽点/反转,各≥250字) + 疏点×3(过场,各≈40字)';
  }
}

/**
 * 按 projectType 过滤文风（与 shared/genres.ts filterByProjectType 同语义）
 * applicableTypes 为空数组 = 全适用；非空则需包含该 type
 */
export function filterTonesByProjectType(tones: TonePreset[], type?: ProjectType): TonePreset[] {
  if (!type) return tones;
  return tones.filter(t => !t.applicableTypes.length || t.applicableTypes.includes(type));
}
