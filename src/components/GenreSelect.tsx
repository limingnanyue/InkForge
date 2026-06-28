/**
 * 题材选择器（共享组件）
 * - 从后端题材库加载（取代前端硬编码常量）
 * - 按 category 分组 optgroup
 * - 允许用户输入自定义题材（兜底回写为 label）
 * - 通过 genreId 持久化（slug 风格稳定 ID）
 *
 * 用法：
 *   <GenreSelect value={form.genreId} label={form.genre}
 *     onChange={(genreId, label) => set({ genreId, genre: label })} />
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/client';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';
import { groupGenres, type Genre, type GenreCategory } from '@shared/genres';

const CATEGORY_BADGE: Record<GenreCategory, string> = {
  male: 'badge badge-mute',
  female: 'badge badge-green',
  common: 'badge badge-amber',
};

export interface GenreSelectProps {
  /** 当前题材 ID（可空=未选/自定义） */
  value?: string;
  /** 当前题材 label（自定义输入兜底） */
  label?: string;
  /** 切换回调：返回 (genreId, label)；自定义输入时 genreId 为 ''。
   *  内置下拉选择即时触发；自定义输入仅在失焦时触发，避免每次按键回调 */
  onChange: (genreId: string, label: string) => void;
  /** 是否允许自定义输入（默认 true） */
  allowCustom?: boolean;
  /** 占位符 */
  placeholder?: string;
  className?: string;
}

export default function GenreSelect({
  value, label, onChange, allowCustom = true, placeholder = '— 选择题材 —', className,
}: GenreSelectProps) {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [loading, setLoading] = useState(true);
  const [customMode, setCustomMode] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const reloadRef = useRef<(() => void) | null>(null);

  const loadGenres = async () => {
    setLoading(true);
    try {
      const list = await api.genres.list();
      setGenres(list);
    } catch { /* 静默 */ }
    finally { setLoading(false); }
  };
  reloadRef.current = loadGenres;

  useEffect(() => { loadGenres(); }, []);

  // 当前 label/value 跟题材库做匹配，决定是下拉态还是自定义输入态
  useEffect(() => {
    if (label && !genres.some(g => g.label === label) && !value) {
      // label 在库里不存在且无 id：自定义输入态
      setCustomMode(true);
      setCustomInput(label);
    } else if (value && !genres.some(g => g.id === value)) {
      // value 不在库里（被删了？）：回退自定义模式
      setCustomMode(true);
      setCustomInput(label || '');
    } else if (label && genres.some(g => g.label === label) && (!value || customMode)) {
      // label 命中库但 genreId 为空（旧项目升级场景）：自动回填 id 并切回下拉态
      // value 命中但 customMode=true 时也一并重置回下拉态
      const matched = genres.find(g => g.label === label);
      if (matched && matched.id !== value) onChange(matched.id, matched.label);
      setCustomMode(false);
    }
  }, [label, value, genres, customMode, onChange]);

  const groups = useMemo(() => groupGenres(genres), [genres]);
  const selectedGenre = useMemo(() => genres.find(g => g.id === value), [genres, value]);

  const handleSelect = (id: string) => {
    if (!id) {
      // 切回自定义输入
      setCustomMode(true);
      setCustomInput('');
      onChange('', '');
      return;
    }
    const g = genres.find(x => x.id === id);
    if (g) {
      setCustomMode(false);
      onChange(g.id, g.label);
    }
  };

  const handleCustomInput = (v: string) => {
    setCustomInput(v);
    // 输入过程中实时匹配库里是否存在，命中即时切回下拉态并回传
    const matched = genres.find(g => g.label === v.trim());
    if (matched) {
      onChange(matched.id, matched.label);
      setCustomMode(false);
    }
    // 未命中时不调用 onChange，避免父组件每次按键写库
    // 自定义值在失焦时统一回传（见 commitCustom）
  };
  const commitCustom = () => {
    const v = customInput.trim();
    if (!v) return;
    // 失焦时再次尝试匹配（防用户粘贴整段）
    const matched = genres.find(g => g.label === v);
    if (matched) {
      onChange(matched.id, matched.label);
      setCustomMode(false);
    } else {
      onChange('', v);
    }
  };

  if (loading) {
    return (
      <div className={cn('flex items-center gap-2 text-xs text-paper-mute', className)}>
        <Spinner className="h-3 w-3" /> 加载题材库…
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* select：选中=genreId，未选/自定义=空 */}
      <select
        className="input"
        value={customMode ? '' : (value || '')}
        onChange={e => handleSelect(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {groups.map(g => (
          <optgroup key={g.category} label={g.label}>
            {g.items.map(it => (
              <option key={it.id} value={it.id}>
                {it.label}{it.isBuiltin ? '' : ' (自定义)'}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {/* 选中题材的说明 + 情绪映射（如内置题材则有） */}
      {selectedGenre && (selectedGenre.description || selectedGenre.emotionMap) && (
        <div className="rounded-md p-2 text-[11px] leading-relaxed text-paper-dim"
          style={{ background: 'rgba(212,165,52,0.04)', border: '1px solid var(--ink-500)' }}>
          {selectedGenre.description && <p>题材：{selectedGenre.description}</p>}
          {selectedGenre.emotionMap && <p className="mt-0.5">情绪：{selectedGenre.emotionMap}</p>}
          <p className="mt-1">
            <span className={CATEGORY_BADGE[selectedGenre.category]}>
              {selectedGenre.category === 'male' ? '男频' : selectedGenre.category === 'female' ? '女频' : '通用'}
            </span>
          </p>
        </div>
      )}

      {/* 自定义输入：用户可输入题材库里没有的题材 */}
      {allowCustom && customMode && (
        <input
          className="input font-mono"
          placeholder="输入自定义题材（如：赛博武侠）"
          value={customInput}
          onChange={e => handleCustomInput(e.target.value)}
          onBlur={commitCustom}
        />
      )}

      {/* 自定义模式切换链接 */}
      {allowCustom && !customMode && (
        <button type="button" className="self-start text-[11px] text-paper-mute hover:text-amber"
          onClick={() => { setCustomMode(true); setCustomInput(''); onChange('', ''); }}>
          或输入自定义题材 →
        </button>
      )}
      {allowCustom && customMode && (
        <button type="button" className="self-start text-[11px] text-paper-mute hover:text-amber"
          onClick={() => { setCustomMode(false); setCustomInput(''); }}>
          ← 改回选择题材
        </button>
      )}
    </div>
  );
}
