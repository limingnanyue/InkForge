/**
 * 导出中心 —— 多格式成书导出与历史
 */
import { useEffect, useState } from 'react';
import { Download, FileText, FileCode, BookOpen, FileType, History, Link2 } from 'lucide-react';
import { api } from '@/api/client';
import BlurText from '@/components/BlurText';
import { Spinner, EmptyState, fmtTime, useToast } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Project, ExportRecord, ExportFormat } from '@shared/types';

const FORMATS: { id: ExportFormat; label: string; icon: typeof FileText; ext: string }[] = [
  { id: 'txt', label: 'TXT', icon: FileText, ext: '纯文本' },
  { id: 'markdown', label: 'Markdown', icon: FileCode, ext: '.md' },
  { id: 'epub', label: 'EPUB', icon: BookOpen, ext: '电子书' },
  { id: 'docx', label: 'DOCX', icon: FileType, ext: 'Word' },
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

  const projectTitle = (id: string) => projects.find(p => p.id === id)?.title || '已删除项目';

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
          <h2 className="mb-4 flex items-center gap-2 font-display text-lg text-paper-dim"><History size={16} /> 导出历史</h2>
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
      {node}
    </div>
  );
}
