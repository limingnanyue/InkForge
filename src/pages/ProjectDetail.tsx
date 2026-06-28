/**
 * 项目详情 —— 章节树编辑器
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Sparkles, Wand2, Camera, Eye, Pencil, Globe, Trash2, Play } from 'lucide-react';
import { api } from '@/api/client';
import { useApp } from '@/stores/app';
import { Spinner, ProgressBar, fmtWords, Modal, useToast } from '@/components/ui';
import GenreSelect from '@/components/GenreSelect';
import type { Project, Chapter, ChapterNode, AgentState, ProjectType } from '@shared/types';
import { cn } from '@/lib/utils';
import ChapterTree, { flatten, countAll, countSnapshots, mutateNode } from './ChapterTree';

const STATUS: Record<string, [string, string]> = {
  draft: ['badge-mute', '草稿'], generating: ['badge-amber', '生成中'], done: ['badge-green', '完成'],
  failed: ['badge-red', '失败'],
};

const TYPE_LABEL: Record<ProjectType, string> = { long: '长篇', short: '短篇', script: '剧本' };
const TYPE_BADGE: Record<ProjectType, string> = { long: 'badge-amber', short: 'badge-green', script: 'badge-mute' };
// 伏笔状态：planted→琥珀"待回收" / paid→绿色"已回收"
const FORESHADOW_STATUS: Record<string, [string, string]> = {
  planted: ['badge-amber', '待回收'], paid: ['badge-green', '已回收'], expired: ['badge-red', '已过期'],
};
// 章节定位六类 → badge 颜色 + 中文标签（oh-story 章节定位分布可视化）
const POSITIONING_LABEL: Record<string, [string, string]> = {
  'high-pressure':     ['badge-red', '高压章'],
  'normal-progress':   ['badge-mute', '普通推进'],
  'trial-error':       ['badge-amber', '试错章'],
  'relationship':      ['badge-green', '关系回收'],
  'low-pressure':      ['badge-mute', '低压生活'],
  'info-organize':      ['badge-mute', '信息整理'],
};

const fmtDate = (t: number) => new Date(t).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { setCurrentProject, loadTasks, currentModel, currentProviderId } = useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [tree, setTree] = useState<ChapterNode[]>([]);
  const [selected, setSelected] = useState<ChapterNode | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snapshotCount, setSnapshotCount] = useState(0);
  const [webSearch, setWebSearch] = useState(project?.webSearchEnabled ?? false);
  const saveRef = useRef<number | null>(null);
  const { toast, node } = useToast();
  const [tab, setTab] = useState<'chapters' | 'brief' | 'outline' | 'state'>('chapters');
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [summary, setSummary] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [continueBusy, setContinueBusy] = useState(false);

  const confirmDelete = async () => {
    if (!project) return;
    setDeleteBusy(true);
    try {
      await api.projects.delete(project.id);
      toast('项目已删除');
      setDeleteOpen(false);
      navigate('/projects');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setDeleteBusy(false); }
  };

  // 继续写作：基于当前项目派发续写任务到守护进程
  const continueWriting = async () => {
    if (!project) return;
    setContinueBusy(true);
    try {
      await api.generate.continue(project.id);
      toast('已派发续写任务到守护进程');
      navigate('/daemon');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setContinueBusy(false); }
  };

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, chs, s] = await Promise.all([api.projects.get(id), api.projects.chapters(id), api.projects.state(id)]);
      setProject(p); setCurrentProject(p); setTree(chs); setAgentState(s);
      // F2 修复：记录"上次保存的标题"，用于 onBlurTitle 判断是否真的改动
      lastSavedTitleRef.current = p.title;
      setSelected(prev => prev ?? flatten(chs)[0] ?? null);
      setSnapshotCount(countSnapshots(chs));
    } catch (e) {
      // F5 修复：项目不存在（404）时 toast 一闪即过 + 永久 spinner。
      // 改为 toast 后跳回作品库，避免用户卡死在空白 spinner 页面
      const msg = (e as Error).message || '';
      toast(`加载项目失败：${msg}`, 'err');
      if (msg.includes('不存在') || msg.includes('404') || msg.includes('NOT_FOUND')) {
        navigate('/projects', { replace: true });
      }
    }
  }, [id, setCurrentProject, toast, navigate]);

  // 单独拉取智能体状态（Tab 切到 大纲/状态 时补拉）
  const loadState = useCallback(async () => {
    if (!id) return;
    try { setAgentState(await api.projects.state(id)); }
    catch (e) { toast((e as Error).message, 'err'); }
  }, [id, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (id) loadTasks(id); }, [id, loadTasks]);
  // 摘要本地态跟随项目数据
  useEffect(() => { setSummary(project?.summary ?? ''); }, [project?.summary]);
  // F2 修复：删除原标题同步 effect（原 effect 让 titleRef 永远等于 project.title → onBlurTitle 永远早返回 → 标题永远不保存）
  // 改用 lastSavedTitleRef 在 load()/保存成功时更新，仅跟踪"服务端已持久化的标题"
  // 切到 大纲/状态 时若状态未加载则补拉
  useEffect(() => {
    if ((tab === 'outline' || tab === 'state' || tab === 'brief') && !agentState) loadState();
  }, [tab, agentState, loadState]);

  // 联网搜索开关跟随项目配置
  useEffect(() => { setWebSearch(project?.webSearchEnabled ?? false); }, [project]);

  // SSE：任务完成/失败时刷新章节
  useEffect(() => {
    const off = api.streamEvents((e: any) => {
      if (e.type === 'task:progress') { if (id) loadTasks(id); }
      else if (e.type === 'task:done') { if (id) loadTasks(id); load(); }
      else if (e.type === 'task:failed') { toast(e.message || '任务失败', 'err'); if (id) loadTasks(id); }
    });
    return off;
  }, [id, load, loadTasks, toast]);

  // 防抖保存
  const scheduleSave = (patch: Partial<Chapter>) => {
    if (!selected) return;
    if (saveRef.current) window.clearTimeout(saveRef.current);
    const sid = selected.id;
    saveRef.current = window.setTimeout(async () => {
      try { await api.chapters.update(sid, patch); } catch (e) { toast((e as Error).message, 'err'); }
    }, 800);
  };

  const onEdit = (patch: Partial<Chapter>) => {
    if (!selected) return;
    const sid = selected.id;
    setSelected({ ...selected, ...patch });
    setTree(prev => mutateNode(prev, sid, n => Object.assign(n, patch)));
    scheduleSave(patch);
  };

  const onSelect = (n: ChapterNode) => { setSelected(n); setPreview(false); };

  const newChapter = async () => {
    if (!id) return;
    try {
      const c = await api.projects.addChapter(id, { title: `第 ${countAll(tree) + 1} 章`, parentId: null, outline: '', content: '' });
      await load();
      setSelected({ ...c, children: [] });
      toast('已新建章节');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  const gen = async (kind: 'generate' | 'refine') => {
    if (!selected) return;
    setBusy(true);
    try {
      const t = kind === 'generate' ? await api.chapters.generate(selected.id) : await api.chapters.refine(selected.id);
      toast(t.type === 'refine' ? '精修任务已派发' : '生成任务已派发');
      if (id) loadTasks(id);
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(false); }
  };

  const snapshot = async () => {
    if (!selected) return;
    try { await api.chapters.snapshot(selected.id); setSnapshotCount(c => c + 1); toast('已保存快照'); }
    catch (e) { toast((e as Error).message, 'err'); }
  };

  const toggleWebSearch = async () => {
    if (!project) return;
    const next = !webSearch;
    setWebSearch(next);
    try {
      const updated = await api.projects.update(project.id, { webSearchEnabled: next });
      setProject(updated);
      setCurrentProject(updated);
      toast(next ? '已开启联网搜索' : '已关闭联网搜索');
    } catch (e) {
      setWebSearch(!next);
      toast((e as Error).message, 'err');
    }
  };

  // 摘要失焦保存
  const onBlurSummary = async () => {
    if (!project) return;
    if (summary === project.summary) return;
    try {
      const updated = await api.projects.update(project.id, { summary });
      setProject(updated);
      setCurrentProject(updated);
      toast('已保存摘要');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  // AI 生成摘要：基于项目信息调 LLM 生成一句话简介，落 project.summary
  // 透传当前所选 model/providerId（不传则后端回落到 default 旗舰）
  const [genSummaryBusy, setGenSummaryBusy] = useState(false);
  const onGenerateSummary = async () => {
    if (!project) return;
    setGenSummaryBusy(true);
    try {
      const { summary: generated } = await api.projects.generateSummary(
        project.id, currentModel || undefined, currentProviderId || undefined,
      );
      setSummary(generated);
      const updated = await api.projects.get(project.id);
      setProject(updated);
      setCurrentProject(updated);
      toast('已生成简介');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setGenSummaryBusy(false); }
  };

  // AI 生成封面提示词：调 LLM 生成中英双段 prompt，落 agent_state.cover
  const [coverDraft, setCoverDraft] = useState('');
  const [genCoverBusy, setGenCoverBusy] = useState(false);
  // 当 agentState 加载后，把 cover 同步到 coverDraft 供编辑
  useEffect(() => { setCoverDraft(agentState?.cover || ''); }, [agentState?.cover]);
  const onGenerateCover = async () => {
    if (!project) return;
    setGenCoverBusy(true);
    try {
      const { cover } = await api.projects.generateCover(
        project.id, currentModel || undefined, currentProviderId || undefined,
      );
      setCoverDraft(cover);
      // 同步本地 agentState（避免再次切 Tab 拉取）
      setAgentState(s => s ? { ...s, cover } : s);
      toast('已生成封面提示词');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setGenCoverBusy(false); }
  };
  // 封面提示词失焦保存（走 PATCH /state）
  const onBlurCover = async () => {
    if (!project || !agentState) return;
    if (coverDraft === agentState.cover) return;
    try {
      const updated = await api.projects.updateState(project.id, { cover: coverDraft });
      setAgentState(updated);
      toast('已保存封面提示词');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  // 标题失焦保存（仅当变化时才请求，避免无谓请求 + 污染 updatedAt）
  // F2 修复：原用 useState titleRef + effect 同步 → 永远等于 project.title → 永远早返回（死代码，标题永不保存）
  // 改用 useRef 跟踪"上次保存的标题"，仅在 load()/保存成功时更新
  const lastSavedTitleRef = useRef('');
  const onBlurTitle = async () => {
    if (!project) return;
    if (project.title === lastSavedTitleRef.current) return; // 未改动
    try {
      const updated = await api.projects.update(project.id, { title: project.title });
      setProject(updated);
      setCurrentProject(updated);
      lastSavedTitleRef.current = updated.title;
      toast('已保存标题');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  // 题材即时保存（GenreSelect onChange 即触发；只有变化时才写库）
  const onBlurGenre = async (genreId: string, label: string) => {
    if (!project) return;
    const nextGenreId = genreId || undefined;
    if (project.genre === label && (project.genreId || undefined) === nextGenreId) return;
    try {
      const updated = await api.projects.update(project.id, { genre: label, genreId: nextGenreId });
      setProject(updated);
      setCurrentProject(updated);
      toast(label ? `已切换题材：${label}` : '已清空题材');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  if (!project) return <div className="flex h-full items-center justify-center text-paper-mute"><Spinner /></div>;

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3 md:px-8" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
        <button className="btn-ghost py-1.5 text-xs" onClick={() => navigate('/projects')}><ArrowLeft size={14} /> 作品库</button>
        <input className="min-w-0 flex-1 bg-transparent font-display text-xl text-paper outline-none focus:text-amber"
          value={project.title}
          onChange={e => setProject({ ...project, title: e.target.value })}
          onBlur={onBlurTitle} />
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden w-40 sm:block">
            <ProgressBar value={project.targetWords ? project.currentWords / project.targetWords : 0} />
            <p className="mt-1 text-[10px] text-paper-mute">{fmtWords(project.currentWords)} / {fmtWords(project.targetWords)}</p>
          </div>
          <button className="btn-ghost py-1.5 text-xs" onClick={() => navigate('/studio')}>工作台</button>
          <button className="btn-primary py-1.5 text-xs" onClick={continueWriting} disabled={continueBusy} title="派发续写任务到守护进程">
            {continueBusy ? <Spinner className="h-3.5 w-3.5" /> : <Play size={13} />} 继续写作
          </button>
          <button className="btn-ghost py-1.5 text-xs" onClick={() => navigate('/export')}>导出</button>
          <button className="btn-ghost py-1.5 text-xs text-cinnabar" title="删除项目" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={14} /> 删除
          </button>
        </div>
      </header>

      {/* 联网搜索配置条 */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5 md:px-8" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
        <Globe size={14} className={cn('shrink-0 transition-colors', webSearch ? 'text-amber' : 'text-paper-mute')} />
        <button type="button" role="switch" aria-checked={webSearch}
          className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', webSearch ? 'bg-amber' : 'bg-ink-500')}
          onClick={toggleWebSearch}>
          <span className={cn('absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-paper transition-transform', webSearch && 'translate-x-4')} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-paper-dim">联网搜索取材</p>
          <p className="truncate text-[11px] leading-relaxed text-paper-mute">开启后，本项目对话/生成默认启用联网搜索（可在工作台临时关闭）</p>
        </div>
      </div>

      {/* Tab 切换条 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-4 md:px-8" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
        {([
          { key: 'chapters', label: '章节' },
          { key: 'brief', label: '简介' },
          { key: 'outline', label: '大纲' },
          { key: 'state', label: '状态' },
        ] as const).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={cn('relative px-4 py-2.5 text-sm font-medium transition-colors', tab === t.key ? 'text-amber' : 'text-paper-mute hover:text-paper-dim')}>
            {t.label}
            {tab === t.key && <span className="absolute bottom-0 left-0 right-0 h-0.5" style={{ background: 'var(--amber)' }} />}
          </button>
        ))}
      </div>

      {tab === 'chapters' ? (
        <>
        <div className="flex flex-1 overflow-hidden">
        {/* 左侧：章节树 */}
        <aside className="hidden w-72 shrink-0 flex-col border-r md:flex" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
          <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: 'var(--ink-600)' }}>
            <span className="text-xs font-medium text-paper-mute">章节</span>
            <button className="flex items-center gap-1 text-xs text-amber hover:text-amber-bright" onClick={newChapter}><Plus size={13} /> 新建</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {tree.length === 0 ? <p className="px-2 py-4 text-center text-xs text-paper-mute">尚无章节</p> :
              <ChapterTree nodes={tree} collapsed={collapsed} setCollapsed={setCollapsed} selectedId={selected?.id} onSelect={onSelect} />}
          </div>
          <div className="border-t px-3 py-2 text-[11px] text-paper-mute" style={{ borderColor: 'var(--ink-600)' }}>
            共 {countAll(tree)} 章 · 快照 {snapshotCount}
          </div>
        </aside>

        {/* 右侧：编辑器 */}
        <section className="flex flex-1 flex-col overflow-hidden">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5 md:px-8" style={{ borderColor: 'var(--ink-600)' }}>
                <input className="min-w-0 flex-1 bg-transparent font-display text-lg text-paper outline-none focus:text-amber"
                  value={selected.title} onChange={e => onEdit({ title: e.target.value })} />
                <span className={cn('badge', STATUS[selected.status][0])}>{STATUS[selected.status][1]}</span>
                <span className="text-xs text-paper-mute">{fmtWords(selected.wordCount)} 字</span>
                <button className="btn-ghost py-1.5 text-xs" onClick={() => setPreview(v => !v)}>
                  {preview ? <><Pencil size={13} /> 编辑</> : <><Eye size={13} /> 预览</>}
                </button>
                <button className="btn-ghost py-1.5 text-xs" onClick={() => gen('refine')} disabled={busy}><Wand2 size={13} /> 精修</button>
                <button className="btn-ghost py-1.5 text-xs" onClick={snapshot}><Camera size={13} /> 快照</button>
                <button className="btn-primary py-1.5 text-xs" onClick={() => gen('generate')} disabled={busy}>
                  {busy ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles size={13} />} AI 生成
                </button>
              </div>
              <div className="grid flex-1 grid-cols-1 overflow-hidden lg:grid-cols-2">
                <div className="flex flex-col overflow-hidden border-b lg:border-b-0 lg:border-r" style={{ borderColor: 'var(--ink-600)' }}>
                  <p className="shrink-0 border-b px-4 py-1.5 text-[11px] uppercase tracking-wider text-paper-mute md:px-8" style={{ borderColor: 'var(--ink-600)' }}>大纲</p>
                  <textarea className="flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-paper-dim outline-none md:px-8"
                    placeholder="本章要点、情节走向…" value={selected.outline} onChange={e => onEdit({ outline: e.target.value })} />
                </div>
                <div className="flex flex-col overflow-hidden">
                  <p className="shrink-0 border-b px-4 py-1.5 text-[11px] uppercase tracking-wider text-paper-mute md:px-8" style={{ borderColor: 'var(--ink-600)' }}>正文</p>
                  {preview ? (
                    <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8">
                      <div className="prose-ink whitespace-pre-wrap">{selected.content || '（暂无正文）'}</div>
                    </div>
                  ) : (
                    <textarea className="prose-ink flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-paper outline-none md:px-8"
                      placeholder="在此撰写正文…" value={selected.content} onChange={e => onEdit({ content: e.target.value })} />
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-paper-mute">请选择或新建章节</div>
          )}
        </section>
      </div>

        {/* 移动端章节下拉 */}
        <div className="border-t px-3 py-2 md:hidden" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
          <select className="input py-1.5 text-sm" value={selected?.id || ''} onChange={e => { const n = flatten(tree).find(x => x.id === e.target.value); if (n) onSelect(n); }}>
            {flatten(tree).map(n => <option key={n.id} value={n.id}>{n.title}</option>)}
          </select>
        </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* 简介 Tab */}
          {tab === 'brief' && (
            <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
              <div className="panel-elevated p-5">
                <h2 className="mb-4 font-display text-lg text-paper">项目信息</h2>
                <div className="space-y-4">
                  <div>
                    <p className="mb-1 text-[11px] uppercase tracking-wider text-paper-mute">标题</p>
                    <p className="font-display text-base text-paper">{project.title}</p>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-[11px] uppercase tracking-wider text-paper-mute">项目摘要</p>
                      <button
                        className="btn-ghost flex items-center gap-1 py-1 text-[11px] text-amber hover:text-amber-deep"
                        onClick={onGenerateSummary}
                        disabled={genSummaryBusy}
                        title="基于项目信息 + 最近章节摘要 AI 生成一句话简介"
                      >
                        {genSummaryBusy ? <Spinner className="h-3 w-3" /> : <Sparkles size={12} />}
                        {genSummaryBusy ? '生成中…' : 'AI 生成'}
                      </button>
                    </div>
                    <textarea className="input min-h-[110px] resize-y leading-relaxed" placeholder="一句话概括你的故事核心…" value={summary} onChange={e => setSummary(e.target.value)} onBlur={onBlurSummary} />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-[11px] uppercase tracking-wider text-paper-mute">封面提示词</p>
                      <button
                        className="btn-ghost flex items-center gap-1 py-1 text-[11px] text-amber hover:text-amber-deep"
                        onClick={onGenerateCover}
                        disabled={genCoverBusy}
                        title="基于项目信息 AI 生成中英双段封面绘图 prompt"
                      >
                        {genCoverBusy ? <Spinner className="h-3 w-3" /> : <Camera size={12} />}
                        {genCoverBusy ? '生成中…' : 'AI 生成'}
                      </button>
                    </div>
                    <textarea
                      className="input min-h-[140px] resize-y font-mono text-xs leading-relaxed"
                      placeholder="点击「AI 生成」产生封面提示词（中文描述 + 英文 Prompt），可直接复制到 SD/MJ 使用…"
                      value={coverDraft}
                      onChange={e => setCoverDraft(e.target.value)}
                      onBlur={onBlurCover}
                    />
                    {coverDraft && (
                      <div className="mt-1 flex justify-end">
                        <button
                          className="text-[10px] text-paper-mute hover:text-amber"
                          onClick={() => { navigator.clipboard?.writeText(coverDraft); toast('已复制到剪贴板'); }}
                        >复制全部</button>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <p className="mb-1 text-[11px] uppercase tracking-wider text-paper-mute">题材</p>
                      <GenreSelect
                        value={project.genreId}
                        label={project.genre}
                        onChange={(genreId, label) => onBlurGenre(genreId, label)}
                      />
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] uppercase tracking-wider text-paper-mute">类型 / 字数</p>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className={cn('badge', TYPE_BADGE[project.type])}>{TYPE_LABEL[project.type]}</span>
                        <span className="text-sm text-paper-dim">{fmtWords(project.currentWords)} / {fmtWords(project.targetWords)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-6 border-t pt-3" style={{ borderColor: 'var(--ink-500)' }}>
                    <div>
                      <p className="mb-1 text-[11px] uppercase tracking-wider text-paper-mute">创建时间</p>
                      <p className="text-xs text-paper-dim">{fmtDate(project.createdAt)}</p>
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] uppercase tracking-wider text-paper-mute">更新时间</p>
                      <p className="text-xs text-paper-dim">{fmtDate(project.updatedAt)}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 大纲 Tab */}
          {tab === 'outline' && (
            <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
              <div className="panel-elevated p-5">
                <h3 className="mb-3 font-display text-base text-paper">创意</h3>
                {agentState?.idea ? (
                  <div className="prose-ink whitespace-pre-wrap text-sm">{agentState.idea}</div>
                ) : (
                  <p className="text-xs text-paper-mute">尚未生成，请到工作台或一键生成</p>
                )}
              </div>
              <div className="panel-elevated p-5">
                <h3 className="mb-3 font-display text-base text-paper">世界观设定</h3>
                {agentState?.setting ? (
                  <div className="prose-ink whitespace-pre-wrap text-sm">{agentState.setting}</div>
                ) : (
                  <p className="text-xs text-paper-mute">尚未生成，请到工作台或一键生成</p>
                )}
              </div>
            </div>
          )}

          {/* 状态 Tab */}
          {tab === 'state' && (
            <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-8">
              <div className="panel-elevated p-5">
                <h3 className="mb-3 font-display text-base text-paper">创意</h3>
                {agentState?.idea ? (
                  <div className="prose-ink whitespace-pre-wrap text-sm">{agentState.idea}</div>
                ) : <p className="text-xs text-paper-mute">暂无内容</p>}
              </div>
              <div className="panel-elevated p-5">
                <h3 className="mb-3 font-display text-base text-paper">设定</h3>
                {agentState?.setting ? (
                  <div className="prose-ink whitespace-pre-wrap text-sm">{agentState.setting}</div>
                ) : <p className="text-xs text-paper-mute">暂无内容</p>}
              </div>
              <div className="panel-elevated p-5">
                <h3 className="mb-3 font-display text-base text-paper">角色</h3>
                {agentState?.characters ? (
                  <div className="prose-ink whitespace-pre-wrap text-sm">{agentState.characters}</div>
                ) : <p className="text-xs text-paper-mute">暂无内容</p>}
              </div>
              <div className="panel-elevated p-5">
                <h3 className="mb-3 font-display text-base text-paper">记忆</h3>
                {agentState?.memory ? (
                  <div className="prose-ink whitespace-pre-wrap text-sm">{agentState.memory}</div>
                ) : <p className="text-xs text-paper-mute">暂无内容</p>}
              </div>

              {/* 伏笔追踪表 */}
              <div className="panel-elevated p-5">
                <h3 className="mb-3 font-display text-base text-paper">伏笔追踪表</h3>
                {agentState?.foreshadowing?.length ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase tracking-wider text-paper-mute" style={{ borderColor: 'var(--ink-500)' }}>
                        <th className="py-2 pr-2">序号</th>
                        <th className="py-2 pr-2">描述</th>
                        <th className="py-2 pr-2">埋设</th>
                        <th className="py-2 pr-2">重要度</th>
                        <th className="py-2 pr-2">预计回收</th>
                        <th className="py-2 pr-2">实际回收</th>
                        <th className="py-2">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agentState.foreshadowing.map((f, i) => {
                        const st = FORESHADOW_STATUS[f.status] ?? ['badge-mute', f.status];
                        const impColor = f.importance === 'high' ? 'text-cinnabar' : (f.importance === 'low' ? 'text-paper-mute' : 'text-paper-dim');
                        const impLabel = f.importance === 'high' ? '主线' : (f.importance === 'low' ? '支线' : (f.importance ? '中' : '—'));
                        return (
                          <tr key={f.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--ink-600)' }}>
                            <td className="py-2 pr-2 text-paper-mute">{i + 1}</td>
                            <td className="py-2 pr-2 text-paper-dim">{f.desc}</td>
                            <td className="py-2 pr-2 text-paper-mute">第 {f.plantedAt + 1} 章</td>
                            <td className={cn('py-2 pr-2', impColor)}>{impLabel}</td>
                            <td className="py-2 pr-2 text-paper-mute">{typeof f.expectedRecycleAt === 'number' ? `第 ${f.expectedRecycleAt + 1} 章` : '—'}</td>
                            <td className="py-2 pr-2 text-paper-mute">{typeof f.paidAt === 'number' ? `第 ${f.paidAt + 1} 章` : '—'}</td>
                            <td className="py-2">
                              <span className={cn('badge', st[0])}>{st[1]}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : <p className="text-xs text-paper-mute">暂无伏笔记录</p>}
              </div>

              {/* 角色实时状态表 */}
              <div className="panel-elevated p-5">
                <h3 className="mb-3 font-display text-base text-paper">角色实时状态</h3>
                {agentState?.characterState?.length ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase tracking-wider text-paper-mute" style={{ borderColor: 'var(--ink-500)' }}>
                        <th className="py-2 pr-2">姓名</th>
                        <th className="py-2 pr-2">位置</th>
                        <th className="py-2 pr-2">情绪</th>
                        <th className="py-2">关系</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agentState.characterState.map((c, i) => (
                        <tr key={i} className="border-b last:border-b-0" style={{ borderColor: 'var(--ink-600)' }}>
                          <td className="py-2 pr-2 text-paper">{c.name}</td>
                          <td className="py-2 pr-2 text-paper-dim">{c.location}</td>
                          <td className="py-2 pr-2 text-paper-dim">{c.mood}</td>
                          <td className="py-2 text-paper-mute">{c.relationships}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="text-xs text-paper-mute">暂无角色状态</p>}
              </div>

              {/* 章节摘要列表（oh-story：展示章节定位/字数/核心情绪） */}
              <div className="panel-elevated p-5">
                <h3 className="mb-3 font-display text-base text-paper">章节摘要</h3>
                {agentState?.chapterSummaries?.length ? (
                  <ul className="space-y-3">
                    {agentState.chapterSummaries.map((c, i) => {
                      const pos = c.positioning ? (POSITIONING_LABEL[c.positioning] ?? ['badge-mute', c.positioning]) : null;
                      return (
                        <li key={i}>
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-paper-dim">第 {c.idx + 1} 章 《{c.title}》</p>
                            {pos && <span className={cn('badge', pos[0])}>{pos[1]}</span>}
                            {c.coreEmotion && <span className="badge badge-mute">{c.coreEmotion}</span>}
                            {typeof c.wordBudget === 'number' && c.wordBudget > 0 && (
                              <span className="text-[11px] text-paper-mute">{c.wordBudget} 字</span>
                            )}
                          </div>
                          <p className="text-xs leading-relaxed text-paper-mute">{c.summary}</p>
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="text-xs text-paper-mute">暂无章节摘要</p>}
              </div>

              {/* 卷级大纲（oh-story 长篇分卷结构） */}
              {agentState?.volumeOutlines && agentState.volumeOutlines.length > 0 && (
                <div className="panel-elevated p-5">
                  <h3 className="mb-3 font-display text-base text-paper">卷级大纲</h3>
                  <ul className="space-y-3">
                    {agentState.volumeOutlines.map((v, i) => (
                      <li key={i} className="border-l-2 pl-3" style={{ borderColor: 'var(--cinnabar-500)' }}>
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-paper">第 {v.idx + 1} 卷 《{v.title}》</span>
                          <span className="badge badge-mute">{v.emotionArc}</span>
                          <span className="text-[11px] text-paper-mute">第 {v.chapterRange[0] + 1}-{v.chapterRange[1] + 1} 章</span>
                        </div>
                        <p className="text-xs leading-relaxed text-paper-dim">{v.premise}</p>
                        {v.keyForeshadows.length > 0 && (
                          <p className="mt-1 text-[11px] text-paper-mute">伏笔集群：{v.keyForeshadows.join(' / ')}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="删除项目">
        <p className="text-sm leading-relaxed text-paper-dim">
          确定删除作品 <span className="font-display text-cinnabar">《{project.title}》</span> 吗？
        </p>
        <p className="mt-2 text-xs leading-relaxed text-paper-mute">
          该操作不可恢复，将同时删除其全部章节、智能体状态、任务记录与对话消息。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setDeleteOpen(false)}>取消</button>
          <button className="btn-primary" onClick={confirmDelete} disabled={deleteBusy}>
            {deleteBusy ? <Spinner className="h-4 w-4" /> : <Trash2 size={16} />} 确认删除
          </button>
        </div>
      </Modal>
      {node}
    </div>
  );
}
