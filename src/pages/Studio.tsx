/**
 * 工作台 —— AI 对话主界面
 * 流式输出、@项目调用、智能体状态面板、任务进度
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Sparkles, Plus, ChevronRight, Brain, Activity, MessageSquare, Cpu, Globe, Server, Tag, TrendingUp } from 'lucide-react';
import { api } from '@/api/client';
import { useApp } from '@/stores/app';
// 第二十二轮修复(react-bits 集成): Welcome 区用 SplitText/Particles/ShinyButton 替代 BlurText
import SplitText from '@/components/SplitText';
import Particles from '@/components/Particles';
import ShinyButton from '@/components/ShinyButton';
import { Spinner, EmptyState, ProgressRing, fmtWords, useToast, Tabs } from '@/components/ui';
import type { ChatMessage, AgentState, Task } from '@shared/types';
import { cn } from '@/lib/utils';
// L2 修复(第二十轮): 任务状态徽章常量,与 Daemon.tsx 共用
import { TASK_STATUS_BADGE, TASK_STATUS_TEXT } from '@/lib/project';

export default function Studio() {
  const { projects, currentProject, setCurrentProject, loadProjects, loadProviders, providers, defaultProviderId, tasks, loadTasks, currentModel, currentProviderId, setCurrentModel } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [state, setState] = useState<AgentState | null>(null);
  const [webSearch, setWebSearch] = useState(false);
  const [rightTab, setRightTab] = useState<'state' | 'tasks'>('state');
  // 第二十二轮修复(H1): 移动端视图切换 chat/state/tasks,默认 chat
  const [mobileView, setMobileView] = useState<'chat' | 'state' | 'tasks'>('chat');
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

  // 第二十二轮修复(M1): loadProjects/loadProviders fire-and-forget 无 catch
  //   原 bug: 后端 500 或网络抖动时 Promise rejection 静默吞掉,UI 无错误提示
  //   现: Promise.all 统一 catch + toast 提示
  useEffect(() => {
    void Promise.all([loadProjects(), loadProviders()]).catch(e => toast(`初始化失败：${(e as Error).message}`, 'err'));
  }, [loadProjects, loadProviders, toast]);

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
  // 第二十六轮 P1 修复(BUG-P1-6/P2-4): 原 SSE 订阅 deps 含 currentProject,切项目时重建订阅
  //   → 重连窗口内 task 事件丢失;且 onChunk 不校验 reqSeq,切项目后旧流仍在前端累加显示。
  //   现: 用 ref 持有最新 currentProject 避免重建订阅;onChunk 加 reqSeq 校验防串号。
  const currentProjectRef = useRef(currentProject);
  useEffect(() => { currentProjectRef.current = currentProject; }, [currentProject]);
  useEffect(() => {
    const off = api.streamEvents((e) => {
      if (e.type === 'task:progress' || e.type === 'task:done' || e.type === 'task:failed') {
        // 刷新任务列表(从 ref 读最新项目,避免闭包陈旧)
        const pid = currentProjectRef.current?.id;
        if (pid) loadTasks(pid);
      }
    });
    return off;
  }, [loadTasks]);

  // 第二十六轮 P1 修复(BUG-P1-7): 流式输出无条件强制滚动到底,打断用户回看历史
  //   现: 记录用户是否向上滚动,若在上滚则不强制拉回底部
  const userScrolledUpRef = useRef(false);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    userScrolledUpRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
  }, []);
  useEffect(() => {
    if (userScrolledUpRef.current) return;  // 用户在上滚,不打断
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
        // 防御：组件已卸载或项目已切换则不更新状态(避免串号覆盖 + React 警告)
        if (mountedRef.current && reqSeq === loadSeqRef.current) setStreamText(s => s + delta);
      },
      (meta) => {
        // 守护进程意图：后端返回 navigate 动作，自动跳转
        // 第二十六轮 P1 修复(BUG-P1-4): daemon_create 失败时后端不 emit navigate 且带 daemonError
        //   此时不 toast 成功提示,只 toast 错误(后端 assistant 消息已说明原因)
        if (meta.daemonError) {
          toast(`派发守护进程任务失败：${meta.daemonError}`, 'err');
          return;
        }
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
  }, [input, streaming, currentProject, currentModel, currentProviderId, webSearch, toast, navigate]);

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
      {/* 顶栏 - 第二十二轮修复(H2): flex-wrap + min-w-0 防移动端横向溢出
          原 bug: header flex 无 flex-wrap,375px 屏左组(~440px)+右组(~200px)≈640px 必溢出
          现: flex-wrap 让超长内容自动换行,左组 flex-1 min-w-0 让 select 占满剩余空间 */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
          <select
            className="input min-w-0 flex-1 py-1.5 sm:flex-none sm:max-w-[220px]"
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
        {/* 第二十六轮 P0 修复(BUG-P0-4): 右侧组在 375px 屏必溢出,联网组+模型 select+徽章 ≈290px
            与左组 flex-1 共存横向溢出。改 flex-wrap + 模型组换行,触摸目标对齐 ui.tsx Switch(h-6 w-11) */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex items-center gap-1.5">
            <Globe size={14} className={cn('transition-colors', webSearch ? 'text-amber' : 'text-paper-mute')} />
            <button type="button" role="switch" aria-label="联网搜索" aria-checked={webSearch} disabled={!currentProject}
              className={cn('relative h-6 w-11 rounded-full transition-colors', webSearch ? 'bg-amber' : 'bg-ink-500', !currentProject && 'opacity-50')}
              onClick={toggleWebSearch}>
              <span className={cn('absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-paper transition-transform', webSearch && 'translate-x-5')} />
            </button>
            <span className="text-xs text-paper-mute">联网</span>
          </div>
          <div className="flex w-full items-center gap-1.5 text-xs text-paper-mute sm:w-auto">
            <Cpu size={14} />
            <select className="input-compact min-w-0 flex-1 px-2 py-1 text-xs sm:flex-none" value={currentProviderId ? `${currentProviderId}::${currentModel}` : ''} onChange={e => {
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
        <section className={cn('flex flex-1 flex-col overflow-hidden', mobileView !== 'chat' && 'hidden lg:flex')}>
          {/* 第二十二轮修复(H1): 移动端顶栏 SegmentedControl 切换 对话/状态/任务 三视图
              原 bug: 右侧面板 hidden lg:flex,移动端完全无法访问智能体状态与任务进度
              现: 移动端用 SegmentedControl 切换,桌面端仍保持 aside 左右双栏 */}
          <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2 lg:hidden" style={{ borderColor: 'var(--ink-600)' }}>
            <button
              className={cn('flex-1 rounded px-2 py-1 text-xs', mobileView === 'chat' ? 'bg-amber text-ink-900' : 'text-paper-mute')}
              onClick={() => setMobileView('chat')}
            >对话</button>
            <button
              className={cn('flex-1 rounded px-2 py-1 text-xs', mobileView === 'state' ? 'bg-amber text-ink-900' : 'text-paper-mute')}
              onClick={() => setMobileView('state')}
            >状态</button>
            <button
              className={cn('flex-1 rounded px-2 py-1 text-xs', mobileView === 'tasks' ? 'bg-amber text-ink-900' : 'text-paper-mute')}
              onClick={() => setMobileView('tasks')}
            >任务</button>
          </div>
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
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

        {/* 右侧面板 - 第二十二轮修复(H1): 桌面端常驻 + 移动端按 mobileView 切换显示 */}
        <aside
          className={cn('w-full shrink-0 flex-col border-l lg:flex lg:w-80', (mobileView === 'state' || mobileView === 'tasks') ? 'flex' : 'hidden lg:flex')}
          style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}
        >
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
    // 第二十二轮修复(react-bits 集成): 加 Particles 背景粒子 + SplitText 标题 + ShinyButton CTA
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden text-center">
      <Particles quantity={50} color="var(--amber)" className="absolute inset-0 opacity-40" />
      <div className="relative z-10">
        <SplitText text="墨铸工坊" as="h1" className="font-display text-5xl gradient-text" delay={60} />
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-paper-mute animate-fade-up" style={{ animationDelay: '0.5s' }}>
          融合「扫榜→拆文→创作→精修」方法论与智能体状态分层，<br />
          一个对话驱动从灵感到成书的全程。
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3 animate-fade-up" style={{ animationDelay: '0.7s' }}>
          <a href="/projects" className="btn-ghost"><Plus size={16} /> 新建项目</a>
          <ShinyButton>
            <a href="/generate" className="flex items-center gap-1.5"><Sparkles size={16} /> 一键成书</a>
          </ShinyButton>
        </div>
        <div className="mx-auto mt-10 grid max-w-md grid-cols-1 gap-4 text-xs text-paper-mute animate-fade-in sm:grid-cols-3" style={{ animationDelay: '0.9s' }}>
          {[['500 万字', '长篇成书'], ['二十万字', '短篇速成'], ['守护进程', '断点续传']].map(([a, b]) => (
            <div key={a} className="rounded-md border p-3" style={{ borderColor: 'var(--ink-500)' }}>
              <div className="font-display text-lg text-amber">{a}</div>
              <div className="mt-1">{b}</div>
            </div>
          ))}
        </div>
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
  // L2 修复(第二十轮): 改用 @/lib/project 共享常量,与 Daemon.tsx 一致
  const statusColor = TASK_STATUS_BADGE;
  const statusText = TASK_STATUS_TEXT;
  const [retrying, setRetrying] = useState(false);
  const onRetry = async () => {
    setRetrying(true);
    try {
      // 第二十六轮 P1 修复(BUG-P1-1): 原 resume 不递增 retryCount,失败统计失真,且与 Daemon 页面行为不一致
      //   现: 失败重试用 retry(保留 checkpoint 续传 + 递增 retryCount),与 Daemon.tsx 对齐
      await api.tasks.retry(task.id);
      toast('已重新排队（失败重试）');
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
              className="rounded px-2 py-1 text-[11px] text-amber hover:bg-ink-600"
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
