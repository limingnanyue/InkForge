/**
 * 守护进程 —— 任务监控
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { Pause, Play, X, ChevronDown, ChevronRight, Server, RotateCw, FastForward, MapPin } from 'lucide-react';
import { api } from '@/api/client';
import { useApp } from '@/stores/app';
import BlurText from '@/components/BlurText';
import { Spinner, ProgressBar, fmtTime, useToast } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Task, TaskLog } from '@shared/types';

const STATUS_BADGE: Record<string, string> = { running: 'badge-amber', queued: 'badge-mute', paused: 'badge-mute', done: 'badge-green', failed: 'badge-red' };
const STATUS_TEXT: Record<string, string> = { running: '运行中', queued: '排队', paused: '已暂停', done: '完成', failed: '失败' };
const TYPE_TEXT: Record<string, string> = { book: '成书', short: '成短篇', chapter: '章节生成', refine: '精修' };

interface DaemonStatus { running: number; queued: number; done: number; failed: number; total: number; }

// checkpoint 摘要：按任务类型渲染断点信息
function fmtCheckpoint(task: Task): string | null {
  if (task.type === 'chapter' || task.type === 'refine') return '单次执行';
  const cp = task.checkpoint;
  if (!cp || Object.keys(cp).length === 0) return null;
  if (task.type === 'book') {
    const phase = cp.phase as string | undefined;
    const phaseText = phase === 'scan' ? '扫榜' : phase === 'outline' ? '大纲' : phase === 'chapter' ? '正文' : (phase || '');
    const chapterIdx = cp.chapterIdx as number | undefined;
    const total = cp.totalChapters as number | undefined;
    const chPart = chapterIdx != null ? `已完成 ${chapterIdx}${total != null ? `/${total}` : ''} 章` : '';
    return [phaseText, chPart].filter(Boolean).join(' · ') || null;
  }
  if (task.type === 'short') {
    const seg = cp.segmentIdx as number | undefined;
    return seg != null ? `片段 ${seg}` : null;
  }
  return null;
}

export default function Daemon() {
  const { tasks, loadTasks } = useApp();
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { toast, node } = useToast();

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadTasks(), api.tasks.daemonStatus().then(setStatus)]);
    } catch (e) { toast((e as Error).message, 'err'); }
  }, [loadTasks, toast]);

  // F7 修复：SSE 高频事件节流，避免后端连发 progress 时 N 倍重复请求
  // 原 bug：10 个并发任务每秒 10 条 progress → 10 次 refresh → 10 次 loadTasks + 10 次 daemonStatus
  // 用 500ms 节流：高频事件期间最多每 500ms 一次 refresh，最后一次事件后补一次保证最终态刷新
  const throttleRef = useRef<{ timer: number | null; pending: boolean; lastFire: number }>({ timer: null, pending: false, lastFire: 0 });
  const throttledRefresh = useCallback(() => {
    const now = Date.now();
    const state = throttleRef.current;
    const THROTTLE_MS = 500;
    // 距离上次 fire 不足 500ms → 延迟到 500ms 节点
    if (now - state.lastFire < THROTTLE_MS) {
      state.pending = true;
      if (state.timer === null) {
        state.timer = window.setTimeout(() => {
          state.timer = null;
          state.lastFire = Date.now();
          state.pending = false;
          refresh();
        }, THROTTLE_MS - (now - state.lastFire));
      }
    } else {
      // 距上次 fire 超过 500ms → 立即触发
      state.lastFire = now;
      state.pending = false;
      if (state.timer !== null) { window.clearTimeout(state.timer); state.timer = null; }
      refresh();
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    const off = api.streamEvents((e: any) => {
      if (['task:progress', 'task:done', 'task:failed'].includes(e.type)) throttledRefresh();
    });
    const poll = setInterval(refresh, 8000); // 兜底轮询
    return () => {
      off();
      clearInterval(poll);
      if (throttleRef.current.timer !== null) window.clearTimeout(throttleRef.current.timer);
    };
  }, [refresh, throttledRefresh]);

  const running = status?.running ?? 0;

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      <header className="mb-6 flex items-end justify-between gap-4 animate-fade-up">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-4xl text-paper">守护进程</h1>
            <span className={cn('badge', running > 0 ? 'badge-amber' : 'badge-green')}>
              <span className={cn('h-1.5 w-1.5 rounded-full', running > 0 ? 'bg-amber animate-pulse' : 'bg-celadon')} />
              {running > 0 ? '运行中' : '空闲'}
            </span>
          </div>
          <BlurText text="守护进程独立运行，关闭浏览器不影响生成；断点续传自动恢复" as="p" className="mt-1.5 text-xs text-paper-mute" delay={120} stagger={12} />
        </div>
      </header>

      {/* 统计卡 */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="运行中" value={status?.running ?? 0} color="amber" index={0} />
        <StatCard label="排队" value={status?.queued ?? 0} color="mute" index={1} />
        <StatCard label="完成" value={status?.done ?? 0} color="green" index={2} />
        <StatCard label="失败" value={status?.failed ?? 0} color="red" index={3} />
      </div>

      {/* 任务列表 */}
      {tasks.length === 0 ? (
        <div className="panel-elevated flex items-center gap-3 p-8 text-sm text-paper-mute">
          <Server size={20} /> 暂无任务。前往「一键生成」或章节编辑器派发任务。
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((t, i) => (
            <TaskRow key={t.id} task={t} index={i} expanded={expanded === t.id}
              onToggle={() => setExpanded(prev => prev === t.id ? null : t.id)}
              onAction={refresh} />
          ))}
        </div>
      )}
      {node}
    </div>
  );
}

const STAT_COLOR: Record<string, string> = {
  amber: 'var(--amber)', mute: 'var(--paper-mute)', green: 'var(--celadon)', red: 'var(--cinnabar)',
};

function StatCard({ label, value, color, index }: { label: string; value: number; color: string; index: number }) {
  return (
    <div className="panel-elevated animate-fade-up p-4" style={{ animationDelay: `${index * 40}ms` }}>
      <p className="text-[11px] uppercase tracking-wider text-paper-mute">{label}</p>
      <p className="mt-1 font-display text-3xl" style={{ color: STAT_COLOR[color] }}>{value}</p>
    </div>
  );
}

function TaskRow({ task, expanded, onToggle, onAction, index }: {
  task: Task; expanded: boolean; onToggle: () => void; onAction: () => void; index: number;
}) {
  const { toast } = useToast();
  const [logs, setLogs] = useState<TaskLog[] | null>(null);
  const [logLoading, setLogLoading] = useState(false);

  const loadLogs = async () => {
    if (logs) return;
    setLogLoading(true);
    try { setLogs(await api.tasks.logs(task.id)); }
    catch (e) { toast((e as Error).message, 'err'); }
    finally { setLogLoading(false); }
  };

  const onExpand = () => {
    if (!expanded) loadLogs();
    onToggle();
  };

  const act = async (kind: 'pause' | 'resume' | 'cancel') => {
    try {
      if (kind === 'pause') await api.tasks.pause(task.id);
      else if (kind === 'resume') await api.tasks.resume(task.id);
      else await api.tasks.cancel(task.id);
      onAction();
      toast(kind === 'cancel' ? '已取消' : kind === 'pause' ? '已暂停' : '已恢复');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  const onRetry = async () => {
    try {
      await api.tasks.retry(task.id);
      onAction();
      toast('已重试，从断点续传');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  const onContinue = async () => {
    try {
      await api.tasks.continueTask(task.id);
      onAction();
      toast('已继续，从 checkpoint 恢复');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  const cpText = fmtCheckpoint(task);

  return (
    <div className="panel-elevated animate-fade-up overflow-hidden" style={{ animationDelay: `${index * 40}ms` }}>
      <div className="flex items-center gap-3 p-3">
        <button onClick={onExpand} className="text-paper-mute hover:text-paper">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-paper-dim">{TYPE_TEXT[task.type] || task.type}</span>
            <span className={cn('badge', STATUS_BADGE[task.status])}>{STATUS_TEXT[task.status]}</span>
            {task.retryCount > 0 && (
              <span className="badge badge-amber font-mono text-[10px]">重试 {task.retryCount}/{task.maxRetries}</span>
            )}
            <span className="text-[11px] text-paper-mute">{fmtTime(task.createdAt)}</span>
          </div>
          {task.message && <p className="mt-1 truncate text-xs text-paper-mute">{task.message}</p>}
          <div className="mt-2 max-w-md"><ProgressBar value={task.progress} /></div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {task.status === 'running' && <button className="btn-ghost py-1.5 text-xs" onClick={() => act('pause')}><Pause size={12} /> 暂停</button>}
          {task.status === 'paused' && <button className="btn-ghost py-1.5 text-xs" onClick={() => act('resume')}><Play size={12} /> 恢复</button>}
          {(task.status === 'paused' || task.status === 'failed') && <button className="btn-ghost py-1.5 text-xs" onClick={onContinue}><FastForward size={12} /> 继续</button>}
          {task.status === 'failed' && <button className="btn-ghost py-1.5 text-xs" onClick={onRetry}><RotateCw size={12} /> 重试</button>}
          {(task.status === 'running' || task.status === 'paused' || task.status === 'queued') &&
            <button className="btn-ghost py-1.5 text-xs text-cinnabar" onClick={() => act('cancel')}><X size={12} /> 取消</button>}
        </div>
      </div>
      {expanded && (
        <div className="border-t px-3 py-3" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-900)' }}>
          {cpText && (
            <div className="mb-2 flex items-center gap-1.5 font-mono text-[11px] text-paper-mute">
              <MapPin size={11} /> {cpText}
            </div>
          )}
          {logLoading ? <Spinner className="h-4 w-4 text-paper-mute" /> :
            logs && logs.length === 0 ? <p className="text-xs text-paper-mute">暂无日志</p> :
            <div className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed">
              {logs?.map(l => (
                <div key={l.id} className="flex gap-2">
                  <span className="shrink-0 text-paper-mute">{new Date(l.createdAt).toLocaleTimeString()}</span>
                  <span className={cn('shrink-0', l.level === 'error' ? 'text-cinnabar' : 'text-amber')}>[{l.level}]</span>
                  <span className="text-paper-dim">{l.message}</span>
                </div>
              ))}
            </div>}
        </div>
      )}
    </div>
  );
}
