/**
 * 项目详情 —— 章节树编辑器
 */
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Sparkles, Wand2, Camera, Eye, Pencil, Globe, Trash2, Play, Sliders, Image as ImageIcon, Download } from 'lucide-react';
import { api } from '@/api/client';
import { useApp } from '@/stores/app';
import { Spinner, ProgressBar, fmtWords, Modal, useToast, Switch, Field, SegmentedControl, Slider } from '@/components/ui';
import GenreSelect from '@/components/GenreSelect';
import type { Project, Chapter, ChapterNode, AgentState, ProjectType, ProviderKind } from '@shared/types';
import { cn } from '@/lib/utils';
import ChapterTree, { flatten, countSnapshots, mutateNode } from './ChapterTree';

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
  const { setCurrentProject, loadTasks, currentModel, currentProviderId, providers } = useApp();
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
  const [refineBookBusy, setRefineBookBusy] = useState(false);
  // BUG1 修复: 续写时让用户选 chapterWordBudget(默认从项目历史章节平均字数推断)
  // 原 bug: ProjectDetail.continueWriting 不传 chapterWordBudget → daemon 走 infer(取历史平均)
  // → 若用户在 Generate 页选了 2000 字但项目历史章节是 2500 字,续写会用 2500 字 → 字数不一致
  const [continueOpen, setContinueOpen] = useState(false);
  const [continueBudget, setContinueBudget] = useState<number>(2500);
  // 切项目时从已完成章节平均字数推断默认 chapterWordBudget
  useEffect(() => {
    if (!project) return;
    const isShort = project.type === 'short';
    const defaultBudget = isShort ? 5000 : 2500;
    const allChapters = flatten(tree);
    const doneChapters = allChapters.filter(c => c.content && c.wordCount > 100);
    if (doneChapters.length === 0) {
      setContinueBudget(defaultBudget);
      return;
    }
    const avg = doneChapters.reduce((s, c) => s + (c.wordCount || 0), 0) / doneChapters.length;
    // M5 修复(第十一轮): clamp 范围与 Generate 页 + 续写 Modal slider 一致: book 1500-10000, short 2000-12000
    const min = isShort ? 2000 : 1500;
    const max = isShort ? 12000 : 10000;
    setContinueBudget(Math.max(min, Math.min(max, Math.round(avg))));
  }, [project, tree]);

  // BUG1 修复：缓存 flatten 结果，避免 countAll(tree) 与移动端下拉在每次 render 多次全树遍历
  const flatTree = useMemo(() => flatten(tree), [tree]);
  const chapterCount = useMemo(() => flatTree.length, [flatTree]);

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
  // BUG1 修复: 透传 chapterWordBudget 到后端,避免 daemon 回落 infer 导致字数不一致
  // 原流程直接派发 → daemon 用 cfg.chapterWordBudget ?? inferChapterWordBudget(projectId) → 续写字数与原项目历史一致但不一定符合用户期望
  // 现流程: 点"继续写作"先打开 Modal 让用户确认/调整 chapterWordBudget,确认后才派发
  const continueWriting = async () => {
    if (!project) return;
    setContinueBusy(true);
    try {
      await api.generate.continue(project.id, undefined, currentModel || undefined, currentProviderId || undefined, continueBudget);
      toast(`已派发续写任务到守护进程（每章约 ${continueBudget} 字）`);
      setContinueOpen(false);
      navigate('/daemon');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setContinueBusy(false); }
  };

  // 整书去 AI 味精修：批量精修项目所有已生成章节，入队守护进程任务
  // 透传当前所选 model/providerId（不传则后端回落到 default 旗舰）
  const refineBook = async () => {
    if (!project) return;
    setRefineBookBusy(true);
    try {
      await api.projects.refineBook(project.id, currentModel || undefined, currentProviderId || undefined);
      toast('已派发整书精修任务到守护进程');
      navigate('/daemon');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setRefineBookBusy(false); }
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
    if ((tab === 'outline' || tab === 'state') && !agentState) loadState();
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
      try {
        await api.chapters.update(sid, patch);
        // BUG1 修复：setTree 延迟到防抖保存成功后执行，避免每次按键都 mutateNode（O(n) 全树复制）
        setTree(prev => mutateNode(prev, sid, n => Object.assign(n, patch)));
      } catch (e) { toast((e as Error).message, 'err'); }
    }, 800);
  };
  // BUG-5 修复：组件卸载时清理防抖定时器，避免编辑后立刻返回作品库时 800ms 定时器
  // 仍触发 api.chapters.update（对已删除章节 404，对仍存在章节写脏值）
  useEffect(() => () => { if (saveRef.current) window.clearTimeout(saveRef.current); }, []);

  const onEdit = (patch: Partial<Chapter>) => {
    if (!selected) return;
    // BUG1 修复：打字时只更新 selected 本地态，不立即 setTree（避免每键 O(n) 复制整棵树）
    setSelected({ ...selected, ...patch });
    scheduleSave(patch);
  };

  const onSelect = (n: ChapterNode) => { setSelected(n); setPreview(false); };

  const newChapter = async () => {
    if (!id) return;
    try {
      const c = await api.projects.addChapter(id, { title: `第 ${chapterCount + 1} 章`, parentId: null, outline: '', content: '' });
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
    // BUG4 修复：生成期间（含 textarea 被 disabled 触发的程序化 blur）跳过，避免覆盖 AI 刚生成的值
    if (genSummaryBusy) return;
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
  // 升级：支持风格预设 / 书名覆盖 / 作者署名，跨项目记忆风格与作者
  const COVER_STYLE_OPTIONS: Array<{ key: string; label: string }> = [
    { key: 'realistic',  label: '写实摄影' },
    { key: 'anime',      label: '动漫' },
    { key: 'oil',        label: '油画' },
    { key: 'watercolor', label: '水彩' },
    { key: 'cyberpunk',  label: '赛博朋克' },
    { key: 'fantasy',    label: '奇幻' },
    { key: 'aesthetic',  label: '唯美插画' },
    { key: 'retro',      label: '复古' },
    { key: 'monochrome', label: '黑白' },
    { key: 'inkwash',    label: '东方水墨' },
  ];
  // 平台风格库(参考 oh-story-claudecode/skills/story-cover cover-styles.md)
  // 各网文平台有明确视觉风格:番茄高饱和/起点精致/晋江唯美/知乎极简/七猫冲击/刺猬猫二次元
  const COVER_PLATFORM_OPTIONS: Array<{ key: string; label: string }> = [
    { key: 'generic',   label: '通用' },
    { key: 'fanqie',    label: '番茄小说' },
    { key: 'qidian',    label: '起点中文网' },
    { key: 'jjwxc',     label: '晋江文学城' },
    { key: 'zhihu',     label: '知乎盐言' },
    { key: 'qimao',     label: '七猫小说' },
    { key: 'ciweimao',  label: '刺猬猫' },
  ];
  const [coverDraft, setCoverDraft] = useState('');
  const [genCoverBusy, setGenCoverBusy] = useState(false);
  // 风格 / 作者 / 平台：跨项目记忆（localStorage 持久化）
  const [coverStyle, setCoverStyle] = useState<string>(() => {
    try { return localStorage.getItem('inkforge.cover.style') || 'realistic'; }
    catch { return 'realistic'; }
  });
  // 平台风格(oh-story 移植):番茄/起点/晋江等,影响 prompt 的视觉关键词与字体风格
  const [coverPlatform, setCoverPlatform] = useState<string>(() => {
    try { return localStorage.getItem('inkforge.cover.platform') || 'generic'; }
    catch { return 'generic'; }
  });
  const [coverAuthor, setCoverAuthor] = useState<string>(() => {
    try { return localStorage.getItem('inkforge.cover.author') || ''; }
    catch { return ''; }
  });
  // 书名：默认跟随 project.title，用户手动改动后保留用户值
  const [coverBookTitle, setCoverBookTitle] = useState<string>('');
  const coverTitleTouchedRef = useRef(false);
  // BUG3 修复: 封面预览图支持选择图像供应商
  // 原 bug: onGenerateCoverPreview 硬编码调用 TRAE 系统 text_to_image 端点,
  //        用户无法切换到自配的 OpenAI/KKAPI 等支持 DALL·E/SD/FLUX 的供应商
  // 现方案: 加图像供应商下拉(默认 TRAE 兜底,可切换到 OpenAI 兼容网关的 /images/generations)
  // 选值格式: `${providerId}::${model}` 或 '' 表示走 TRAE 系统默认
  const [coverImageProvider, setCoverImageProvider] = useState<string>('');
  // G6 修复：脏标记防 coverDraft 被重拉的 agentState.cover 覆盖未保存编辑
  // 触发场景：用户编辑 textarea 未 blur → 切 Tab 触发 loadState 重拉 → effect 把 coverDraft 重置为服务端旧值
  const coverDirtyRef = useRef(false);
  // 切换项目时重置书名 touched 标记与 coverDraft 脏标记，让新书名跟随新 project.title，避免旧值残留串到新项目
  useEffect(() => {
    coverTitleTouchedRef.current = false;
    setCoverBookTitle('');
    coverDirtyRef.current = false;
    // BUG3: 切项目重置图像供应商选择,避免上一项目选定的 provider::model 串到新项目
    setCoverImageProvider('');
  }, [id]);
  // M3 修复(第十二轮): 所选图像供应商被删除时自动清空 coverImageProvider,避免静默回落 TRAE
  // 原: provider 删除后 coverImageProvider 仍是旧 providerId,下拉 value 不匹配任何 option,
  //     onGenerateCoverPreview 走 TRAE 兜底但 toast 不明示,用户以为用的是自配供应商
  useEffect(() => {
    if (!coverImageProvider) return;
    const pid = coverImageProvider.split('::')[0];
    if (!providers.find(p => p.id === pid)) {
      setCoverImageProvider('');
      toast('所选图像供应商已被删除,已切回系统默认', 'err');
    }
  }, [providers, coverImageProvider, toast]);
  useEffect(() => {
    if (!coverTitleTouchedRef.current && project) {
      setCoverBookTitle(project.title);
    }
  }, [project?.title, project]);
  // 当 agentState 加载后，把 cover 同步到 coverDraft 供编辑（仅当用户未在编辑时）
  useEffect(() => {
    if (!coverDirtyRef.current) setCoverDraft(agentState?.cover || '');
  }, [agentState?.cover]);
  const onGenerateCover = async () => {
    if (!project) return;
    setGenCoverBusy(true);
    try {
      // 持久化风格 / 平台 / 作者（跨项目复用，避免每次重选）
      try {
        localStorage.setItem('inkforge.cover.style', coverStyle);
        localStorage.setItem('inkforge.cover.platform', coverPlatform);
        localStorage.setItem('inkforge.cover.author', coverAuthor);
      } catch { /* localStorage 不可用，忽略 */ }
      const { cover } = await api.projects.generateCover(project.id, {
        model: currentModel || undefined,
        providerId: currentProviderId || undefined,
        style: coverStyle,
        platform: coverPlatform,
        bookTitle: coverBookTitle.trim() || project.title,
        author: coverAuthor.trim() || undefined,
      });
      setCoverDraft(cover);
      coverDirtyRef.current = false;  // 生成的新值已是服务端最新，清脏标记
      // 同步本地 agentState（避免再次切 Tab 拉取）
      setAgentState(s => s ? { ...s, cover } : s);
      toast('已生成封面提示词');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setGenCoverBusy(false); }
  };
  // 封面预览图：调 text_to_image API 生成图片，用 canvas 叠加书名+作者文字
  // BUG2 修复：原流程只生成 prompt 文本，用户复制到 SD/MJ 生成图片后画面无书名/作者署名
  // 现流程：应用内直接生成图片 + canvas 叠加文字，提供完整书籍封面
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string>('');
  const [coverPreviewBusy, setCoverPreviewBusy] = useState(false);
  const coverPreviewAbortRef = useRef<AbortController | null>(null);
  // 切项目时清空预览图(避免上一项目的图残留)
  useEffect(() => { setCoverPreviewUrl(''); }, [id]);
  // B3 修复: 组件卸载时 abort 进行中的预览图请求,防 fetch 在后台继续消耗网络
  useEffect(() => () => { coverPreviewAbortRef.current?.abort(); }, []);

  // 从 coverDraft 提取英文 Prompt 部分（"Prompt:" 行之后的内容）
  const extractEnPrompt = (draft: string): string => {
    if (!draft) return '';
    // 匹配 "Prompt:" 或 "Prompt：" 后的内容（容错中英文冒号）
    const m = draft.match(/Prompt[:：]\s*([\s\S]+)/i);
    if (m && m[1]) return m[1].trim();
    // 兜底：若没匹配到 Prompt: 标记，取最后一段非中文为主的内容
    const lines = draft.split('\n').filter(l => l.trim());
    const enLine = lines.find(l => /^[\x00-\x7f,\. ]+$/.test(l.trim()) && l.trim().length > 30);
    return enLine || draft.trim();
  };

  // canvas 在图片上叠加书名 + 作者文字，返回 dataURL
  const overlayTextOnImage = (imgUrl: string, title: string, author: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';  // 允许 canvas 读取像素（否则 toDataURL 报 tainted canvas）
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('canvas 2d context 不可用')); return; }
          // 绘制底图
          ctx.drawImage(img, 0, 0);
          // 底部渐变蒙版（让文字可读）
          const h = canvas.height;
          const gradient = ctx.createLinearGradient(0, h * 0.6, 0, h);
          gradient.addColorStop(0, 'rgba(8,6,4,0)');
          gradient.addColorStop(1, 'rgba(8,6,4,0.85)');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, h * 0.6, canvas.width, h * 0.4);
          // 书名（金色，居中，自适应字号）
          const titleText = title || '';
          const fontSize = Math.max(28, Math.round(canvas.width / 14));
          ctx.font = `bold ${fontSize}px "Noto Serif SC", "Songti SC", serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = '#D4A534';  // 琥珀金
          ctx.shadowColor = 'rgba(0,0,0,0.8)';
          ctx.shadowBlur = 8;
          ctx.shadowOffsetY = 2;
          const titleY = h - fontSize * 1.5;
          ctx.fillText(titleText, canvas.width / 2, titleY, canvas.width * 0.9);
          // 作者署名（米白色，小字号）
          ctx.shadowBlur = 4;
          if (author) {
            const authorSize = Math.max(14, Math.round(fontSize * 0.4));
            ctx.font = `${authorSize}px "Noto Sans SC", sans-serif`;
            ctx.fillStyle = '#F5E6C8';
            ctx.fillText(`—— ${author}`, canvas.width / 2, h - authorSize * 1.2, canvas.width * 0.9);
          }
          resolve(canvas.toDataURL('image/png'));
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = imgUrl;
    });
  };

  const onGenerateCoverPreview = async () => {
    if (!project) return;
    if (!coverDraft.trim()) { toast('请先生成封面提示词', 'err'); return; }
    setCoverPreviewBusy(true);
    // 中断上一次请求（防快速连点生成多张图）
    coverPreviewAbortRef.current?.abort();
    const ac = new AbortController();
    coverPreviewAbortRef.current = ac;
    try {
      const enPrompt = extractEnPrompt(coverDraft);
      if (!enPrompt) { toast('无法从提示词中提取英文 Prompt', 'err'); return; }

      // BUG3 修复: 支持选择图像供应商。两条路径:
      //   A. coverImageProvider 选了 provider::model → 走后端代理 /api/v1/projects/:id/cover-preview
      //      (H2+H3 修复: 不再前端直连,避免 CORS 阻断 + apiKey 暴露)
      //   B. coverImageProvider 空 → 兜底走 TRAE 系统 text_to_image 端点(浏览器内置,无 apiKey)
      let objectUrl: string | null = null;
      let imageDataUrl: string | null = null;
      // textRendered: 图像模型是否已渲染中文书名/作者(GPT-Image-2 等)
      // true  → 跳过 canvas 叠加(图像已是完整封面)
      // false → 走 canvas 叠加兜底
      let textRendered = false;
      const sel = coverImageProvider;
      const sepIdx = sel ? sel.indexOf('::') : -1;
      const selProvider = sepIdx > 0 ? providers.find(p => p.id === sel.slice(0, sepIdx)) : undefined;
      const selModel = sepIdx > 0 ? sel.slice(sepIdx + 2) : '';
      if (selProvider && selModel) {
        // 路径 A: 后端代理调 OpenAI 兼容 /images/generations
        // H2+H3 修复: 前端只调自己的 /api/v1/projects/:id/cover-preview,
        //           后端拿 apiKey 调第三方, apiKey 永不离开服务端, 也不受 CORS 约束
        const data = await api.projects.coverPreview(project.id, {
          prompt: enPrompt,
          providerId: selProvider.id,
          model: selModel,
        });
        // data.image 已是 data URL 形式
        imageDataUrl = data.image;
        textRendered = !!data.textRendered;
      } else {
        // 路径 B: TRAE 系统默认端点（兜底，不支持中文文字渲染）
        const url = `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encodeURIComponent(enPrompt)}&image_size=portrait_4_3`;
        const resp = await fetch(url, { signal: ac.signal });
        if (!resp.ok) throw new Error(`图片生成失败（${resp.status}）`);
        const blob = await resp.blob();
        objectUrl = URL.createObjectURL(blob);
      }

      const titledAuthor = coverAuthor.trim() || '';
      const titledBook = coverBookTitle.trim() || project.title;
      const src = imageDataUrl || objectUrl;
      if (!src) throw new Error('未拿到图片数据');

      if (textRendered) {
        // 图像模型已渲染中文书名/作者(GPT-Image-2 等),跳过 canvas 叠加
        // 守卫: 仅当 ref 仍指向当前请求时才 setCoverPreviewUrl,避免竞态覆盖
        if (coverPreviewAbortRef.current !== ac) return;
        setCoverPreviewUrl(src);
        toast(`已通过 ${selProvider!.name} · ${selModel} 生成预览图（含书名作者）`);
        return;
      }

      // canvas 叠加书名 + 作者兜底(SD/FLUX/TRAE 等不支持中文渲染的图源)
      // B1 修复: try/finally 确保 objectUrl 在任何路径(包括 overlayTextOnImage 抛错)下都被释放
      try {
        const dataUrl = await overlayTextOnImage(src, titledBook, titledAuthor);
        // M1 修复(第十一轮): overlayTextOnImage 内的 Image() 不受 ac.signal 控制,
        // 快速连点时旧请求的 Image 可能晚于新请求完成并覆盖 setCoverPreviewUrl
        // 守卫: 仅当 ref 仍指向当前请求时才 setCoverPreviewUrl,否则丢弃(已被新请求取代)
        if (coverPreviewAbortRef.current !== ac) return;
        setCoverPreviewUrl(dataUrl);
        // M3 修复(第十二轮): TRAE 兜底路径明示,避免用户误以为用的是自配供应商
        toast(selProvider
          ? `已通过 ${selProvider.name} · ${selModel} 生成预览图（已叠加书名作者）`
          : '封面预览图已生成（系统默认文生图，已叠加书名作者）');
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      toast(`生成预览图失败：${(e as Error).message}`, 'err');
    } finally {
      // B2 修复: 仅当 ref 仍指向当前请求时才清理,避免快速连点时覆盖后一个请求的控制器
      if (coverPreviewAbortRef.current === ac) {
        coverPreviewAbortRef.current = null;
        setCoverPreviewBusy(false);
      }
    }
  };

  // 下载预览图
  const onDownloadCover = () => {
    if (!coverPreviewUrl || !project) return;
    const a = document.createElement('a');
    a.href = coverPreviewUrl;
    a.download = `${project.title.replace(/[\\/:*?"<>|]/g, '_')}_cover.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // 封面提示词失焦保存（走 PATCH /state）
  const onBlurCover = async () => {
    // BUG4 修复：生成期间跳过，避免覆盖 AI 刚生成的封面提示词
    if (genCoverBusy) return;
    if (!project || !agentState) return;
    if (coverDraft === agentState.cover) return;
    try {
      const updated = await api.projects.updateState(project.id, { cover: coverDraft });
      setAgentState(updated);
      coverDirtyRef.current = false;  // 保存成功，清脏标记
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
          <button className="btn-primary py-1.5 text-xs" onClick={() => setContinueOpen(true)} disabled={continueBusy || refineBookBusy} title="派发续写任务到守护进程">
            {continueBusy ? <Spinner className="h-3.5 w-3.5" /> : <Play size={13} />} 继续写作
          </button>
          <button className="btn-ghost py-1.5 text-xs text-amber" onClick={refineBook} disabled={refineBookBusy || continueBusy || chapterCount === 0} title={chapterCount === 0 ? '项目无章节，无法精修' : '批量精修所有章节去 AI 味（守护进程任务）'}>
            {refineBookBusy ? <Spinner className="h-3.5 w-3.5" /> : <Wand2 size={13} />} 整书精修
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
        <Switch checked={webSearch} onChange={toggleWebSearch} label="联网搜索取材" desc="开启后，本项目对话/生成默认启用联网搜索（可在工作台临时关闭）" />
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
            共 {chapterCount} 章 · 快照 {snapshotCount}
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
          <select className="input py-1.5 text-sm" value={selected?.id || ''} onChange={e => { const n = flatTree.find(x => x.id === e.target.value); if (n) onSelect(n); }}>
            {flatTree.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}
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
                        className="btn-ghost flex items-center gap-1 py-1 text-[11px] text-amber hover:text-amber-bright"
                        onClick={onGenerateSummary}
                        disabled={genSummaryBusy}
                        title="基于项目信息 + 最近章节摘要 AI 生成一句话简介"
                      >
                        {genSummaryBusy ? <Spinner className="h-3 w-3" /> : <Sparkles size={12} />}
                        {genSummaryBusy ? '生成中…' : 'AI 生成'}
                      </button>
                    </div>
                    <textarea className="input min-h-[110px] resize-y leading-relaxed" placeholder="一句话概括你的故事核心…" value={summary} onChange={e => setSummary(e.target.value)} onBlur={onBlurSummary} disabled={genSummaryBusy} />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-[11px] uppercase tracking-wider text-paper-mute">封面提示词</p>
                      <button
                        className="btn-ghost flex items-center gap-1 py-1 text-[11px] text-amber hover:text-amber-bright"
                        onClick={onGenerateCover}
                        disabled={genCoverBusy}
                        title="基于项目信息 AI 生成中英双段封面绘图 prompt"
                      >
                        {genCoverBusy ? <Spinner className="h-3 w-3" /> : <Camera size={12} />}
                        {genCoverBusy ? '生成中…' : 'AI 生成'}
                      </button>
                    </div>
                    {/* 生成参数：风格 / 平台 / 书名 / 作者（升级） */}
                    <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <div>
                        <label className="mb-1 block text-[10px] text-paper-mute">风格</label>
                        <select
                          className="input py-1.5 text-xs"
                          value={coverStyle}
                          onChange={e => setCoverStyle(e.target.value)}
                          disabled={genCoverBusy}
                        >
                          {COVER_STYLE_OPTIONS.map(o => (
                            <option key={o.key} value={o.key}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] text-paper-mute">平台风格</label>
                        <select
                          className="input py-1.5 text-xs"
                          value={coverPlatform}
                          onChange={e => setCoverPlatform(e.target.value)}
                          disabled={genCoverBusy}
                          title="目标网文平台视觉风格（参考 oh-story 封面方法论）"
                        >
                          {COVER_PLATFORM_OPTIONS.map(o => (
                            <option key={o.key} value={o.key}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] text-paper-mute">书名（默认取标题）</label>
                        <input
                          className="input py-1.5 text-xs"
                          value={coverBookTitle}
                          placeholder={project?.title || ''}
                          onChange={e => { coverTitleTouchedRef.current = true; setCoverBookTitle(e.target.value); }}
                          disabled={genCoverBusy}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] text-paper-mute">作者（可选）</label>
                        <input
                          className="input py-1.5 text-xs"
                          value={coverAuthor}
                          placeholder="署名，如：墨铸"
                          onChange={e => setCoverAuthor(e.target.value)}
                          disabled={genCoverBusy}
                        />
                      </div>
                    </div>
                    {/* BUG3 修复: 图像供应商选择,默认 TRAE 系统兜底,可选 OpenAI 兼容网关的图像模型 */}
                    <div className="mb-2">
                      <label className="mb-1 block text-[10px] text-paper-mute">图像供应商（用于「生成预览图」）</label>
                      <select
                        className="input py-1.5 text-xs"
                        value={coverImageProvider}
                        onChange={e => setCoverImageProvider(e.target.value)}
                        disabled={coverPreviewBusy}
                      >
                        <option value="">系统默认（TRAE 文生图）</option>
                        {(() => {
                          // 仅展示 OpenAI 兼容且 models 中含图像模型的 provider
                          // 图像模型关键字: image / dall-e / sd3 / sdxl / flux / seedream / cogview / kolors / midjourney
                          const IMAGE_RE = /(image|dall-?e|sd3|sdxl|stable-?diffusion|flux|seedream|cogview|kolors|midjourney|imagen)/i;
                          const COMPATIBLE: ProviderKind[] = ['openai', 'kkai', 'custom', 'kilo'];
                          const list = providers
                            .filter(p => COMPATIBLE.includes(p.kind))
                            .flatMap(p => p.models
                              .filter(m => IMAGE_RE.test(m))
                              .map(m => ({ providerId: p.id, providerName: p.name, model: m })));
                          return list.map(o => (
                            <option key={o.providerId + o.model} value={`${o.providerId}::${o.model}`}>
                              {o.providerName} · {o.model}
                            </option>
                          ));
                        })()}
                      </select>
                      <p className="mt-1 text-[10px] text-paper-mute">
                        切换到自配供应商（OpenAI / KKAPI / 自定义 / Kilo）后,将走该供应商的 <code className="font-mono">/images/generations</code> 接口。
                        需在「模型中心」配置 baseUrl 与 API Key。
                      </p>
                    </div>
                    <textarea
                      className="input min-h-[140px] resize-y font-mono text-sm leading-relaxed"
                      placeholder="点击「AI 生成」产生封面提示词（中文描述 + 英文 Prompt），可直接复制到 SD/MJ 使用…"
                      value={coverDraft}
                      onChange={e => { coverDirtyRef.current = true; setCoverDraft(e.target.value); }}
                      onBlur={onBlurCover}
                      disabled={genCoverBusy}
                    />
                    {coverDraft && (
                      <div className="mt-1 flex justify-end gap-3">
                        <button
                          className="text-[10px] text-paper-mute hover:text-amber"
                          onClick={() => {
                            navigator.clipboard?.writeText(coverDraft)
                              .then(() => toast('已复制到剪贴板'))
                              .catch(() => toast('复制失败，请手动选择文本复制', 'err'));
                          }}
                        >复制全部</button>
                        {/* BUG2 修复: 新增"生成预览图"按钮,调 text_to_image API 生成图片后用 canvas 叠加书名/作者 */}
                        <button
                          className="flex items-center gap-1 text-[10px] text-paper-mute hover:text-amber"
                          onClick={onGenerateCoverPreview}
                          disabled={coverPreviewBusy}
                          title="基于英文 Prompt 生成封面预览图,自动叠加书名与作者署名"
                        >
                          {coverPreviewBusy ? <Spinner className="h-3 w-3" /> : <ImageIcon size={11} />}
                          {coverPreviewBusy ? '生成中…' : '生成预览图'}
                        </button>
                      </div>
                    )}
                    {/* 封面预览图展示 + 下载 */}
                    {coverPreviewUrl && (
                      <div className="mt-3 space-y-2">
                        <div className="relative overflow-hidden rounded-md border" style={{ borderColor: 'var(--ink-500)' }}>
                          <img src={coverPreviewUrl} alt="封面预览" className="block w-full" />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-paper-mute">
                          <span>已叠加书名「{coverBookTitle.trim() || project.title}」{coverAuthor.trim() ? ` · 作者「${coverAuthor.trim()}」` : ''}</span>
                          <button
                            className="flex items-center gap-1 text-amber hover:text-amber-bright"
                            onClick={onDownloadCover}
                          >
                            <Download size={11} /> 下载 PNG
                          </button>
                        </div>
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

      {/* BUG1 修复: 续写前确认 chapterWordBudget,避免后端 infer 导致字数不一致 */}
      <Modal open={continueOpen} onClose={() => setContinueOpen(false)} title="继续写作 · 字数预算">
        {project && (() => {
          const isShort = project.type === 'short';
          const min = isShort ? 2000 : 1500;
          const max = isShort ? 12000 : 10000;
          const step = isShort ? 500 : 100;
          const presets = isShort
            ? [{ label: '紧凑', value: 3000 }, { label: '标准', value: 5000 }, { label: '厚实', value: 7000 }, { label: '大段', value: 10000 }]
            : [{ label: '短章流', value: 1500 }, { label: '标准', value: 2500 }, { label: '厚重', value: 3500 }, { label: '大章', value: 5000 }, { label: '超大章', value: 8000 }];
          const matchedPreset = presets.find(p => p.value === continueBudget);
          const estChapters = Math.max(1, Math.ceil(project.targetWords / continueBudget));
          return (
            <div className="space-y-4">
              <p className="text-xs leading-relaxed text-paper-mute">
                设置续写章节的字数预算。默认从项目已完成章节的平均字数推断,可按需调整。
                <br />注: 调整后续写字数可能与原章节不一致(原章节字数不变)。
              </p>
              {/* 预设档位 */}
              <Field label="每章字数预算" hint={`${min}-${max}`}>
                <SegmentedControl
                  options={presets}
                  value={matchedPreset ? continueBudget : -1}
                  onChange={v => setContinueBudget(v as number)}
                />
                {!matchedPreset && (
                  <p className="mt-1.5 text-[10px] text-amber-deep">
                    · 自定义值 {continueBudget} 字（不在预设档，将在 {min}-{max} 范围内生效）
                  </p>
                )}
              </Field>
              {/* 滑块 + 数值 */}
              <div className="flex items-center gap-3">
                <Slider
                  value={continueBudget}
                  min={min}
                  max={max}
                  step={step}
                  onChange={v => setContinueBudget(v)}
                />
                <div className="flex w-24 shrink-0 items-center gap-1">
                  <input
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    className="input px-2 py-1 text-xs"
                    value={continueBudget}
                    onChange={e => {
                      const v = Number(e.target.value);
                      if (!isNaN(v)) setContinueBudget(Math.min(max, Math.max(min, v)));
                    }}
                  />
                  <span className="shrink-0 text-[10px] text-paper-mute">字</span>
                </div>
              </div>
              {/* 联动预览 */}
              <div className="flex items-center gap-2 rounded-md border p-2.5 text-xs" style={{ borderColor: 'var(--ink-500)', background: 'var(--ink-900)' }}>
                <Sliders size={12} className="text-amber" />
                预估还需约 <span className="font-mono text-amber">{Math.max(0, estChapters - chapterCount)}</span> {isShort ? '段' : '章'}
                · 总目标 <span className="font-mono text-amber">{(project.targetWords / 10000).toFixed(1)}</span> 万字
                · 已完成 <span className="font-mono text-paper-dim">{chapterCount}</span> {isShort ? '段' : '章'}
              </div>
              {/* 操作按钮 */}
              <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--ink-500)' }}>
                <button className="btn-ghost" onClick={() => setContinueOpen(false)}>取消</button>
                <button className="btn-primary" onClick={continueWriting} disabled={continueBusy}>
                  {continueBusy ? <Spinner className="h-4 w-4" /> : <Play size={16} />} 派发续写任务
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>
      {node}
    </div>
  );
}
