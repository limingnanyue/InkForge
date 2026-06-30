/**
 * 通用 UI 组件集
 */
import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// 旋转加载
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('animate-spin', className)} />;
}

// 进度环（字数占比）
export function ProgressRing({ value, size = 40, stroke = 3, label }: { value: number; size?: number; stroke?: number; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - Math.min(1, Math.max(0, value)) * c;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ink-400)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--amber)" strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      </svg>
      {label && <span className="absolute text-[10px] font-mono text-paper-dim">{label}</span>}
    </div>
  );
}

// 进度条
export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full', className)} style={{ background: 'var(--ink-500)' }}>
      <div className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, value * 100)}%`, background: 'linear-gradient(90deg, var(--amber-deep), var(--amber))' }} />
    </div>
  );
}

// 字数格式化
export function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return `${n}`;
}

// 时间相对
export function fmtTime(t: number): string {
  const diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return `${Math.floor(diff / 86400000)}天前`;
}

// 空状态
export function EmptyState({ icon, title, desc, action }: { icon?: ReactNode; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center animate-fade-in">
      {icon && <div className="text-paper-mute opacity-50">{icon}</div>}
      <h3 className="font-display text-xl text-paper-dim">{title}</h3>
      {desc && <p className="max-w-sm text-sm text-paper-mute">{desc}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// 模态框
export function Modal({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  // 第二十六轮 P1 修复(弹窗内 input 失焦 BUG): onClose 用 ref 持有,useEffect 依赖收敛到 [open]。
  //   原: deps=[open,onClose],ProjectDetail 三处 Modal 的 onClose 全是 inline 箭头函数,
  //   父组件每次 re-render(如 input 每输一个字符触发 setState)都换新 onClose 引用 →
  //   effect cleanup 把焦点还原到 Modal 打开前的按钮 → effect 主体又把焦点移到 Modal 第一个
  //   可聚焦元素(SegmentedControl 按钮) → 用户输入第二个字符时焦点已不在 input,实质不可用。
  //   现: ref 持有最新 onClose,deps 只留 [open],open 不变时 effect 不重跑,焦点稳定。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    // 记录关闭后要还原焦点的元素
    prevFocusRef.current = document.activeElement as HTMLElement;
    // 把焦点移进 Modal（关闭按钮 X 或第一个可聚焦元素）
    const focusable = rootRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    focusable?.[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prevFocusRef.current?.focus();
    };
  }, [open]);
  if (!open) return null;
  // 第二十二轮修复(M): Modal 矮屏可滚 - 原 items-center 在矮屏会裁切按钮点不到
  //   现: items-start sm:items-center + overflow-y-auto + max-h-[90vh]
  return (
    <div ref={rootRef} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center" style={{ background: 'rgba(8,6,4,0.7)', backdropFilter: 'blur(4px)' }} role="dialog" aria-modal="true" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cn('panel-elevated w-full max-w-lg max-h-[90vh] overflow-y-auto animate-pop-in shadow-2xl my-auto pt-6', className)} onClick={e => e.stopPropagation()}>
        {title && (
          // 第二十六轮 P1 修复: Modal 标题改 sticky,长表单滚动时标题与关闭按钮常驻顶部
          //   原: 标题随内容滚走,用户滚到底想关闭得回滚
          <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 -mx-0 mb-4 border-b" style={{ background: 'var(--ink-800)', borderColor: 'var(--ink-500)' }}>
            <h2 className="font-display text-lg text-paper">{title}</h2>
            <button onClick={onClose} aria-label="关闭" className="text-paper-mute hover:text-paper transition-colors"><X size={18} /></button>
          </div>
        )}
        <div className="px-6 pb-6">
          {children}
        </div>
      </div>
    </div>
  );
}

// 确认提示（轻量 toast）
export function useToast() {
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3000);
    return () => clearTimeout(t);
  }, [msg]);
  // F1 修复：toast 用 useCallback 包裹，依赖稳定的 setMsg（useState setter 永远稳定）
  // 原写法每次 render 都返回新函数引用 → 下游所有把 toast 写进 useCallback/useEffect 依赖的组件
  // 会陷入「每次 render 都重跑 effect」的死循环，触发 SSE 反复 close/reopen、loadProjects/loadTasks 无限重发
  const toast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => setMsg({ text, kind }), []);
  const node = msg && (
    <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 animate-fade-up">
      <div className={cn('rounded-md px-4 py-2.5 text-sm shadow-xl', msg.kind === 'ok' ? 'badge-green' : 'badge-red')} style={{ borderWidth: 1 }}>
        {msg.text}
      </div>
    </div>
  );
  return { toast, node };
}

// 标签页
export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex gap-1 border-b" role="tablist" style={{ borderColor: 'var(--ink-500)' }}>
      {tabs.map(t => (
        <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => onChange(t.id)}
          className={cn('relative px-4 py-2.5 text-sm font-medium transition-colors', active === t.id ? 'text-amber' : 'text-paper-mute hover:text-paper-dim')}>
          {t.label}
          {active === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5" style={{ background: 'var(--amber)' }} />}
        </button>
      ))}
    </div>
  );
}

// 开关（消除 Generate/ProjectDetail/Studio 三处重复实现）
export function Switch({ checked, onChange, disabled, label, desc }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; desc?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      {/* 第二十二轮修复(M): Switch h-5 w-9 → h-6 w-11,thumb h-4 w-4 → h-5 w-5,达 24px 触摸目标 */}
      <button type="button" role="switch" aria-checked={checked} disabled={disabled}
        className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40',
          checked ? 'bg-amber' : 'bg-ink-500')}
        onClick={() => !disabled && onChange(!checked)}>
        <span className={cn('absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-paper transition-transform', checked && 'translate-x-5')} />
      </button>
      {(label || desc) && (
        <div className="flex-1">
          {label && <p className="text-xs font-medium text-paper-dim">{label}</p>}
          {desc && <p className="mt-0.5 text-[11px] leading-relaxed text-paper-mute">{desc}</p>}
        </div>
      )}
    </div>
  );
}

// 表单字段包裹（统一标签样式，Generate/Settings/Models 复用）
export function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-xs font-medium text-paper-mute">
        {label}
        {required && <span className="text-cinnabar">*</span>}
        {/* 第二十二轮修复(M): text-paper-mute/70 对比度 ~3.3:1 未达 AA,改为 text-paper-mute */}
        {hint && <span className="text-[10px] text-paper-mute">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

// 分段选择（单选按钮组，预设档位选择）
export function SegmentedControl<T extends string | number>({ options, value, onChange, disabled }: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1 rounded-md p-1" style={{ background: 'var(--ink-900)', border: '1px solid var(--ink-500)' }}>
      {options.map(opt => (
        <button key={String(opt.value)} type="button" disabled={disabled}
          className={cn('flex-1 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40',
            value === opt.value ? 'bg-amber text-ink-900' : 'text-paper-mute hover:text-paper-dim')}
          onClick={() => !disabled && onChange(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// 滑块（带数值标签）
export function Slider({ value, min, max, step = 1, onChange, disabled, format }: {
  value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; disabled?: boolean; format?: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      onChange={e => onChange(Number(e.target.value))}
      className="ink-slider w-full"
      style={{
        background: `linear-gradient(to right, var(--amber) ${pct}%, var(--ink-500) ${pct}%)`,
      }}
      aria-valuetext={format ? format(value) : String(value)}
    />
  );
}
