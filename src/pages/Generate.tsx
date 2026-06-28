/**
 * 一键生成 —— 向导式成书/成短篇
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, FileText, ArrowLeft, Sparkles, Hash } from 'lucide-react';
import { api } from '@/api/client';
import BlurText from '@/components/BlurText';
import { Spinner, useToast } from '@/components/ui';
import GenreSelect from '@/components/GenreSelect';
import { cn } from '@/lib/utils';
import type { GenerateKind, GenerateConfig } from '@shared/types';

interface Form {
  title: string; targetWords: number; idea: string;
  genre: string; genreId?: string; characters: string;
  hookStyle: string; pace: string; ending: string;
  viewpoint: string; tone: string;
}

const KIND_PRESET: Record<GenerateKind, { label: string; cap: number; default: number; desc: string; icon: typeof BookOpen }> = {
  book: { label: '成书', cap: 1_000_000, default: 300_000, desc: '长篇连载，多卷结构', icon: BookOpen },
  short: { label: '成短篇', cap: 200_000, default: 60_000, desc: '短篇速成，单线推进', icon: FileText },
};

// 题材列表已迁移至后端题材库（GET /api/v1/genres），通过 <GenreSelect> 共享组件渲染
// 详见 src/components/GenreSelect.tsx 与 shared/genres.ts（104 项内置题材 + 用户自定义）

export default function Generate() {
  const [step, setStep] = useState<1 | 2>(1);
  const [kind, setKind] = useState<GenerateKind>('book');
  const [form, setForm] = useState<Form>({
    title: '', targetWords: 300_000, idea: '', genre: '', characters: '',
    hookStyle: '强冲突', pace: '中等', ending: '圆满',
    viewpoint: '第三人称', tone: '爽文',
  });
  const [webSearch, setWebSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { toast, node } = useToast();

  const set = (k: keyof Form, v: any) => setForm(f => ({ ...f, [k]: v }));

  const pickKind = (k: GenerateKind) => {
    setKind(k);
    setForm(f => ({ ...f, targetWords: KIND_PRESET[k].default }));
    setStep(2);
  };

  const submit = async () => {
    if (!form.idea.trim()) { toast('请填写核心创意', 'err'); return; }
    if (form.targetWords > KIND_PRESET[kind].cap) { toast(`目标字数上限 ${KIND_PRESET[kind].cap}`, 'err'); return; }
    if (!form.genre.trim()) { toast('请选择或输入题材', 'err'); return; }
    setBusy(true);
    const config: GenerateConfig = {
      genre: form.genre.trim(),
      genreId: form.genreId || undefined,
      characters: form.characters.trim(),
      hookStyle: form.hookStyle, pace: form.pace, ending: form.ending,
      viewpoint: form.viewpoint, tone: form.tone,
    };
    try {
      await api.generate.trigger({
        kind, targetWords: form.targetWords, config,
        idea: form.idea.trim(), title: form.title.trim() || undefined,
        webSearch,
      });
      toast('已派发到守护进程');
      navigate('/daemon');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(false); }
  };

  const estChapters = Math.max(1, Math.ceil(form.targetWords / 3000));

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 text-center animate-fade-up">
          <BlurText text="一键生成" as="h1" className="font-display text-5xl gradient-text" delay={80} stagger={40} />
          <p className="mt-3 text-sm text-paper-mute">从一句话灵感到完整成书，守护进程后台接力。</p>
        </div>

        {/* 步骤指示 */}
        <div className="mx-auto mb-6 flex w-fit items-center gap-2 text-xs">
          <StepDot n={1} active={step >= 1} label="选择类型" />
          <span className="h-px w-8" style={{ background: 'var(--ink-500)' }} />
          <StepDot n={2} active={step >= 2} label="配置生成" />
        </div>

        {step === 1 ? (
          <Step1 onPick={pickKind} />
        ) : (
          <Step2 kind={kind} form={form} set={set} estChapters={estChapters} busy={busy}
            onBack={() => setStep(1)} onSubmit={submit}
            webSearch={webSearch} setWebSearch={setWebSearch} />
        )}
      </div>
      {node}
    </div>
  );
}

function StepDot({ n, active, label }: { n: number; active: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-mono',
        active ? 'bg-amber text-ink-900' : 'bg-ink-600 text-paper-mute')}>{n}</span>
      <span className={active ? 'text-paper-dim' : 'text-paper-mute'}>{label}</span>
    </div>
  );
}

function Step1({ onPick }: { onPick: (k: GenerateKind) => void }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {(Object.keys(KIND_PRESET) as GenerateKind[]).map(k => {
        const p = KIND_PRESET[k];
        const Icon = p.icon;
        return (
          <button key={k} onClick={() => onPick(k)}
            className="panel-elevated group flex flex-col items-center gap-3 p-8 text-center transition-all duration-200 hover:border-amber-deep hover:-translate-y-1 animate-fade-up">
            <div className="flex h-14 w-14 items-center justify-center rounded-lg transition-colors"
              style={{ background: 'rgba(212,165,52,0.1)', border: '1px solid var(--ink-400)' }}>
              <Icon size={26} className="text-amber" />
            </div>
            <h3 className="font-display text-2xl text-paper group-hover:text-amber">{p.label}</h3>
            <p className="text-xs text-paper-mute">{p.desc}</p>
            <p className="font-mono text-[11px] text-amber-deep">≤ {(p.cap / 10000).toFixed(0)} 万字</p>
          </button>
        );
      })}
    </div>
  );
}

function Step2({ kind, form, set, estChapters, busy, onBack, onSubmit, webSearch, setWebSearch }: {
  kind: GenerateKind; form: Form; set: (k: keyof Form, v: any) => void;
  estChapters: number; busy: boolean; onBack: () => void; onSubmit: () => void;
  webSearch: boolean; setWebSearch: (v: boolean) => void;
}) {
  const cap = KIND_PRESET[kind].cap;
  return (
    <div className="panel-elevated animate-fade-up p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="标题（可选，留空自动命名）">
          <input className="input" placeholder="如：风起观星台" value={form.title} onChange={e => set('title', e.target.value)} />
        </Field>
        <Field label={`目标字数（上限 ${cap.toLocaleString()}）`}>
          <input type="number" min={1000} step={1000} className="input" value={form.targetWords}
            onChange={e => set('targetWords', Math.min(cap, Math.max(1000, Number(e.target.value) || 0)))} />
        </Field>
      </div>
      <Field label="核心创意">
        <textarea className="input min-h-[96px] resize-none" placeholder="一句话点子，越具体越好…"
          value={form.idea} onChange={e => set('idea', e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="题材">
          <GenreSelect
            value={form.genreId}
            label={form.genre}
            onChange={(genreId, label) => {
              set('genreId', genreId);
              set('genre', label);
            }}
          />
        </Field>
        <Field label="主要角色">
          <input className="input" placeholder="主角与对手，用逗号分隔" value={form.characters} onChange={e => set('characters', e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="钩子风格">
          <select className="input" value={form.hookStyle} onChange={e => set('hookStyle', e.target.value)}>
            <option>强冲突</option><option>悬念</option><option>反转</option><option>装逼打脸</option>
          </select>
        </Field>
        <Field label="节奏">
          <select className="input" value={form.pace} onChange={e => set('pace', e.target.value)}>
            <option>紧凑</option><option>中等</option><option>舒缓</option>
          </select>
        </Field>
        <Field label="结局">
          <select className="input" value={form.ending} onChange={e => set('ending', e.target.value)}>
            <option>开放</option><option>圆满</option><option>悲剧</option>
          </select>
        </Field>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="视角">
          <select className="input" value={form.viewpoint} onChange={e => set('viewpoint', e.target.value)}>
            <option>第一人称</option><option>第三人称</option>
          </select>
        </Field>
        <Field label="文风">
          <select className="input" value={form.tone} onChange={e => set('tone', e.target.value)}>
            <option>爽文</option><option>慢热</option><option>正剧</option><option>恶搞</option><option>黑色幽默</option>
          </select>
        </Field>
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-md border p-3" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-900)' }}>
        <button type="button" role="switch" aria-checked={webSearch}
          className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', webSearch ? 'bg-amber' : 'bg-ink-500')}
          onClick={() => setWebSearch(!webSearch)}>
          <span className={cn('absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-paper transition-transform', webSearch && 'translate-x-4')} />
        </button>
        <div className="flex-1">
          <p className="text-xs font-medium text-paper-dim">联网搜索取材</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-paper-mute">开启后，扫榜/大纲/正文阶段都会先抓取 5 条网页摘要注入上下文，适合年代文、行业文、历史考据</p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: 'var(--ink-600)' }}>
        <div className="flex items-center gap-2 text-xs text-paper-mute">
          <Hash size={13} /> 预估 <span className="font-mono text-amber">{estChapters}</span> 章 · 每章约 3000 字
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={onBack}><ArrowLeft size={14} /> 上一步</button>
          <button className="btn-primary" onClick={onSubmit} disabled={busy}>
            {busy ? <Spinner className="h-4 w-4" /> : <Sparkles size={16} />} 开始生成
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-paper-mute">{label}</span>
      {children}
    </label>
  );
}
