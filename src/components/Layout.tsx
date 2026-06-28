/**
 * 主布局 —— 桌面侧边导航 + 移动端底部 Tab
 */
import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { BookOpen, FolderOpen, Sparkles, Cpu, Activity, Download, Settings, PenTool, Menu, TrendingUp, Scissors, Tag } from 'lucide-react';
import { useApp } from '@/stores/app';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/studio', label: '工作台', icon: PenTool, hint: 'AI 对话' },
  { to: '/projects', label: '项目', icon: FolderOpen, hint: '作品库' },
  { to: '/generate', label: '一键生成', icon: Sparkles, hint: '成书/成短篇' },
  { to: '/market', label: '市场风向', icon: TrendingUp, hint: '扫榜分析' },
  { to: '/genres', label: '题材库', icon: Tag, hint: '题材管理' },
  { to: '/teardown', label: '拆书', icon: Scissors, hint: '结构拆解' },
  { to: '/models', label: '模型中心', icon: Cpu, hint: 'LLM 提供商' },
  { to: '/daemon', label: '守护进程', icon: Activity, hint: '任务监控' },
  { to: '/export', label: '导出', icon: Download, hint: '成书导出' },
  { to: '/settings', label: '设置', icon: Settings, hint: '部署与外观' },
];

// 移动端底部 Tab：4 个核心 + 1 个「更多」按钮（打开抽屉显示全部）
const MOBILE_NAV = NAV.slice(0, 4);

export default function Layout({ children }: { children: ReactNode }) {
  const { currentProject, mobileNavOpen, setMobileNav, toggleMobileNav } = useApp();
  const loc = useLocation();

  useEffect(() => { setMobileNav(false); }, [loc.pathname, setMobileNav]);

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      <div className="aura" />

      {/* 桌面侧边栏 */}
      <aside className="relative z-10 hidden w-60 shrink-0 flex-col border-r md:flex" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
        <BrandHeader />
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV.map(item => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => cn('nav-item', isActive && 'active')}>
              <item.icon size={18} strokeWidth={1.5} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        {currentProject && <CurrentProjectChip />}
        <FooterNote />
      </aside>

      {/* 移动端抽屉 */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0" style={{ background: 'rgba(8,6,4,0.6)' }} onClick={() => setMobileNav(false)} />
          <div className="absolute left-0 top-0 h-full w-64 animate-fade-in border-r p-3" style={{ background: 'var(--ink-800)', borderColor: 'var(--ink-600)' }}>
            <BrandHeader />
            <nav className="mt-3 space-y-1">
              {NAV.map(item => (
                <NavLink key={item.to} to={item.to} className={({ isActive }) => cn('nav-item', isActive && 'active')}>
                  <item.icon size={18} strokeWidth={1.5} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      )}

      {/* 主内容 */}
      <main className="relative z-10 flex-1 overflow-hidden pb-16 md:pb-0">
        {children}
      </main>

      {/* 移动端底部 Tab：4 核心 + 更多（打开抽屉显示守护进程/导出/设置） */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 flex items-stretch border-t md:hidden" style={{ background: 'var(--ink-800)', borderColor: 'var(--ink-600)' }}>
        {MOBILE_NAV.map(item => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors', isActive ? 'text-amber' : 'text-paper-mute')}>
            <item.icon size={18} strokeWidth={1.5} />
            <span>{item.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => toggleMobileNav()}
          className="flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium text-paper-mute transition-colors hover:text-amber"
          aria-label="更多导航"
        >
          <Menu size={18} strokeWidth={1.5} />
          <span>更多</span>
        </button>
      </nav>
    </div>
  );
}

function BrandHeader() {
  return (
    <div className="flex items-center gap-2.5 px-4 py-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-md" style={{ background: 'linear-gradient(135deg, var(--amber), var(--amber-deep))' }}>
        <BookOpen size={18} className="text-ink-900" strokeWidth={1.5} />
      </div>
      <div>
        <h1 className="font-display text-lg leading-none text-paper">墨铸</h1>
        <p className="mt-0.5 text-[10px] tracking-wider text-paper-mute">INKFORGE</p>
      </div>
    </div>
  );
}

function CurrentProjectChip() {
  const { currentProject } = useApp();
  if (!currentProject) return null;
  return (
    <div className="m-3 rounded-md border p-3" style={{ borderColor: 'var(--ink-500)', background: 'var(--ink-700)' }}>
      <p className="text-[10px] uppercase tracking-wider text-paper-mute">当前项目</p>
      <p className="mt-1 truncate font-display text-sm text-paper">{currentProject.title}</p>
    </div>
  );
}

function FooterNote() {
  return (
    <div className="px-4 py-3 text-[10px] text-paper-mute">
      <p>套路 = 确定性的情绪满足</p>
      <p className="mt-1">v0.1 · 本地守护已启用</p>
    </div>
  );
}
