/**
 * 市场风向（风向标）—— 扫榜分析 + 历史记录回看
 * 升级：扫榜结果落库 market_scan 表，支持历史回看、删除
 * 题材选择器改为共享 <GenreSelect> 组件（题材库统一从后端拉）
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { TrendingUp, Globe, History, Trash2, Clock } from 'lucide-react';
import { api } from '@/api/client';
import { Spinner, useToast, EmptyState } from '@/components/ui';
import GenreSelect from '@/components/GenreSelect';
import { cn } from '@/lib/utils';
import type { MarketScan } from '@shared/types';

const PERIODS = ['近一个月', '近三个月', '近半年'];

export default function Market() {
  const [genre, setGenre] = useState('');
  const [genreId, setGenreId] = useState<string>('');
  const [period, setPeriod] = useState('近三个月');
  const [webSearch, setWebSearch] = useState(true);  // 默认开联网（已实测可用）
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  // 风向标历史
  const [history, setHistory] = useState<MarketScan[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const { toast, node } = useToast();
  const location = useLocation();

  // 接收来自工作台跳转的预选题材（一键扫榜）
  useEffect(() => {
    const st = (location.state || {}) as { genreId?: string; genre?: string };
    if (st.genre) {
      setGenre(st.genre);
      if (st.genreId) setGenreId(st.genreId);
    }
    // 仅在挂载时消费一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载历史扫榜记录
  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const list = await api.analyze.marketScanList();
      setHistory(list);
    } catch { /* 静默 */ }
    finally { setLoadingHistory(false); }
  };

  useEffect(() => { loadHistory(); }, []);

  const submit = async () => {
    if (!genre) { toast('请选择或输入题材', 'err'); return; }
    setBusy(true);
    setResult('');
    try {
      const res = await api.analyze.market({ genre, genreId: genreId || undefined, period, webSearch });
      setResult(res.content);
      setActiveScanId(res.scanId);
      toast('扫榜分析完成');
      // 刷新历史列表（最新一条置顶）
      loadHistory();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  // 点击历史记录 → 加载该条扫榜结果
  const viewScan = async (scan: MarketScan) => {
    setBusy(true);
    try {
      // 已在列表里有 content，直接用
      setResult(scan.content);
      setGenre(scan.genre);
      setGenreId(scan.genreId || '');
      setPeriod(scan.period);
      setWebSearch(scan.webSearch);
      setActiveScanId(scan.id);
      toast(`已加载 ${scan.genre} 的历史扫榜`);
    } finally { setBusy(false); }
  };

  const deleteScan = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.analyze.marketScanDelete(id);
      setHistory(h => h.filter(s => s.id !== id));
      if (activeScanId === id) { setResult(''); setActiveScanId(null); }
      toast('已删除');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto max-w-5xl">
        {/* 标题区 */}
        <div className="mb-6 animate-fade-up">
          <h1 className="font-display text-2xl gradient-text">市场风向 · 风向标</h1>
          <p className="mt-1 text-sm text-paper-mute">扫榜分析 · 热门套路 · 读者画像 · 切入点建议 · 历史回看</p>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* 左侧：输入区 + 历史 */}
          <div className="space-y-5 lg:col-span-1">
            {/* 输入区 */}
            <div className="panel-elevated p-5 animate-fade-up">
              <GenreSelect
                value={genreId}
                label={genre}
                onChange={(gid, label) => { setGenreId(gid); setGenre(label); }}
                placeholder="— 选择题材 —"
              />

              {/* 时间范围 */}
              <div className="mt-4">
                <span className="mb-1.5 block text-xs font-medium text-paper-dim">时间范围</span>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="时间范围">
                  {PERIODS.map(p => (
                    <button key={p} type="button" role="radio" aria-checked={period === p}
                      className={cn('transition-colors', period === p ? 'badge-amber' : 'badge-mute')}
                      onClick={() => setPeriod(p)}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* 联网搜索 toggle */}
              <div className="mt-4 flex items-center gap-2.5">
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
                  {busy ? <Spinner className="h-4 w-4" /> : <TrendingUp size={16} />}
                  {busy ? '扫榜中…' : '开始扫榜'}
                </button>
              </div>
            </div>

            {/* 风向标历史 */}
            <div className="panel-elevated p-4 animate-fade-up">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-sm font-medium text-paper-dim">
                  <History size={14} /> 历史扫榜
                </h3>
                <button type="button" className="text-paper-mute hover:text-paper text-[11px]" onClick={loadHistory}>
                  刷新
                </button>
              </div>
              {loadingHistory ? (
                <div className="flex h-16 items-center justify-center"><Spinner className="h-3 w-3 text-paper-mute" /></div>
              ) : history.length === 0 ? (
                <p className="text-[11px] text-paper-mute">尚无历史记录，扫榜后会自动保存</p>
              ) : (
                <ul className="space-y-1.5 max-h-80 overflow-y-auto">
                  {history.map(scan => (
                    <li key={scan.id}>
                      <button
                        type="button"
                        onClick={() => viewScan(scan)}
                        className={cn(
                          'group flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                          activeScanId === scan.id ? 'bg-amber/10' : 'hover:bg-ink-700/50'
                        )}
                        style={activeScanId === scan.id ? { background: 'rgba(212,165,52,0.1)' } : undefined}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-paper">{scan.genre}</p>
                          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-paper-mute">
                            <Clock size={10} /> {fmtTime(scan.createdAt)} · {scan.period}
                            {scan.webSearch && <Globe size={10} className="text-amber" />}
                          </p>
                        </div>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => deleteScan(scan.id, e)}
                          onKeyDown={(e) => { if (e.key === 'Enter') deleteScan(scan.id, e as any); }}
                          className="opacity-0 group-hover:opacity-100 text-paper-mute hover:text-cinnabar transition-opacity"
                          aria-label="删除"
                        >
                          <Trash2 size={12} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* 右侧：结果区 */}
          <div className="panel min-h-[400px] p-5 lg:col-span-2">
            {result ? (
              <div className="prose-ink whitespace-pre-wrap">{result}</div>
            ) : (
              <EmptyState icon={<TrendingUp size={28} />} title="尚未分析" desc="选择题材后开始扫榜，或点击左侧历史记录回看" />
            )}
          </div>
        </div>
      </div>
      {node}
    </div>
  );
}
