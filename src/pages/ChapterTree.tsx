/**
 * 章节树组件 + 树工具函数
 *
 * 渲染策略：
 * - 把递归树先扁平化为带 depth 缩进的线性列表（仅展开节点进入列表）。
 * - 列表长度 > VIRTUAL_THRESHOLD 时启用「视口区间渲染」虚拟滚动：
 *   外层 scrollable container 监听 scroll，根据 scrollTop 计算 startIndex/endIndex，
 *   仅渲染视口附近 ±OVERSCAN 项，用 paddingTop/paddingBottom 撑起总高度。
 *   DOM 数量恒定（~视口可见数 + 2*OVERSCAN），2000+ 章不再卡顿。
 * - 列表较短时走普通平铺渲染，保持小项目体验。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { ChapterNode } from '@shared/types';
import { cn } from '@/lib/utils';
import { fmtWords } from '@/components/ui';
import { POSITIONING_LABEL } from '@/lib/positioning';

// L3 修复(第十七轮): 补 failed 状态样式,原缺 → 失败章节 STATUS_DOT[n.status] 返回 undefined className
const STATUS_DOT: Record<string, string> = { draft: 'bg-ink-400', generating: 'bg-amber', done: 'bg-celadon', failed: 'bg-cinnabar' };

const ITEM_HEIGHT = 36;          // 单行高度（含间距），用于虚拟滚动定位
const OVERSCAN = 5;              // 视口上下额外渲染项数
const VIRTUAL_THRESHOLD = 100;   // 超过此项数才启用虚拟滚动

// 扁平化所有节点（忽略折叠状态，导出工具函数，保持原行为）
export function flatten(nodes: ChapterNode[]): ChapterNode[] {
  const out: ChapterNode[] = [];
  const walk = (ns: ChapterNode[]) => { for (const n of ns) { out.push(n); if (n.children?.length) walk(n.children); } };
  walk(nodes);
  return out;
}

export function countAll(nodes: ChapterNode[]): number {
  return flatten(nodes).length;
}

// 已完成章节近似为快照基数（精确快照数需后端提供）
export function countSnapshots(nodes: ChapterNode[]): number {
  return flatten(nodes).filter(n => n.status === 'done').length;
}

// 不可变更新某个节点
export function mutateNode(nodes: ChapterNode[], id: string, fn: (n: ChapterNode) => void): ChapterNode[] {
  return nodes.map(n => {
    const copy = { ...n };
    if (copy.id === id) fn(copy);
    if (copy.children?.length) copy.children = mutateNode(copy.children, id, fn);
    return copy;
  });
}

// 按折叠状态扁平化为带 depth 的线性列表（仅展开的节点会进入列表）
interface FlatItem {
  node: ChapterNode;
  depth: number;
}
function flattenVisible(nodes: ChapterNode[], collapsed: Set<string>, depth: number, out: FlatItem[]): FlatItem[] {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.children?.length && !collapsed.has(n.id)) {
      flattenVisible(n.children, collapsed, depth + 1, out);
    }
  }
  return out;
}

// 单行按钮（保持与原递归版本一致的样式与交互）
function Row({ item, collapsed, setCollapsed, selectedId, onSelect }: {
  item: FlatItem;
  collapsed: Set<string>;
  setCollapsed: (s: Set<string>) => void;
  selectedId?: string;
  onSelect: (n: ChapterNode) => void;
}) {
  const { node: n, depth } = item;
  const hasChildren = !!n.children?.length;
  const isCollapsed = collapsed.has(n.id);
  return (
    <button
      onClick={() => onSelect(n)}
      className={cn('group flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm transition-colors hover:bg-ink-700',
        selectedId === n.id ? 'bg-ink-700 text-amber' : 'text-paper-dim')}
      style={{ paddingLeft: depth * 12 + 8 }}
    >
      {hasChildren ? (
        <span
          onClick={(e) => { e.stopPropagation(); const s = new Set(collapsed); s.has(n.id) ? s.delete(n.id) : s.add(n.id); setCollapsed(s); }}
          className="text-paper-mute hover:text-paper"
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
      ) : <span className="w-3.5" />}
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[n.status])} />
      <span className="flex-1 truncate">{n.title}</span>
      {/* M4 修复(第十三轮): 章节树显示 oh-story 章节定位标签,作者可一眼看到节奏分布 */}
      {n.positioning && (
        <span className={cn('badge px-1 py-0 text-[9px]', POSITIONING_LABEL[n.positioning][0])}>
          {POSITIONING_LABEL[n.positioning][1]}
        </span>
      )}
      <span className="font-mono text-[10px] text-paper-mute">{fmtWords(n.wordCount)}</span>
    </button>
  );
}

export default function ChapterTree({ nodes, collapsed, setCollapsed, selectedId, onSelect, depth = 0 }: {
  nodes: ChapterNode[];
  collapsed: Set<string>;
  setCollapsed: (s: Set<string>) => void;
  selectedId?: string;
  onSelect: (n: ChapterNode) => void;
  depth?: number;
}) {
  // 折叠状态变化时重新扁平化
  const flatList = useMemo(
    () => flattenVisible(nodes, collapsed, depth, []),
    [nodes, collapsed, depth],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);

  // 挂载后测量真实视口高度
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewportH(el.clientHeight);
  }, []);

  // 节流（rAF 合并）更新 scrollTop / viewportH
  const ticking = useRef(false);
  const onScroll = useCallback(() => {
    if (ticking.current) return;
    ticking.current = true;
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) {
        setScrollTop(el.scrollTop);
        setViewportH(el.clientHeight);
      }
      ticking.current = false;
    });
  }, []);

  const useVirtual = flatList.length > VIRTUAL_THRESHOLD;

  let content: ReactNode;
  if (useVirtual) {
    const total = flatList.length;
    // 折叠后总高度变小，浏览器会 clamp scrollTop，这里同样 clamp 防止渲染空白区
    const maxScrollTop = Math.max(0, total * ITEM_HEIGHT - viewportH);
    const effScrollTop = Math.min(scrollTop, maxScrollTop);
    const startIndex = Math.max(0, Math.floor(effScrollTop / ITEM_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(viewportH / ITEM_HEIGHT) + OVERSCAN * 2;
    const endIndex = Math.min(total, startIndex + visibleCount);
    const paddingTop = startIndex * ITEM_HEIGHT;
    const paddingBottom = (total - endIndex) * ITEM_HEIGHT;
    const slice = flatList.slice(startIndex, endIndex);
    content = (
      <div style={{ paddingTop, paddingBottom }}>
        {slice.map(item => (
          <div key={item.node.id} style={{ height: ITEM_HEIGHT }} className="flex items-center">
            <Row item={item} collapsed={collapsed} setCollapsed={setCollapsed} selectedId={selectedId} onSelect={onSelect} />
          </div>
        ))}
      </div>
    );
  } else {
    content = (
      <div className="space-y-0.5">
        {flatList.map(item => (
          <div key={item.node.id}>
            <Row item={item} collapsed={collapsed} setCollapsed={setCollapsed} selectedId={selectedId} onSelect={onSelect} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
      {content}
    </div>
  );
}
