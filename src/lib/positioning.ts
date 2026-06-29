/**
 * oh-story 章节定位六类 → badge 颜色 + 中文标签 + 目标比例
 * 跨组件共享：ChapterTree Row 标签 / ProjectDetail 编辑器顶栏标签 / 分布柱状图
 */
import type { ChapterPositioning } from '@shared/types';

export const POSITIONING_LABEL: Record<ChapterPositioning, [string, string]> = {
  'high-pressure':     ['badge-red', '高压章'],
  'normal-progress':   ['badge-mute', '普通推进'],
  'trial-error':       ['badge-amber', '试错章'],
  'relationship':      ['badge-green', '关系回收'],
  'low-pressure':      ['badge-mute', '低压生活'],
  'info-organize':     ['badge-mute', '信息整理'],
};

// oh-story 章节定位目标比例（M4 修复第十五轮：分布柱状图实际 vs 目标对比用）
export const POSITIONING_TARGET_RATIO: Record<ChapterPositioning, number> = {
  'high-pressure':     0.18,
  'normal-progress':   0.45,
  'trial-error':       0.08,
  'relationship':      0.08,
  'low-pressure':      0.10,
  'info-organize':     0.05,
};

// 章节定位柱状图颜色（M4 分布柱状图用）
export const POSITIONING_BAR_COLOR: Record<ChapterPositioning, string> = {
  'high-pressure':     'var(--cinnabar)',
  'normal-progress':   'var(--paper-mute)',
  'trial-error':       'var(--amber)',
  'relationship':     'var(--celadon)',
  'low-pressure':     'var(--paper-dim)',
  'info-organize':    'var(--ink-300)',
};

export const POSITIONING_ORDER: ChapterPositioning[] = [
  'high-pressure', 'normal-progress', 'trial-error', 'relationship', 'low-pressure', 'info-organize',
];
