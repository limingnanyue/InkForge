/**
 * 项目/任务共享常量 —— 抽取自 Projects.tsx / ProjectDetail.tsx / Daemon.tsx / Studio.tsx
 * 解决重复定义问题（L1+L2 修复）
 */
import type { ProjectType } from '@shared/types';

// L1 修复(第二十轮): 项目类型徽章 - 原在 Projects.tsx:13 与 ProjectDetail.tsx:21 重复定义
export const TYPE_LABEL: Record<ProjectType, string> = {
  long: '长篇', short: '短篇', script: '剧本',
};

export const TYPE_BADGE: Record<ProjectType, string> = {
  long: 'badge-amber', short: 'badge-green', script: 'badge-mute',
};

// L2 修复(第二十轮): 任务状态徽章 - 原在 Daemon.tsx:13-14 与 Studio.tsx:398-399 重复定义
export const TASK_STATUS_BADGE: Record<string, string> = {
  running: 'badge-amber', queued: 'badge-mute', paused: 'badge-mute',
  done: 'badge-green', failed: 'badge-red',
};

export const TASK_STATUS_TEXT: Record<string, string> = {
  running: '运行中', queued: '排队', paused: '已暂停',
  done: '完成', failed: '失败',
};
