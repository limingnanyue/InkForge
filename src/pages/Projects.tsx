/**
 * 作品库 —— 项目列表
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, BookOpen, FolderOpen, Pencil, Trash2, Check, Tag } from 'lucide-react';
import { api } from '@/api/client';
import { useApp } from '@/stores/app';
import BlurText from '@/components/BlurText';
import { Spinner, ProgressRing, fmtWords, fmtTime, EmptyState, Modal, useToast } from '@/components/ui';
import type { Project, ProjectType } from '@shared/types';
// L1 修复(第二十轮): 抽取自 @/lib/project 的共享常量,与 ProjectDetail.tsx 共用
import { TYPE_LABEL, TYPE_BADGE } from '@/lib/project';

// 由 coverSeed 生成稳定的色相，叠加琥珀金基调
function coverGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h % 60 + 20} 70% 55% / .9), hsl(${(h + 35) % 60 + 20} 65% 35% / .95))`;
}

export default function Projects() {
  const { projects, loadProjects, setCurrentProject } = useApp();
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const navigate = useNavigate();
  const { toast, node } = useToast();

  useEffect(() => {
    (async () => {
      try { await loadProjects(); }
      catch (e) { toast((e as Error).message, 'err'); }
      finally { setLoading(false); }
    })();
  }, [loadProjects, toast]);

  const enter = (p: Project) => {
    setCurrentProject(p);
    navigate(`/projects/${p.id}`);
  };

  const startRename = (p: Project) => {
    setRenameTarget(p);
    setRenameTitle(p.title);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const title = renameTitle.trim();
    if (!title) { toast('标题不能为空', 'err'); return; }
    if (title === renameTarget.title) { setRenameTarget(null); return; }
    setRenameBusy(true);
    try {
      await api.projects.update(renameTarget.id, { title });
      toast('已重命名');
      setRenameTarget(null);
      await loadProjects();
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setRenameBusy(false); }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.projects.delete(deleteTarget.id);
      toast('项目已删除');
      setDeleteTarget(null);
      await loadProjects();
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setDeleteBusy(false); }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      {/* 顶部 */}
      <header className="mb-8 flex items-end justify-between gap-4 animate-fade-up">
        <div>
          <h1 className="font-display text-4xl text-paper">作品库</h1>
          <BlurText text="执笔成书，墨痕未干" as="p" className="mt-1.5 text-sm text-paper-mute" delay={120} stagger={20} />
        </div>
        <button className="btn-primary shrink-0" onClick={() => setModalOpen(true)}>
          <Plus size={16} /> 新建项目
        </button>
      </header>

      {/* 列表 */}
      {loading ? (
        <div className="flex h-64 items-center justify-center text-paper-mute"><Spinner /></div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={40} />}
          title="尚无作品"
          desc="从一句话灵感开始，墨铸将陪你走完从设定到成书的全程。"
          action={<button className="btn-primary" onClick={() => setModalOpen(true)}><Plus size={16} /> 新建项目</button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p, i) => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              className="panel-elevated group relative flex cursor-pointer overflow-hidden text-left transition-all duration-200 hover:border-amber-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 animate-fade-up"
              style={{ animationDelay: `${i * 50}ms` }}
              onClick={() => enter(p)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(p); } }}
            >
              {/* 第二十二轮修复(H6): 移动端无 hover,操作按钮常显;桌面端保持 hover 显示
                  原 bug: opacity-0 group-hover:opacity-100,触屏设备 :hover 不触发,按钮永远不可见
                  现: 移动端 opacity-100,桌面端 md:opacity-0 md:group-hover:opacity-100 */}
              <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-ink-900/80 text-paper-mute backdrop-blur hover:text-amber"
                  title="重命名"
                  onClick={(e) => { e.stopPropagation(); startRename(p); }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-md bg-ink-900/80 text-paper-mute backdrop-blur hover:text-cinnabar"
                  title="删除"
                  onClick={(e) => { e.stopPropagation(); setDeleteTarget(p); }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {/* 缩略块 */}
              <div className="flex w-20 shrink-0 items-center justify-center" style={{ background: coverGradient(p.coverSeed) }}>
                <BookOpen size={22} className="text-ink-900/70" />
              </div>
              {/* 主体 */}
              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2 pr-16">
                  <h3 className="font-display text-lg leading-tight text-paper group-hover:text-amber">{p.title}</h3>
                  <span className={`badge ${TYPE_BADGE[p.type]} shrink-0`}>{TYPE_LABEL[p.type]}</span>
                </div>
                {p.genre && (
                  <div className="flex items-center gap-1 text-[11px] text-amber">
                    <Tag size={10} /> {p.genre}
                  </div>
                )}
                <p className="line-clamp-2 text-xs leading-relaxed text-paper-mute">{p.summary || '暂无简介'}</p>
                <div className="mt-auto flex items-center justify-between pt-1">
                  <div className="flex items-center gap-2">
                    <ProgressRing value={p.targetWords ? p.currentWords / p.targetWords : 0} size={34} />
                    <div className="text-[11px] leading-tight">
                      <p className="font-mono text-paper-dim">{fmtWords(p.currentWords)}</p>
                      <p className="text-paper-mute">/ {fmtWords(p.targetWords)}</p>
                    </div>
                  </div>
                  <span className="text-[11px] text-paper-mute">编辑于 {fmtTime(p.updatedAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={() => { loadProjects(); }} />

      {/* 重命名 Modal */}
      <Modal open={!!renameTarget} onClose={() => setRenameTarget(null)} title="重命名项目">
        <div className="space-y-4">
          <input
            className="input"
            value={renameTitle}
            onChange={e => setRenameTitle(e.target.value)}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') submitRename(); }}
            placeholder="输入新标题"
          />
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setRenameTarget(null)}>取消</button>
            <button className="btn-primary" onClick={submitRename} disabled={renameBusy}>
              {renameBusy ? <Spinner className="h-4 w-4" /> : <Check size={16} />} 保存
            </button>
          </div>
        </div>
      </Modal>

      {/* 删除确认 Modal */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="删除项目">
        <p className="text-sm leading-relaxed text-paper-dim">
          确定删除作品 <span className="font-display text-cinnabar">《{deleteTarget?.title}》</span> 吗？
        </p>
        <p className="mt-2 text-xs leading-relaxed text-paper-mute">
          该操作不可恢复，将同时删除其全部章节、智能体状态、任务记录与对话消息。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setDeleteTarget(null)}>取消</button>
          <button className="btn-primary" onClick={confirmDelete} disabled={deleteBusy}>
            {deleteBusy ? <Spinner className="h-4 w-4" /> : <Trash2 size={16} />} 确认删除
          </button>
        </div>
      </Modal>
      {node}
    </div>
  );
}

function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<ProjectType>('long');
  const [targetWords, setTargetWords] = useState(100000);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const submit = async () => {
    if (!title.trim()) { toast('请填写标题', 'err'); return; }
    setBusy(true);
    try {
      await api.projects.create({ title: title.trim(), type, targetWords, summary: summary.trim() });
      toast('项目已创建');
      setTitle(''); setType('long'); setTargetWords(100000); setSummary('');
      onCreated();
      onClose();
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="新建项目">
      <div className="space-y-4">
        <Field label="标题">
          <input className="input" placeholder="如：风起观星台" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
        </Field>
        {/* 第二十二轮修复(H13): grid-cols-1 sm:grid-cols-2 移动端单列降级
            原 bug: grid-cols-2 在 320-375px 窄屏两列各 ~150px,select 长选项 + number 挤压不可读 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="类型">
            <select className="input" value={type} onChange={e => setType(e.target.value as ProjectType)}>
              <option value="long">长篇</option>
              <option value="short">短篇</option>
              {/* P1 修复(BUG2): 移除"剧本"选项 —— script 类型无专用 pipeline,会被当 book 处理输出小说,已禁用创建 */}
            </select>
          </Field>
          <Field label="目标字数">
            <input type="number" min={1000} step={1000} className="input" value={targetWords}
              onChange={e => setTargetWords(Math.max(1000, Number(e.target.value) || 0))} />
          </Field>
        </div>
        <Field label="简介">
          <textarea className="input min-h-[88px] resize-none" placeholder="一句话点子或核心卖点…" value={summary} onChange={e => setSummary(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner className="h-4 w-4" /> : <Plus size={16} />} 创建
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-paper-mute">{label}</span>
      {children}
    </label>
  );
}
