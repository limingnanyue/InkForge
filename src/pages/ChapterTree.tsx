/**
 * 章节树递归组件 + 树工具函数
 */
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { ChapterNode } from '@shared/types';
import { cn } from '@/lib/utils';
import { fmtWords } from '@/components/ui';

const STATUS_DOT: Record<string, string> = { draft: 'bg-ink-400', generating: 'bg-amber', done: 'bg-celadon' };

// 扁平化所有节点
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

export default function ChapterTree({ nodes, collapsed, setCollapsed, selectedId, onSelect, depth = 0 }: {
  nodes: ChapterNode[];
  collapsed: Set<string>;
  setCollapsed: (s: Set<string>) => void;
  selectedId?: string;
  onSelect: (n: ChapterNode) => void;
  depth?: number;
}) {
  return (
    <div className="space-y-0.5">
      {nodes.map(n => {
        const hasChildren = !!n.children?.length;
        const isCollapsed = collapsed.has(n.id);
        return (
          <div key={n.id}>
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
              <span className="font-mono text-[10px] text-paper-mute">{fmtWords(n.wordCount)}</span>
            </button>
            {hasChildren && !isCollapsed && (
              <ChapterTree nodes={n.children} collapsed={collapsed} setCollapsed={setCollapsed} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}
