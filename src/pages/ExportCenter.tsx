/**
 * 导出中心 —— 多格式成书导出与历史
 */
import { useEffect, useState } from 'react';
import { Download, FileText, FileCode, BookOpen, FileType, History, Link2, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import BlurText from '@/components/BlurText';
import { Spinner, EmptyState, fmtTime, useToast, Modal } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Project, ExportRecord, ExportFormat } from '@shared/types';

// P1 修复(BUG1): 名实不符 —— 原 'epub' 实际生成 HTML(阅读器无法识别),'docx' 实际生成 .html。
//   改为诚实标注:'html' = 网页版HTML(原 epub 位),实际产出 .html;'docx' = Word兼容,实际产出 .doc(Word 可打开的 HTML)。
//   不再让用户误以为拿到的是真正 .epub 实际却是 HTML。
const FORMATS: { id: ExportFormat; label: string; icon: typeof FileText; ext: string }[] = [
  { id: 'txt', label: 'TXT', icon: FileText, ext: '纯文本' },
  { id: 'markdown', label: 'Markdown', icon: FileCode, ext: '.md' },
  { id: 'html', label: '网页版HTML', icon: BookOpen, ext: '网页' },
  { id: 'docx', label: 'Word兼容', icon: FileType, ext: '.doc' },
];

export default function ExportCenter() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [format, setFormat] = useState<ExportFormat>('txt');
  const [range, setRange] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastFile, setLastFile] = useState<{ fileName: string } | null>(null);
  const [history, setHistory] = useState<ExportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  // H4 修复(第十九轮): 删除/清空确认弹窗 + 删除中态
  const [deleteTarget, setDeleteTarget] = useState<ExportRecord | null>(null);
  const [clearTarget, setClearTarget] = useState<string | null>(null);
  // 第二十一修复: 全局清空全部弹窗(避免切到无记录项目时完全看不到清空入口)
  const [clearAllOpen, setClearAllOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { toast, node } = useToast();

  const loadHistory = async () => {
    try { setHistory(await api.exports.list()); }
    catch (e) { toast((e as Error).message, 'err'); }
  };

  useEffect(() => {
    (async () => {
      try {
        const ps = await api.projects.list();
        setProjects(ps);
        if (ps[0]) setProjectId(ps[0].id);
        await loadHistory();
      } catch (e) { toast((e as Error).message, 'err'); }
      finally { setLoading(false); }
    })();
  }, [toast]);

  const doExport = async () => {
    if (!projectId) { toast('请选择项目', 'err'); return; }
    setBusy(true);
    try {
      const r = await api.exports.create({ projectId, format, chapterRange: range.trim() || undefined });
      setLastFile(r);
      toast('导出完成');
      loadHistory();
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(false); }
  };

  // H4 修复(第十九轮): 删除单条导出记录
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.exports.deleteRecord(deleteTarget.id);
      toast('已删除导出记录');
      setDeleteTarget(null);
      loadHistory();
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setDeleting(false); }
  };

  // H4 修复(第十九轮): 清空指定项目的全部导出历史
  const confirmClear = async () => {
    if (!clearTarget) return;
    setDeleting(true);
    try {
      const r = await api.exports.clearByProject(clearTarget);
      toast(`已清空 ${r.deleted} 条导出记录`);
      setClearTarget(null);
      loadHistory();
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setDeleting(false); }
  };

  // 第二十一修复: 全局清空所有项目的全部导出历史
  const confirmClearAll = async () => {
    setDeleting(true);
    try {
      const r = await api.exports.clearAll();
      toast(`已清空全部 ${r.deleted} 条导出记录`);
      setClearAllOpen(false);
      loadHistory();
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setDeleting(false); }
  };

  const projectTitle = (id: string) => projects.find(p => p.id === id)?.title || '已删除项目';
  // 当前选中项目的导出记录数（用于显示"清空"按钮可用态）
  const projectHistoryCount = history.filter(r => r.projectId === projectId).length;

  if (loading) return <div className="flex h-full items-center justify-center text-paper-mute"><Spinner /></div>;

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      <header className="mb-6 animate-fade-up">
        <h1 className="font-display text-4xl text-paper">导出中心</h1>
        <BlurText text="将章节编排为成稿，分发到任意阅读平台" as="p" className="mt-1.5 text-sm text-paper-mute" delay={120} stagger={18} />
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 导出表单 */}
        <section className="panel-elevated animate-fade-up p-6">
          <h2 className="mb-4 font-display text-lg text-paper-dim">新建导出</h2>
          <label className="mb-1.5 block text-xs font-medium text-paper-mute">项目</label>
          <select className="input mb-4" value={projectId} onChange={e => setProjectId(e.target.value)}>
            {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>

          <label className="mb-1.5 block text-xs font-medium text-paper-mute">格式</label>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {FORMATS.map(f => {
              const Icon = f.icon;
              const active = format === f.id;
              return (
                <button key={f.id} onClick={() => setFormat(f.id)}
                  className={cn('flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-all',
                    active ? 'border-amber-deep text-amber' : 'border-ink-500 text-paper-mute hover:border-amber-deep hover:text-paper-dim')}
                  style={active ? { background: 'rgba(212,165,52,0.08)' } : {}}>
                  <Icon size={20} />
                  <span className="font-medium">{f.label}</span>
                  <span className="text-[10px] text-paper-mute">{f.ext}</span>
                </button>
              );
            })}
          </div>

          <label className="mb-1.5 block text-xs font-medium text-paper-mute">章节范围（可选）</label>
          <input className="input mb-1" placeholder="如：1-5 或 1,3,5" value={range} onChange={e => setRange(e.target.value)} />
          <p className="mb-4 text-[11px] text-paper-mute">留空则导出全部章节。</p>

          <button className="btn-primary w-full" onClick={doExport} disabled={busy}>
            {busy ? <Spinner className="h-4 w-4" /> : <Download size={16} />} 开始导出
          </button>

          {lastFile && (
            <div className="mt-4 flex items-center justify-between rounded-md border p-3 animate-fade-in" style={{ borderColor: 'var(--celadon)', background: 'rgba(90,138,106,0.08)' }}>
              <div className="min-w-0">
                <p className="text-xs text-celadon">导出成功</p>
                <p className="truncate font-mono text-xs text-paper-dim">{lastFile.fileName}</p>
              </div>
              <a className="btn-ghost py-1.5 text-xs" href={api.exports.downloadUrl(lastFile.fileName)} target="_blank" rel="noreferrer">
                <Link2 size={13} /> 下载
              </a>
            </div>
          )}
        </section>

        {/* 历史 */}
        <section className="panel-elevated animate-fade-up p-6">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-display text-lg text-paper-dim"><History size={16} /> 导出历史</h2>
            <div className="flex items-center gap-2">
              {/* 第二十一修复: 全局清空按钮 - 永远显示,无记录时禁用
                  原 bug: 仅有"清空当前项目"按钮,切到无记录项目时完全看不到清空入口 */}
              <button
                className="btn-ghost flex items-center gap-1 py-1.5 text-xs text-cinnabar hover:text-cinnabar disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={() => setClearAllOpen(true)}
                disabled={history.length === 0}
                title={history.length === 0 ? '尚无导出记录可清空' : `清空全部 ${history.length} 条导出记录`}
              >
                <Trash2 size={12} /> 清空全部
              </button>
              {/* H4 修复(第十九轮): 清空当前项目全部导出记录按钮,仅当前项目有记录时显示 */}
              {projectId && projectHistoryCount > 0 && (
                <button
                  className="btn-ghost flex items-center gap-1 py-1.5 text-xs text-cinnabar hover:text-cinnabar"
                  onClick={() => setClearTarget(projectId)}
                  title={`清空「${projectTitle(projectId)}」的 ${projectHistoryCount} 条导出记录`}
                >
                  <Trash2 size={12} /> 清空当前项目
                </button>
              )}
            </div>
          </div>
          {history.length === 0 ? (
            <EmptyState icon={<Download size={32} />} title="尚无导出记录" desc="完成第一次导出后，记录会出现在这里。" />
          ) : (
            <ol className="relative space-y-3 border-l pl-4" style={{ borderColor: 'var(--ink-500)' }}>
              {history.map((r, i) => {
                const f = FORMATS.find(x => x.id === r.format);
                return (
                  <li key={r.id} className="relative animate-fade-up" style={{ animationDelay: `${i * 40}ms` }}>
                    <span className="absolute -left-[21px] top-3 h-2.5 w-2.5 rounded-full" style={{ background: 'var(--amber)', boxShadow: '0 0 0 3px var(--ink-800)' }} />
                    <div className="flex items-center gap-2">
                      <span className="badge badge-amber">{f?.label || r.format}</span>
                      <span className="truncate text-sm text-paper-dim">{r.filePath.split(/[\\/]/).pop()}</span>
                      {/* H4 修复(第十九轮): 单条删除按钮 */}
                      <button
                        className="ml-auto shrink-0 rounded p-1 text-paper-mute opacity-60 transition hover:bg-cinnabar/10 hover:text-cinnabar hover:opacity-100"
                        onClick={() => setDeleteTarget(r)}
                        title="删除此记录"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-paper-mute">{projectTitle(r.projectId)} · {fmtTime(r.createdAt)}</p>
                    <a className="mt-1.5 inline-flex items-center gap-1 text-xs text-amber hover:text-amber-bright"
                      href={api.exports.downloadUrl(r.filePath.split(/[\\/]/).pop() || r.filePath)} target="_blank" rel="noreferrer">
                      <Download size={12} /> 下载文件
                    </a>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>

      {/* H4 修复(第十九轮): 删除单条确认弹窗 */}
      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="删除导出记录"
      >
        <p className="text-sm text-paper-dim">
          确定删除导出记录「<span className="font-mono text-amber">{deleteTarget?.filePath.split(/[\\/]/).pop()}</span>」吗？
        </p>
        <p className="mt-2 text-xs text-paper-mute">将同时删除关联的导出文件，此操作不可撤销。</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</button>
          <button className="btn-danger" onClick={confirmDelete} disabled={deleting}>
            {deleting ? <Spinner className="h-4 w-4" /> : <Trash2 size={14} />} 删除
          </button>
        </div>
      </Modal>

      {/* H4 修复(第十九轮): 清空项目确认弹窗 */}
      <Modal
        open={!!clearTarget}
        onClose={() => setClearTarget(null)}
        title="清空导出历史"
      >
        <p className="text-sm text-paper-dim">
          确定清空项目「<span className="text-amber">{clearTarget ? projectTitle(clearTarget) : ''}</span>」的全部 <span className="font-mono text-amber">{projectHistoryCount}</span> 条导出记录吗？
        </p>
        <p className="mt-2 text-xs text-paper-mute">将同时删除所有关联的导出文件，此操作不可撤销。</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setClearTarget(null)} disabled={deleting}>取消</button>
          <button className="btn-danger" onClick={confirmClear} disabled={deleting}>
            {deleting ? <Spinner className="h-4 w-4" /> : <Trash2 size={14} />} 清空全部
          </button>
        </div>
      </Modal>

      {/* 第二十一修复: 全局清空全部确认弹窗 */}
      <Modal
        open={clearAllOpen}
        onClose={() => setClearAllOpen(false)}
        title="清空全部导出历史"
      >
        <p className="text-sm text-paper-dim">
          确定清空 <span className="font-mono text-amber">{history.length}</span> 条导出记录吗？
        </p>
        <p className="mt-2 text-xs text-paper-mute">将删除所有项目的全部导出记录及关联文件，此操作不可撤销。</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setClearAllOpen(false)} disabled={deleting}>取消</button>
          <button className="btn-danger" onClick={confirmClearAll} disabled={deleting}>
            {deleting ? <Spinner className="h-4 w-4" /> : <Trash2 size={14} />} 清空全部
          </button>
        </div>
      </Modal>

      {node}
    </div>
  );
}
