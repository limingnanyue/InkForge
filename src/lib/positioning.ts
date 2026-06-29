/**
 * oh-story 章节定位六类 → badge 颜色 + 中文标签
 * 跨组件共享：ChapterTree Row 标签 / ProjectDetail 编辑器顶栏标签
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
