/**
 * 设置 —— 部署、外观、数据、关于
 */
import { useEffect, useState } from 'react';
import { Server, Palette, Database, Info, Sun, Moon, Trash2, CheckCircle2, RefreshCw, Github, Zap, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { api } from '@/api/client';
import BlurText from '@/components/BlurText';
import { Spinner, Modal, useToast } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { UsageStats } from '@shared/types';

type Theme = 'dark' | 'light';
const DATA_DIR = './data';
const PORT = '3000';
const REPOS = [
  { name: 'oh-story-claudecode', desc: '扫榜拆文方法论' },
  { name: 'InkOS', desc: '智能体状态分层' },
  { name: 'taste-skill', desc: '品味与套路词典' },
  { name: 'react-bits', desc: '动效组件灵感' },
];

export default function Settings() {
  // BUG-6 修复：主题/字号从 localStorage 初始化，刷新不丢失
  const [theme, setTheme] = useState<Theme>(() => { try { return (localStorage.getItem('inkforge.theme') as Theme) || 'dark'; } catch { return 'dark'; } });
  const [fs, setFs] = useState(() => { try { return Number(localStorage.getItem('inkforge.fontSize')) || 15; } catch { return 15; } });
  const [conn, setConn] = useState<'checking' | 'ok' | 'fail'>('checking');
  const [tableCount, setTableCount] = useState<number | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [clearUsageOpen, setClearUsageOpen] = useState(false);
  const { toast, node } = useToast();

  const loadUsage = async () => {
    setUsageLoading(true);
    try { setUsage(await api.usage.stats()); }
    catch (e) { toast((e as Error).message, 'err'); }
    finally { setUsageLoading(false); }
  };

  const clearUsage = async () => {
    try {
      await api.usage.clear();
      toast('用量记录已清空');
      setClearUsageOpen(false);
      loadUsage();
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  // 主题：light 模式注入覆盖样式
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('light', theme === 'light');
    root.classList.toggle('dark', theme === 'dark');
    let style = document.getElementById('theme-override') as HTMLStyleElement | null;
    if (theme === 'light') {
      if (!style) { style = document.createElement('style'); style.id = 'theme-override'; document.head.appendChild(style); }
      style.textContent = `
        :root{--ink-900:#F5E6C8;--ink-800:#EAD7AF;--ink-700:#E0CCA0;--ink-600:#D4BC8C;--ink-500:#C8AC78;--ink-400:#B89A60;
        --paper:#2A2118;--paper-dim:#4A3E2E;--paper-mute:#7A6A52;--amber:#8B6914;--amber-bright:#A57F1E;--amber-deep:#5C4709;
        --celadon:#3A6A4A; --cinnabar:#8B1F2E;}
        body{color:var(--paper);background:var(--ink-900);}
        .aura{display:none;}`;
    } else if (style) { style.remove(); }
    // BUG-6 修复：主题写入 localStorage 持久化
    try { localStorage.setItem('inkforge.theme', theme); } catch {}
  }, [theme]);

  // BUG-6 修复：字号写入 localStorage 持久化
  useEffect(() => { document.documentElement.style.fontSize = `${fs}px`; try { localStorage.setItem('inkforge.fontSize', String(fs)); } catch {} }, [fs]);

  // 连通性验证
  useEffect(() => {
    (async () => {
      try {
        const ps = await api.projects.list();
        setTableCount(ps.length);
        setConn('ok');
      } catch { setConn('fail'); }
    })();
    loadUsage();
  }, []);

  const clearCache = () => {
    // BUG-6 修复：白名单保留用户偏好键，避免 localStorage.clear() 误清
    // inkforge.currentModel / currentProviderId / theme / fontSize / cover.style / cover.author。
    // Modal 文案承诺「不影响服务器数据与项目内容」，故偏好需写回。
    const PRESERVE = [
      'inkforge.currentModel', 'inkforge.currentProviderId',
      'inkforge.theme', 'inkforge.fontSize',
      'inkforge.cover.style', 'inkforge.cover.author',
    ];
    try {
      const saved: Record<string, string> = {};
      for (const k of PRESERVE) { const v = localStorage.getItem(k); if (v !== null) saved[k] = v; }
      localStorage.clear();
      for (const k of PRESERVE) { if (k in saved) localStorage.setItem(k, saved[k]); }
    } catch { /* localStorage 不可用，忽略 */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    toast('本地缓存已清空');
    setClearOpen(false);
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      <header className="mb-6 animate-fade-up">
        <h1 className="font-display text-4xl text-paper">设置</h1>
        <BlurText text="部署模式、外观主题与数据管理" as="p" className="mt-1.5 text-sm text-paper-mute" delay={120} stagger={16} />
      </header>

      <div className="mx-auto max-w-3xl space-y-4">
        {/* 部署模式 */}
        <Card icon={<Server size={16} />} title="部署模式">
          <Row label="当前模式" value={<span className="badge badge-green">本地单机</span>} />
          <Row label="数据目录" value={<code className="font-mono text-xs text-paper-dim">{DATA_DIR}</code>} />
          <Row label="服务端口" value={<code className="font-mono text-xs text-paper-dim">{PORT}</code>} />
          <div className="mt-3 flex items-center gap-2 rounded-md border p-3 text-xs text-paper-mute" style={{ borderColor: 'var(--ink-500)' }}>
            <RefreshCw size={13} className="text-amber" />
            守护进程随服务启动，无需手动重启；如需重载配置，请重启 InkForge 服务。
          </div>
        </Card>

        {/* 外观 */}
        <Card icon={<Palette size={16} />} title="外观">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-paper-dim">主题</p>
              <p className="text-[11px] text-paper-mute">暗色书房 / 旧纸浅色</p>
            </div>
            <div className="flex gap-1 rounded-md border p-0.5" style={{ borderColor: 'var(--ink-500)' }}>
              <button onClick={() => setTheme('dark')} className={cn('flex items-center gap-1.5 rounded px-3 py-1.5 text-xs', theme === 'dark' ? 'bg-amber text-ink-900' : 'text-paper-mute')}>
                <Moon size={13} /> 暗色
              </button>
              <button onClick={() => setTheme('light')} className={cn('flex items-center gap-1.5 rounded px-3 py-1.5 text-xs', theme === 'light' ? 'bg-amber text-ink-900' : 'text-paper-mute')}>
                <Sun size={13} /> 浅色
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-paper-dim">字体大小</p>
              <p className="text-[11px] text-paper-mute">根字号 {fs}px</p>
            </div>
            <input type="range" min={13} max={18} value={fs} onChange={e => setFs(Number(e.target.value))}
              className="w-40 accent-amber" />
          </div>
        </Card>

        {/* 数据 */}
        <Card icon={<Database size={16} />} title="数据">
          <Row label="数据目录" value={<code className="font-mono text-xs text-paper-dim">{DATA_DIR}/inkforge.db</code>} />
          <Row label="连通性" value={
            conn === 'checking' ? <Spinner className="h-3.5 w-3.5" /> :
            conn === 'ok' ? <span className="badge badge-green"><CheckCircle2 size={11} /> 已连接</span> :
            <span className="badge badge-red">连接失败</span>
          } />
          <Row label="项目数" value={<code className="font-mono text-xs text-paper-dim">{tableCount ?? '—'}</code>} />
          <div className="mt-3">
            <button className="btn-ghost py-1.5 text-xs text-cinnabar" onClick={() => setClearOpen(true)}>
              <Trash2 size={13} /> 清空浏览器缓存
            </button>
          </div>
        </Card>

        {/* Token 用量 */}
        <Card icon={<Zap size={16} />} title="Token 用量">
          <div className="mb-4 flex items-center justify-end">
            <button className="btn-ghost py-1.5 text-xs" onClick={loadUsage} disabled={usageLoading}>
              {usageLoading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw size={13} />} 刷新
            </button>
          </div>
          {usage ? (
            <>
              {/* 总览三块 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatBox
                  icon={<ArrowDownLeft size={14} />}
                  label="输入 Token"
                  value={usage.totalInput}
                  hint="Prompt 累计"
                  tone="in"
                />
                <StatBox
                  icon={<ArrowUpRight size={14} />}
                  label="输出 Token"
                  value={usage.totalOutput}
                  hint="生成内容累计"
                  tone="out"
                />
                <StatBox
                  icon={<Zap size={14} />}
                  label="合计 Token"
                  value={usage.totalTokens}
                  hint={`共 ${usage.callCount} 次调用`}
                  tone="total"
                />
              </div>

              {/* 缓存命中 */}
              {(usage.totalCacheRead > 0 || usage.totalCacheCreation > 0) && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border p-3 text-xs" style={{ borderColor: 'var(--ink-500)' }}>
                  <span className="text-paper-mute">缓存：</span>
                  <span className="badge badge-green">命中读取 {fmtTokens(usage.totalCacheRead)}</span>
                  <span className="badge badge-amber">写入 {fmtTokens(usage.totalCacheCreation)}</span>
                  <span className="text-paper-mute">
                    命中率 {usage.totalInput + usage.totalCacheRead > 0
                      ? ((usage.totalCacheRead / (usage.totalInput + usage.totalCacheRead)) * 100).toFixed(1)
                      : '0'}%
                  </span>
                </div>
              )}

              {/* 按供应商/模型 */}
              {usage.byProvider.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium text-paper-mute">按供应商 / 模型</p>
                  <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--ink-500)' }}>
                    <table className="w-full text-xs">
                      <thead style={{ background: 'var(--ink-700)' }}>
                        <tr className="text-left text-paper-mute">
                          <th className="px-2.5 py-1.5 font-medium">供应商 / 模型</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">输入</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">输出</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">合计</th>
                          <th className="px-2.5 py-1.5 text-right font-medium">次数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.byProvider.map((r, i) => (
                          <tr key={i} className="border-t" style={{ borderColor: 'var(--ink-600)' }}>
                            <td className="px-2.5 py-1.5">
                              <p className="font-mono text-paper-dim">{r.providerName || '（未命名）'}</p>
                              <p className="truncate text-[10px] text-paper-mute">{r.model || '—'}</p>
                            </td>
                            <td className="px-2.5 py-1.5 text-right font-mono text-paper-dim">{fmtTokens(r.inputTokens)}</td>
                            <td className="px-2.5 py-1.5 text-right font-mono text-paper-dim">{fmtTokens(r.outputTokens)}</td>
                            <td className="px-2.5 py-1.5 text-right font-mono text-amber">{fmtTokens(r.totalTokens)}</td>
                            <td className="px-2.5 py-1.5 text-right font-mono text-paper-mute">{r.callCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 按项目 */}
              {usage.byProject.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium text-paper-mute">按项目</p>
                  <div className="space-y-1.5">
                    {usage.byProject.map((r, i) => (
                      <div key={i} className="flex items-center justify-between rounded-md border px-2.5 py-1.5 text-xs" style={{ borderColor: 'var(--ink-600)' }}>
                        <span className="truncate text-paper-dim">{r.projectName}</span>
                        <div className="flex shrink-0 items-center gap-3 font-mono">
                          <span className="text-paper-mute">入 {fmtTokens(r.inputTokens)}</span>
                          <span className="text-paper-mute">出 {fmtTokens(r.outputTokens)}</span>
                          <span className="text-amber">{fmtTokens(r.totalTokens)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4">
                <button className="btn-ghost py-1.5 text-xs text-cinnabar" onClick={() => setClearUsageOpen(true)}>
                  <Trash2 size={13} /> 清空用量记录
                </button>
              </div>
            </>
          ) : usageLoading ? (
            <div className="flex items-center justify-center py-6 text-paper-mute"><Spinner /></div>
          ) : (
            <p className="py-4 text-center text-xs text-paper-mute">暂无用量数据，开始创作后即可统计</p>
          )}
        </Card>

        {/* 关于 */}
        <Card icon={<Info size={16} />} title="关于">
          <Row label="版本" value={<span className="font-mono text-xs text-paper-dim">InkForge 墨铸 v0.1</span>} />
          <div className="mt-3">
            <p className="mb-2 text-xs font-medium text-paper-mute">技术栈</p>
            <div className="flex flex-wrap gap-1.5">
              {['React 18', 'Vite', 'TypeScript', 'TailwindCSS', 'Zustand', 'better-sqlite3', 'lucide-react'].map(t =>
                <span key={t} className="badge badge-mute">{t}</span>)}
            </div>
          </div>
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-paper-mute">参考仓库</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {REPOS.map(r => (
                <div key={r.name} className="flex items-center gap-2 rounded-md border p-2" style={{ borderColor: 'var(--ink-500)' }}>
                  <Github size={14} className="text-paper-mute" />
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-paper-dim">{r.name}</p>
                    <p className="text-[10px] text-paper-mute">{r.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <Modal open={clearOpen} onClose={() => setClearOpen(false)} title="清空缓存">
        <p className="text-sm leading-relaxed text-paper-dim">将清除浏览器本地存储（localStorage / sessionStorage），不影响服务器数据与项目内容。是否继续？</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setClearOpen(false)}>取消</button>
          <button className="btn-primary" onClick={clearCache}><Trash2 size={16} /> 确认清空</button>
        </div>
      </Modal>

      <Modal open={clearUsageOpen} onClose={() => setClearUsageOpen(false)} title="清空 Token 用量记录">
        <p className="text-sm leading-relaxed text-paper-dim">将删除所有历史用量统计记录，此操作不可恢复。是否继续？</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setClearUsageOpen(false)}>取消</button>
          <button className="btn-primary" onClick={clearUsage}><Trash2 size={16} /> 确认清空</button>
        </div>
      </Modal>
      {node}
    </div>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="panel-elevated animate-fade-up p-5">
      <h2 className="mb-4 flex items-center gap-2 font-display text-lg text-paper">
        <span className="text-amber">{icon}</span> {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b py-2.5 last:border-b-0" style={{ borderColor: 'var(--ink-600)' }}>
      <span className="text-sm text-paper-mute">{label}</span>
      <span>{value}</span>
    </div>
  );
}

// Token 数字格式化：1.2k / 3.4M
function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// 用量统计小块：输入/输出/合计
function StatBox({ icon, label, value, hint, tone }: {
  icon: React.ReactNode; label: string; value: number; hint: string;
  tone: 'in' | 'out' | 'total';
}) {
  const toneColor = tone === 'in' ? 'text-paper-dim' : tone === 'out' ? 'text-paper-dim' : 'text-amber';
  const iconColor = tone === 'in' ? 'text-paper-mute' : tone === 'out' ? 'text-paper-mute' : 'text-amber';
  return (
    <div className="rounded-md border p-3" style={{ borderColor: 'var(--ink-500)' }}>
      <div className="flex items-center gap-1.5 text-xs text-paper-mute">
        <span className={iconColor}>{icon}</span> {label}
      </div>
      <p className={cn('mt-1.5 font-mono text-2xl', toneColor)}>{fmtTokens(value)}</p>
      <p className="mt-0.5 text-[10px] text-paper-mute">{hint}</p>
    </div>
  );
}
