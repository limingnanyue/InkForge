/**
 * 工作台 —— AI 对话主界面
 * 流式输出、@项目调用、智能体状态面板、任务进度
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Sparkles, Plus, ChevronRight, Brain, Activity, MessageSquare, Cpu, Globe, Server, Tag, TrendingUp } from 'lucide-react';
import { api } from '@/api/client';
import { useApp } from '@/stores/app';
import BlurText from '@/components/BlurText';
import { Spinner, EmptyState, ProgressRing, fmtWords, useToast, Tabs } from '@/components/ui';
import type { ChatMessage, AgentState, Task } from '@shared/types';
import { cn } from '@/lib/utils';

export default function Studio() {
  const { projects, currentProject, setCurrentProject, loadProjects, loadProviders, providers, defaultProviderId, tasks, loadTasks, currentModel, currentProviderId, setCurrentModel } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [state, setState] = useState<AgentState | null>(null);
  const [webSearch, setWebSearch] = useState(false);
  const [rightTab, setRightTab] = useState<'state' | 'tasks'>('state');
  const scrollRef = useRef<HTMLDivElement>(null);
  // BUG-7 修复：保存 chat.stream handle，unmount 时 cancel
  // 否则切换项目/路由后旧流仍在后台消费 LLM token（烧钱），setStreamText 等更新到已卸载组件触发 React 警告
  const streamHandleRef = useRef<{ cancel: () => void } | null>(null);
  // BUG-13 修复：navigate setTimeout 句柄，unmount 时 clear
  const navTimerRef = useRef<number | null>(null);
  // F6 修复：切项目请求序号，防竞态（旧 promise 后到则丢弃）
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const navigate = useNavigate();
  const { toast, node } = useToast();

  useEffect(() => { loadProjects(); loadProviders(); }, [loadProjects, loadProviders]);

  // unmount cleanup：cancel 未完成的流 + clear 延时 navigate
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamHandleRef.current?.cancel();
      streamHandleRef.current = null;
      if (navTimerRef.current !== null) {
        window.clearTimeout(navTimerRef.current);
        navTimerRef.current = null;
      }
    };
  }, []);

  // 兜底：若 store.currentModel 仍空（极端情况下 loadProviders 未填充），用默认 provider 旗舰模型补一次
  // 正常路径已在 store.loadProviders 中完成初始化，这里只做防御
  useEffect(() => {
    if (!currentModel && providers.length) {
      const def = providers.find(p => p.id === (currentProviderId || defaultProviderId)) || providers[0];
      if (def?.models?.length) setCurrentModel(def.models[0], def.id);
    }
  }, [currentModel, providers, currentProviderId, defaultProviderId, setCurrentModel]);

  // 切换项目时加载消息/状态/任务
  // F6 修复：(1) 用请求序号防竞态，快速切 A→B 时若 A 的 promise 后到，序号不匹配则丢弃
  // (2) 静默失败 catch(() => {}) 改为 toast 提示，避免后端 500 时用户看不到任何反馈
  useEffect(() => {
    if (!currentProject) { setMessages([]); setState(null); return; }
    const reqSeq = ++loadSeqRef.current;
    api.projects.messages(currentProject.id)
      .then(list => { if (reqSeq === loadSeqRef.current) setMessages(list); })
      .catch(e => { if (reqSeq === loadSeqRef.current) toast(`加载消息失败：${(e as Error).message}`, 'err'); });
    api.projects.state(currentProject.id)
      .then(s => { if (reqSeq === loadSeqRef.current) setState(s); })
      .catch(e => { if (reqSeq === loadSeqRef.current) toast(`加载状态失败：${(e as Error).message}`, 'err'); });
    loadTasks(currentProject.id);
  }, [currentProject, loadTasks, toast]);

  // 联网搜索开关跟随当前项目配置
  useEffect(() => {
    setWebSearch(currentProject?.webSearchEnabled ?? false);
  }, [currentProject]);

  // SSE 订阅任务进度
  useEffect(() => {
    const off = api.streamEvents((e) => {
      if (e.type === 'task:progress' || e.type === 'task:done' || e.type === 'task:failed') {
        // 刷新任务列表
        if (currentProject) loadTasks(currentProject.id);
      }
    });
    return off;
  }, [currentProject, loadTasks]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamText]);

  const send = useCallback(async () => {
    if (!input.trim() || streaming) return;
    if (!currentProject) { toast('请先选择或创建项目', 'err'); return; }
    // BUG-1 修复：捕获当前请求序号，流式完成后校验项目是否已切换，
    // 避免「项目 A 发起对话 → 流式中切到 B → A 的流结束 setMessages(A) 后到」覆盖 B 的列表
    const reqSeq = loadSeqRef.current;
    const text = input.trim();
    setInput('');
    setStreaming(true);
    setStreamText('');

    const handle = api.chat.stream(
      { projectId: currentProject.id, message: text, model: currentModel, providerId: currentProviderId || undefined, webSearch },
      (delta) => {
        // 防御：组件已卸载则不更新状态（避免 React 警告）
        if (mountedRef.current) setStreamText(s => s + delta);
      },
      (meta) => {
        // 守护进程意图：后端返回 navigate 动作，自动跳转
        if (meta.action === 'navigate' && meta.target) {
          toast(meta.intent === 'daemon_create' ? '已派发续写任务，正在打开守护进程…' : '正在打开守护进程…');
          // 稍延后跳转，让引导文案先显示
          // BUG-13 修复：保存句柄，unmount 时 clear；非空断言改为显式判空
          navTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current && meta.target) navigate(meta.target);
          }, 600);
        }
      },
    );
    // 保存到 ref：unmount cleanup 会 cancel 它，停止后台 token 消费
    streamHandleRef.current = handle;
    try {
      await handle.done;
      // 刷新消息（BUG-1：校验项目未切换才 set，避免串号覆盖）
      const msgs = await api.projects.messages(currentProject.id);
      if (mountedRef.current && reqSeq === loadSeqRef.current) setMessages(msgs);
      const s = await api.projects.state(currentProject.id);
      if (mountedRef.current && reqSeq === loadSeqRef.current) setState(s);
    } catch (e) {
      if (mountedRef.current) toast((e as Error).message, 'err');
    } finally {
      streamHandleRef.current = null;
      if (mountedRef.current) {
        setStreaming(false);
        setStreamText('');
      }
    }
  }, [input, streaming, currentProject, currentModel, currentProviderId, webSearch, toast, navigate, setCurrentModel]);

  const toggleWebSearch = async () => {
    if (!currentProject) return;
    const next = !webSearch;
    setWebSearch(next);
    try {
      const updated = await api.projects.update(currentProject.id, { webSearchEnabled: next });
      setCurrentProject(updated);
      toast(next ? '已开启联网搜索' : '已关闭联网搜索');
    } catch (e) {
      setWebSearch(!next);
      toast((e as Error).message, 'err');
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <header className="flex shrink-0 items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
        <div className="flex items-center gap-3">
          <select
            className="input max-w-[220px] py-1.5"
            value={currentProject?.id || ''}
            onChange={e => {
              const p = projects.find(x => x.id === e.target.value);
              setCurrentProject(p || null);
            }}
          >
            <option value="">选择项目…</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          {currentProject && (
            <button onClick={() => navigate(`/projects/${currentProject.id}`)} className="btn-ghost py-1.5 text-xs">
              章节编辑 <ChevronRight size={14} />
            </button>
          )}
          {currentProject?.genre && (
            <button
              onClick={() => navigate('/market', { state: { genreId: currentProject.genreId, genre: currentProject.genre } })}
              className="btn-ghost py-1.5 text-xs"
              title="一键用此题材扫榜分析市场风向"
            >
              <Tag size={13} className="text-amber" /> {currentProject.genre}
              <TrendingUp size={12} className="ml-1 text-paper-mute" />
            </button>
          )}
          <button onClick={() => navigate('/genres')} className="btn-ghost py-1.5 text-xs" title="题材库管理">
            <Tag size={13} /> 题材库
          </button>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Globe size={14} className={cn('transition-colors', webSearch ? 'text-amber' : 'text-paper-mute')} />
            <button type="button" role="switch" aria-checked={webSearch} disabled={!currentProject}
              className={cn('relative h-5 w-9 rounded-full transition-colors', webSearch ? 'bg-amber' : 'bg-ink-500', !currentProject && 'opacity-50')}
              onClick={toggleWebSearch}>
              <span className={cn('absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-paper transition-transform', webSearch && 'translate-x-4')} />
            </button>
            <span className="text-xs text-paper-mute">联网</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-paper-mute">
            <Cpu size={14} />
            <select className="input-compact px-2 py-1 text-xs" value={currentProviderId ? `${currentProviderId}::${currentModel}` : ''} onChange={e => {
              const sep = e.target.value.indexOf('::');
              if (sep > 0) {
                const pid = e.target.value.slice(0, sep);
                const m = e.target.value.slice(sep + 2);
                setCurrentModel(m, pid);
              }
            }}>
              {providers.length === 0 && <option value="">无可用模型</option>}
              {providers.flatMap(p => p.models.map(m => (
                <option key={p.id + m} value={`${p.id}::${m}`}>{p.name} · {m}</option>
              )))}
            </select>
          </div>
          {tasks.some(t => t.status === 'running') && (
            <span className="badge badge-amber"><Activity size={11} className="animate-pulse" /> 生成中</span>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 对话区 */}
        <section className="flex flex-1 flex-col overflow-hidden">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
            <div className="mx-auto max-w-3xl">
              {!currentProject ? (
                <Welcome onCreate={() => loadProjects()} />
              ) : messages.length === 0 && !streaming ? (
                <EmptyState
                  icon={<MessageSquare size={40} />}
                  title="开始创作对话"
                  desc="输入指令，如「续写下一章」「精修这段文字」「拆文分析节奏」。AI 会基于项目智能体状态上下文作答。"
                />
              ) : (
                <div className="space-y-5">
                  {messages.map(m => <MessageBubble key={m.id} role={m.role} content={m.content} />)}
                  {streaming && <MessageBubble role="assistant" content={streamText} streaming />}
                </div>
              )}
            </div>
          </div>

          {/* 输入区 */}
          <div className="shrink-0 border-t px-4 py-3 md:px-8" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
            <div className="mx-auto max-w-3xl">
              <div className="mb-2 flex flex-wrap gap-1.5">
                <QuickBtn onClick={() => setInput('续写下一章正文，约 3000 字，保持人设与节奏。')}>续写</QuickBtn>
                <QuickBtn onClick={() => setInput('精修当前章节，去 AI 味，强化情绪颗粒度。')}>精修去AI味</QuickBtn>
                <QuickBtn onClick={() => setInput('拆文分析最近章节的节奏与爽点分布。')}>拆文</QuickBtn>
                <QuickBtn onClick={() => setInput('添加守护进程，开始后台写作。')}><Server size={12} /> 守护进程</QuickBtn>
                <QuickBtn onClick={() => navigate('/generate')}><Sparkles size={12} /> 一键生成</QuickBtn>
              </div>
              <div className="flex items-end gap-2">
                <textarea
                  className="input min-h-[48px] max-h-40 flex-1 resize-none py-3"
                  placeholder={currentProject ? '输入创作指令…（Enter 发送，Shift+Enter 换行）' : '请先选择项目'}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={onKey}
                  disabled={!currentProject || streaming}
                  rows={1}
                />
                <button className="btn-primary py-3" onClick={send} disabled={!input.trim() || streaming || !currentProject}>
                  {streaming ? <Spinner className="h-4 w-4" /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* 右侧面板 */}
        <aside className="hidden w-80 shrink-0 flex-col border-l lg:flex" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
          <Tabs tabs={[{ id: 'state', label: '智能体状态' }, { id: 'tasks', label: '任务进度' }]} active={rightTab} onChange={setRightTab as any} />
          <div className="flex-1 overflow-y-auto p-4">
            {rightTab === 'state' ? (
              <StatePanel state={state} project={currentProject} />
            ) : (
              <TaskPanel tasks={tasks} toast={toast} />
            )}
          </div>
        </aside>
      </div>
      {node}
    </div>
  );
}

function Welcome({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <BlurText text="墨铸工坊" as="h1" className="font-display text-5xl gradient-text" delay={100} stagger={40} />
      <p className="mt-4 max-w-md text-sm leading-relaxed text-paper-mute animate-fade-up" style={{ animationDelay: '0.5s' }}>
        融合「扫榜→拆文→创作→精修」方法论与智能体状态分层，<br />
        一个对话驱动从灵感到成书的全程。
      </p>
      <div className="mt-8 flex gap-3 animate-fade-up" style={{ animationDelay: '0.7s' }}>
        <a href="/projects" className="btn-ghost"><Plus size={16} /> 新建项目</a>
        <a href="/generate" className="btn-primary"><Sparkles size={16} /> 一键成书</a>
      </div>
      <div className="mt-10 grid grid-cols-3 gap-4 text-xs text-paper-mute animate-fade-in" style={{ animationDelay: '0.9s' }}>
        {[['500 万字', '长篇成书'], ['二十万字', '短篇速成'], ['守护进程', '断点续传']].map(([a, b]) => (
          <div key={a} className="rounded-md border p-3" style={{ borderColor: 'var(--ink-500)' }}>
            <div className="font-display text-lg text-amber">{a}</div>
            <div className="mt-1">{b}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ role, content, streaming }: { role: string; content: string; streaming?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex animate-fade-up', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[85%] rounded-lg px-4 py-3', isUser ? 'border' : 'panel-elevated')}
        style={isUser ? { borderColor: 'var(--amber-deep)', background: 'rgba(212,165,52,0.06)' } : {}}>
        <p className={cn('text-sm leading-relaxed', isUser ? 'text-paper' : 'prose-ink', streaming && 'caret')}>
          {content || (streaming ? '' : '…')}
        </p>
      </div>
    </div>
  );
}

function QuickBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded border px-2 py-1 text-xs text-paper-mute transition-colors hover:border-amber-deep hover:text-amber"
      style={{ borderColor: 'var(--ink-500)' }}>
      {children}
    </button>
  );
}

function StatePanel({ state, project }: { state: AgentState | null; project: any }) {
  if (!project) return <p className="text-xs text-paper-mute">未选择项目</p>;
  if (!state) return <Spinner className="h-4 w-4 text-paper-mute" />;
  const fields: [keyof AgentState, string][] = [
    ['idea', '创意'], ['setting', '设定'], ['characters', '角色'],
    ['memory', '记忆'], ['review', '审稿'], ['revision', '修订'], ['cover', '封面'],
  ];
  return (
    <div className="space-y-2">
      {project && (
        <div className="mb-3 flex items-center gap-3 rounded-md border p-3" style={{ borderColor: 'var(--ink-500)' }}>
          <ProgressRing value={project.currentWords / project.targetWords} size={44} />
          <div className="flex-1">
            <p className="text-xs text-paper-mute">字数进度</p>
            <p className="font-mono text-sm text-paper">{fmtWords(project.currentWords)} / {fmtWords(project.targetWords)}</p>
          </div>
        </div>
      )}
      {fields.map(([k, label]) => (
        <StateCard key={k} label={label} icon={<Brain size={13} />} content={(state as any)[k]} />
      ))}
    </div>
  );
}

function StateCard({ label, icon, content }: { label: string; icon: React.ReactNode; content: string }) {
  const [open, setOpen] = useState(false);
  const has = content && content.trim().length > 0;
  return (
    <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--ink-500)' }}>
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className="text-paper-mute">{icon}</span>
        <span className="flex-1 text-xs font-medium text-paper-dim">{label}</span>
        <span className={cn('h-1.5 w-1.5 rounded-full', has ? 'bg-amber' : 'bg-ink-400')} />
      </button>
      {open && (
        <div className="border-t px-3 py-2 text-xs leading-relaxed text-paper-mute" style={{ borderColor: 'var(--ink-600)' }}>
          {has ? content : '尚未建立，将在生成过程中自动积累。'}
        </div>
      )}
    </div>
  );
}

function TaskPanel({ tasks, toast }: { tasks: Task[]; toast: (msg: string, type?: 'ok' | 'err') => void }) {
  if (!tasks.length) return <p className="text-xs text-paper-mute">暂无任务</p>;
  return (
    <div className="space-y-2">
      {tasks.slice(0, 20).map(t => <TaskRow key={t.id} task={t} toast={toast} />)}
    </div>
  );
}

function TaskRow({ task, toast }: { task: Task; toast: (msg: string, type?: 'ok' | 'err') => void }) {
  const statusColor: Record<string, string> = { running: 'badge-amber', queued: 'badge-mute', done: 'badge-green', failed: 'badge-red', paused: 'badge-mute' };
  const statusText: Record<string, string> = { running: '运行中', queued: '排队', done: '完成', failed: '失败', paused: '已暂停' };
  const [retrying, setRetrying] = useState(false);
  const onRetry = async () => {
    setRetrying(true);
    try {
      await api.tasks.resume(task.id);
      toast('已重新排队');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setRetrying(false); }
  };
  return (
    <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--ink-500)', background: 'var(--ink-700)' }}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-paper-dim">{task.type === 'book' ? '成书' : task.type === 'short' ? '成短篇' : task.type === 'chapter' ? '章节生成' : '精修'}</span>
        <div className="flex items-center gap-1.5">
          {task.status === 'failed' && (
            <button
              className="rounded px-1.5 py-0.5 text-[10px] text-amber hover:bg-ink-600"
              onClick={onRetry}
              disabled={retrying}
              title="从 checkpoint 继续"
            >
              {retrying ? <Spinner className="h-3 w-3" /> : '↻ 重试'}
            </button>
          )}
          <span className={cn('badge', statusColor[task.status])}>{statusText[task.status]}</span>
        </div>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: 'var(--ink-500)' }}>
        <div className="h-full rounded-full" style={{ width: `${task.progress * 100}%`, background: 'linear-gradient(90deg,var(--amber-deep),var(--amber))' }} />
      </div>
      {task.message && <p className="mt-1.5 truncate text-[11px] text-paper-mute">{task.message}</p>}
    </div>
  );
}
