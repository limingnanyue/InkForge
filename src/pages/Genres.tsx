/**
 * 题材库管理 —— 内置 + 用户自定义题材的增删改查
 * 替代分散在前端的硬编码常量，支持用户添加/编辑/删除自定义题材
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Edit3, Trash2, Search, Tag, X, BookMarked, Sparkles } from 'lucide-react';
import { api } from '@/api/client';
import { useApp } from '@/stores/app';
import { Spinner, Modal, useToast, EmptyState } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Genre, GenreCategory } from '@shared/genres';

const CATEGORY_LABEL: Record<GenreCategory, string> = {
  male: '男频', female: '女频', common: '通用',
};
const CATEGORY_BADGE: Record<GenreCategory, string> = {
  male: 'badge badge-mute', female: 'badge badge-green', common: 'badge badge-amber',
};
const CATEGORIES: GenreCategory[] = ['male', 'female', 'common'];

interface EditForm {
  id: string;             // 创建时填，编辑时只读
  label: string;
  category: GenreCategory;
  description: string;
  emotionMap: string;
}

export default function Genres() {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<GenreCategory | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [editing, setEditing] = useState<Genre | null>(null);
  const [creating, setCreating] = useState(false);
  const { toast, node } = useToast();
  // AI 补全题材说明: 记录正在补全的题材 id(防止重复点击)
  const [enrichingId, setEnrichingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setGenres(await api.genres.list()); }
    catch (e) { toast((e as Error).message, 'err'); }
    finally { setLoading(false); }
  };

  // M2 注:load 非 useCallback,deps 留空避免每次 render 重新触发
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    let list = genres;
    if (filter !== 'all') list = list.filter(g => g.category === filter);
    if (keyword.trim()) {
      const kw = keyword.trim().toLowerCase();
      list = list.filter(g =>
        g.label.toLowerCase().includes(kw) ||
        g.id.toLowerCase().includes(kw) ||
        (g.description || '').toLowerCase().includes(kw) ||
        (g.emotionMap || '').toLowerCase().includes(kw)
      );
    }
    return list;
  }, [genres, filter, keyword]);

  // 按 category 分组统计
  const counts = useMemo(() => {
    const c: Record<string, number> = { male: 0, female: 0, common: 0 };
    for (const g of genres) c[g.category]++;
    return c;
  }, [genres]);

  // H-20 修复(第二十轮): 删除题材改用 Modal 二次确认,与全局风格一致
  //   原 bug: 用原生 confirm(),会被浏览器扩展/iframe 屏蔽,且与暗色主题视觉割裂
  //   其他页面(Projects/ProjectDetail/ExportCenter)全部用 <Modal> 二次确认
  const [deleteTarget, setDeleteTarget] = useState<Genre | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const handleDelete = (g: Genre) => {
    if (g.isBuiltin) { toast('内置题材不可删除（可编辑）', 'err'); return; }
    setDeleteTarget(g);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.genres.delete(deleteTarget.id);
      setGenres(list => list.filter(x => x.id !== deleteTarget.id));
      toast('已删除');
      setDeleteTarget(null);
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setDeleteBusy(false); }
  };

  // AI 补全题材说明: 调 AnySearch 联网搜索 + LLM 生成详细 description + emotionMap
  // 透传当前所选 model/providerId(不传则后端回落到 default 旗舰)
  const handleEnrich = async (g: Genre) => {
    if (enrichingId) return;  // 防重复点击
    setEnrichingId(g.id);
    toast(`正在为「${g.label}」联网搜索并生成详细说明...`);
    try {
      const { currentModel, currentProviderId } = useApp.getState();
      const { description, emotionMap } = await api.genres.enrich(g.id, {
        model: currentModel || undefined,
        providerId: currentProviderId || undefined,
        webSearch: true,
      });
      // M2 修复(第十二轮): 用返回值就地更新单条,避免 load() 全量重拉导致列表闪 Spinner
      setGenres(list => list.map(x => x.id === g.id ? { ...x, description, emotionMap } : x));
      toast(`已补全「${g.label}」的题材说明与情绪映射`);
    } catch (e) {
      toast(`补全失败：${(e as Error).message}`, 'err');
    } finally {
      setEnrichingId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      {/* 标题区 */}
      <header className="mb-6 flex items-end justify-between gap-4 animate-fade-up">
        <div>
          <h1 className="font-display text-3xl text-paper">题材库</h1>
          <p className="mt-1.5 text-sm text-paper-mute">
            内置 {counts.male + counts.female + counts.common} 项题材，支持添加自定义题材与情绪映射
          </p>
        </div>
        <button className="btn-primary shrink-0" onClick={() => setCreating(true)}>
          <Plus size={16} /> 添加题材
        </button>
      </header>

      {/* 过滤栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-2 animate-fade-up">
        <div className="flex gap-1.5">
          <button
            className={cn('badge', filter === 'all' ? 'badge-amber' : 'badge-mute')}
            onClick={() => setFilter('all')}
          >
            全部 ({genres.length})
          </button>
          {CATEGORIES.map(c => (
            <button
              key={c}
              className={cn('badge', filter === c ? 'badge-amber' : 'badge-mute')}
              onClick={() => setFilter(c)}
            >
              {CATEGORY_LABEL[c]} ({counts[c]})
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-paper-mute" />
          <input
            className="input pl-8 py-1.5 text-xs w-56"
            placeholder="搜索题材名/说明/情绪"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
          />
        </div>
      </div>

      {/* 列表 */}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-paper-mute"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Tag size={28} />}
          title="未找到题材"
          desc={keyword ? '没有匹配的题材，换个关键词或添加新题材' : '点击右上角添加第一个题材'}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((g, i) => (
            <div
              key={g.id}
              className="panel-elevated animate-fade-up p-4"
              style={{ animationDelay: `${Math.min(i * 30, 600)}ms` }}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-display text-base text-paper">{g.label}</h3>
                    {g.isBuiltin ? (
                      <span className="badge badge-mute text-[10px]"><BookMarked size={10} /> 内置</span>
                    ) : (
                      <span className="badge badge-green text-[10px]">自定义</span>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-paper-mute">{g.id}</p>
                </div>
                <span className={CATEGORY_BADGE[g.category]}>{CATEGORY_LABEL[g.category]}</span>
              </div>
              {g.description && (
                <p className="mb-1 text-[11px] leading-relaxed text-paper-dim">{g.description}</p>
              )}
              {g.emotionMap && (
                <p className="text-[11px] text-amber/80">情绪：{g.emotionMap}</p>
              )}
              <div className="mt-3 flex items-center justify-end gap-1 border-t pt-2" style={{ borderColor: 'var(--ink-600)' }}>
                <button
                  className="btn-ghost py-1 text-xs text-amber hover:text-amber-bright"
                  onClick={() => handleEnrich(g)}
                  disabled={!!enrichingId}
                  title={enrichingId && enrichingId !== g.id ? '请等待当前补全完成' : '联网搜索 + AI 生成详细题材说明'}
                >
                  {enrichingId === g.id ? <Spinner className="h-3 w-3" /> : <Sparkles size={12} />} AI 补全
                </button>
                <button
                  className="btn-ghost py-1 text-xs"
                  onClick={() => setEditing(g)}
                >
                  <Edit3 size={12} /> 编辑
                </button>
                <button
                  className="btn-ghost py-1 text-xs text-cinnabar hover:text-cinnabar"
                  onClick={() => handleDelete(g)}
                  disabled={g.isBuiltin}
                  title={g.isBuiltin ? '内置题材不可删除' : '删除'}
                >
                  <Trash2 size={12} /> 删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 编辑/创建弹窗 */}
      {(editing || creating) && (
        <GenreEditModal
          genre={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); load(); }}
        />
      )}

      {/* H-20 修复(第二十轮): 删除题材二次确认 Modal */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="删除题材">
        <p className="text-sm leading-relaxed text-paper-dim">
          确定删除自定义题材 <span className="font-display text-cinnabar">「{deleteTarget?.label}」</span> 吗？
        </p>
        <p className="mt-2 text-xs leading-relaxed text-paper-mute">
          已关联此题材的项目不会删除，但其 genreId 会保留为旧值（需手动改回）。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>取消</button>
          <button className="btn-danger" onClick={confirmDelete} disabled={deleteBusy}>
            {deleteBusy ? <Spinner className="h-4 w-4" /> : <Trash2 size={14} />} 删除
          </button>
        </div>
      </Modal>

      {node}
    </div>
  );
}

/* ============ 编辑/创建弹窗 ============ */
function GenreEditModal({ genre, onClose, onSaved }: {
  genre: Genre | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isCreate = !genre;
  const [form, setForm] = useState<EditForm>(() => genre ? {
    id: genre.id, label: genre.label, category: genre.category,
    description: genre.description || '', emotionMap: genre.emotionMap || '',
  } : {
    id: '', label: '', category: 'common', description: '', emotionMap: '',
  });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const ID_RE = /^[a-z0-9][a-z0-9-]{1,49}$/;

  const save = async () => {
    if (!form.label.trim()) { toast('题材名必填', 'err'); return; }
    if (isCreate) {
      if (!form.id || !ID_RE.test(form.id)) {
        toast('ID 必填：小写字母/数字/短横线，2-50 字符（如 my-genre）', 'err');
        return;
      }
    }
    setSaving(true);
    try {
      if (isCreate) {
        await api.genres.create({
          id: form.id.toLowerCase(),
          label: form.label.trim(),
          category: form.category,
          description: form.description.trim() || undefined,
          emotionMap: form.emotionMap.trim() || undefined,
        });
        toast('已创建');
      } else {
        await api.genres.update(form.id, {
          label: form.label.trim(),
          category: form.category,
          description: form.description,
          emotionMap: form.emotionMap,
        });
        toast('已更新');
      }
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={isCreate ? '添加题材' : `编辑题材 · ${genre?.label}`}>
      <div className="space-y-3">
        {/* ID */}
        <div>
          <label className="mb-1 block text-xs font-medium text-paper-mute">题材 ID（slug）</label>
          <input
            className="input font-mono text-xs"
            placeholder="如 my-cyberpunk"
            value={form.id}
            onChange={e => setForm(f => ({ ...f, id: e.target.value }))}
            disabled={!isCreate}
          />
          <p className="mt-1 text-[10px] text-paper-mute">
            {isCreate
              ? '小写字母/数字/短横线，2-50 字符，创建后不可改'
              : 'ID 创建后不可修改'}
          </p>
        </div>
        {/* Label */}
        <div>
          <label className="mb-1 block text-xs font-medium text-paper-mute">题材名</label>
          <input
            className="input"
            placeholder="如 赛博武侠"
            value={form.label}
            onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
          />
        </div>
        {/* Category */}
        <div>
          <label className="mb-1 block text-xs font-medium text-paper-mute">分类</label>
          <div className="flex gap-1.5">
            {CATEGORIES.map(c => (
              <button
                key={c}
                type="button"
                className={cn('badge', form.category === c ? 'badge-amber' : 'badge-mute')}
                onClick={() => setForm(f => ({ ...f, category: c }))}
              >
                {CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
        </div>
        {/* Description */}
        <div>
          <label className="mb-1 block text-xs font-medium text-paper-mute">题材说明</label>
          <textarea
            className="input min-h-[60px] resize-none text-xs"
            placeholder="题材的核心特征、世界观、写作要点…"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          />
        </div>
        {/* Emotion Map */}
        <div>
          <label className="mb-1 block text-xs font-medium text-paper-mute">核心情绪映射</label>
          <input
            className="input text-xs"
            placeholder="如 爽感/逆袭/装逼打脸（供 LLM 写作 prompt 参考）"
            value={form.emotionMap}
            onChange={e => setForm(f => ({ ...f, emotionMap: e.target.value }))}
          />
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--ink-600)' }}>
        <button className="btn-ghost py-2 text-sm" onClick={onClose}>
          <X size={14} /> 取消
        </button>
        <button className="btn-primary py-2 text-sm" onClick={save} disabled={saving}>
          {saving ? <Spinner className="h-4 w-4" /> : <Plus size={14} />}
          {isCreate ? '创建' : '保存'}
        </button>
      </div>
    </Modal>
  );
}
