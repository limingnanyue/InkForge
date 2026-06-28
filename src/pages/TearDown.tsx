/**
 * 拆书 —— 作品结构拆解（参考 oh-story-claudecode 拆文方法论）
 * 输入作品名 / 简介 / 关注点 → 输出 markdown 拆解报告
 */
import { useState } from 'react';
import { Scissors, Globe } from 'lucide-react';
import { api } from '@/api/client';
import { Spinner, useToast, EmptyState } from '@/components/ui';
import { cn } from '@/lib/utils';

export default function TearDown() {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [focus, setFocus] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast, node } = useToast();

  const submit = async () => {
    if (!title.trim()) { toast('请填写作品名', 'err'); return; }
    setBusy(true);
    try {
      const res = await api.analyze.teardown({
        title: title.trim(),
        summary: summary.trim() || undefined,
        focus: focus.trim() || undefined,
        webSearch,
      });
      setResult(res.content);
      toast('拆解完成');
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto max-w-3xl">
        {/* 标题区 */}
        <div className="mb-6 animate-fade-up">
          <h1 className="font-display text-2xl gradient-text">拆书</h1>
          <p className="mt-1 text-sm text-paper-mute">结构拆解 · 人设分析 · 伏笔回收 · 节奏诊断</p>
        </div>

        {/* 输入区 */}
        <div className="panel-elevated p-5 animate-fade-up">
          {/* 作品名 */}
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-paper-dim">
              作品名 <span style={{ color: 'var(--cinnabar)' }}>*</span>
            </label>
            <input className="input" value={title}
              placeholder="如：诡秘之主 / 斗破苍穹"
              onChange={e => setTitle(e.target.value)} />
          </div>

          {/* 作品简介 */}
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-paper-dim">
              作品简介 <span className="text-paper-mute">（可选）</span>
            </label>
            <textarea className="input resize-none" rows={3} value={summary}
              placeholder="粘贴作品简介可提升分析准确度"
              onChange={e => setSummary(e.target.value)} />
          </div>

          {/* 关注点 */}
          <div className="mb-4">
            <label className="mb-1.5 block text-xs font-medium text-paper-dim">
              关注点 <span className="text-paper-mute">（可选）</span>
            </label>
            <input className="input" value={focus}
              placeholder="如：我想学习它的伏笔设计"
              onChange={e => setFocus(e.target.value)} />
          </div>

          {/* 联网搜索 toggle */}
          <div className="flex items-center gap-2.5">
            <Globe size={14} className={cn('transition-colors', webSearch ? 'text-amber' : 'text-paper-mute')} />
            <button type="button" role="switch" aria-checked={webSearch}
              className={cn('relative h-5 w-9 rounded-full transition-colors', webSearch ? 'bg-amber' : 'bg-ink-500')}
              onClick={() => setWebSearch(v => !v)}>
              <span className={cn('absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-paper transition-transform', webSearch && 'translate-x-4')} />
            </button>
            <span className="text-xs text-paper-dim">联网搜索取材</span>
          </div>

          {/* 按钮 */}
          <div className="mt-5 flex justify-end border-t pt-4" style={{ borderColor: 'var(--ink-600)' }}>
            <button className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? <Spinner className="h-4 w-4" /> : <Scissors size={16} />}
              {busy ? '拆解中…' : '开始拆解'}
            </button>
          </div>
        </div>

        {/* 结果区 */}
        <div className="panel mt-5 min-h-[240px] p-5">
          {result ? (
            <div className="prose-ink whitespace-pre-wrap">{result}</div>
          ) : (
            <EmptyState icon={<Scissors size={28} />} title="尚未拆解" desc="输入作品名后开始拆解" />
          )}
        </div>
      </div>
      {node}
    </div>
  );
}
