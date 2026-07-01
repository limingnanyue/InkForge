/**
 * 一键生成 —— 向导式成书/成短篇
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, FileText, ArrowLeft, Sparkles, Hash, Cpu, Type, Sliders } from 'lucide-react';
import { api } from '@/api/client';
import BlurText from '@/components/BlurText';
import { Spinner, useToast, Field, Switch, SegmentedControl, Slider } from '@/components/ui';
import GenreSelect from '@/components/GenreSelect';
import { useApp } from '@/stores/app';
import { cn } from '@/lib/utils';
import { TONE_PRESETS, getTonePreset, filterTonesByProjectType } from '@shared/tone-presets';
import type { GenerateKind, GenerateConfig } from '@shared/types';

interface Form {
  title: string; targetWords: number; idea: string;
  genre: string; genreId?: string; characters: string;
  hookStyle: string; pace: string; ending: string;
  viewpoint: string; tone: string;
  chapterWordBudget: number;
  // H3 修复(第十九轮): 每章字数上下限 - 用户可自定义浮动范围,默认 = budget*0.8/1.2
  chapterWordMin: number;
  chapterWordMax: number;
}

const KIND_PRESET: Record<GenerateKind, {
  label: string; cap: number; default: number; desc: string; icon: typeof BookOpen;
  budgetMin: number; budgetMax: number; budgetDefault: number; budgetStep: number;
  budgetPresets: { label: string; value: number }[];
}> = {
  book: {
    label: '成书', cap: 5_000_000, default: 300_000,
    desc: '长篇连载，多卷结构（最高 500 万字）', icon: BookOpen,
    budgetMin: 1500, budgetMax: 10000, budgetDefault: 2500, budgetStep: 100,
    budgetPresets: [
      { label: '短章流', value: 1500 },
      { label: '标准', value: 2500 },
      { label: '厚重', value: 3500 },
      { label: '大章', value: 5000 },
      { label: '超大章', value: 8000 },
    ],
  },
  short: {
    label: '成短篇', cap: 200_000, default: 60_000,
    desc: '短篇速成，单线推进', icon: FileText,
    budgetMin: 2000, budgetMax: 12000, budgetDefault: 5000, budgetStep: 500,
    budgetPresets: [
      { label: '紧凑', value: 3000 },
      { label: '标准', value: 5000 },
      { label: '厚实', value: 7000 },
      { label: '大段', value: 10000 },
    ],
  },
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
    chapterWordBudget: 2500,
    // H3 修复(第十九轮): 默认 min/max = budget*0.8/1.2
    chapterWordMin: 2000, chapterWordMax: 3000,
  });
  // BUG3 修复：targetWords 用独立字符串 state 暂存，允许清空重输；onBlur 写入 form.targetWords，submit 校验此原始值
  const [targetWordsInput, setTargetWordsInput] = useState<string>(String(300_000));
  const [webSearch, setWebSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { toast, node } = useToast();
  // 任务级模型选择：从全局 store 取当前所选 model/providerId，submit 时透传到 generate 接口
  // 原 bug：daemon.runTask 始终用 default provider 旗舰模型，前端所选模型被忽略
  const { providers, currentModel, currentProviderId, setCurrentModel, defaultProviderId, loadProviders } = useApp();

  // 第二十六轮 P2 修复: loadProviders 未 catch,后端 500/网络抖动时无反馈,模型下拉常驻占位
  //   现: 与 Studio.tsx 一致加 catch + toast(注:此处 toast 在组件外,用 console.warn 兜底,
  //   实际 toast 在 render 后通过 useToast 提供,此处仅防 unhandledRejection)
  useEffect(() => { loadProviders().catch(e => console.warn('[Generate] loadProviders 失败:', (e as Error).message)); }, [loadProviders]);

  // 兜底：若 store.currentModel 仍空，用默认 provider 旗舰模型补一次（与 Studio 一致）
  useEffect(() => {
    if (!currentModel && providers.length) {
      const def = providers.find(p => p.id === (currentProviderId || defaultProviderId)) || providers[0];
      if (def?.models?.length) setCurrentModel(def.models[0], def.id);
    }
  }, [currentModel, providers, currentProviderId, defaultProviderId, setCurrentModel]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }));

  const pickKind = (k: GenerateKind) => {
    setKind(k);
    const preset = KIND_PRESET[k];
    // H3 修复(第十九轮): 切换 kind 时同步更新 budget + min/max(默认 budget*0.8/1.2)
    const budget = preset.budgetDefault;
    setForm(f => ({
      ...f,
      targetWords: preset.default,
      chapterWordBudget: budget,
      chapterWordMin: Math.round(budget * 0.8),
      chapterWordMax: Math.round(budget * 1.2),
    }));
    setTargetWordsInput(String(preset.default));
    setStep(2);
  };

  // H3 修复(第十九轮): budget 变化时自动联动 min/max(默认 = budget*0.8/1.2)
  // 用户可单独调整 min/max,但调 budget 后 min/max 会被重置为默认值(budget 是主控)
  useEffect(() => {
    setForm(f => ({
      ...f,
      chapterWordMin: Math.round(f.chapterWordBudget * 0.8),
      chapterWordMax: Math.round(f.chapterWordBudget * 1.2),
    }));
  }, [form.chapterWordBudget]);

  const submit = async () => {
    if (!form.idea.trim()) { toast('请填写核心创意', 'err'); return; }
    // LOW-7 修复：创意过长会撑爆 LLM 上下文，限制 2000 字
    if (form.idea.length > 2000) { toast(`创意过长（${form.idea.length} 字），请精简到 2000 字内`, 'err'); return; }
    // BUG5 修复：基于未 clamp 的 targetWordsInput 校验，避免 onChange/onBlur 已 clamp 导致校验失效（死代码）
    const n = Number(targetWordsInput);
    if (isNaN(n) || n < 1000) { toast('字数不能少于 1000', 'err'); return; }
    if (n > KIND_PRESET[kind].cap) { toast(`字数不能超过 ${KIND_PRESET[kind].cap}`, 'err'); return; }
    if (!form.genre.trim()) { toast('请选择或输入题材', 'err'); return; }
    if (!currentModel || !currentProviderId) { toast('请先选择模型', 'err'); return; }
    // H3 修复(第十九轮): 前端校验 chapterWordMin/Max 约束 min <= budget <= max
    if (form.chapterWordMin > form.chapterWordBudget) {
      toast(`每章字数下限(${form.chapterWordMin})不能大于预算(${form.chapterWordBudget})`, 'err'); return;
    }
    if (form.chapterWordMax < form.chapterWordBudget) {
      toast(`每章字数上限(${form.chapterWordMax})不能小于预算(${form.chapterWordBudget})`, 'err'); return;
    }
    if (form.chapterWordMin > form.chapterWordMax) {
      toast(`每章字数下限(${form.chapterWordMin})不能大于上限(${form.chapterWordMax})`, 'err'); return;
    }
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
        kind, targetWords: n, config,
        idea: form.idea.trim(), title: form.title.trim() || undefined,
        webSearch,
        // 每章字数预算透传到 daemon（影响大纲章数估算、章节 maxTokens、质量门字数门判定）
        chapterWordBudget: form.chapterWordBudget,
        // H3 修复(第十九轮): 透传用户配置的每章字数上下限,daemon 用其替代硬编码 budget*0.8/1.2
        chapterWordMin: form.chapterWordMin,
        chapterWordMax: form.chapterWordMax,
        // 透传当前所选模型，daemon 会优先用此 model/providerId 而非 default 旗舰
        model: currentModel,
        providerId: currentProviderId || undefined,
      });
      toast('已派发到守护进程');
      navigate('/daemon');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(false); }
  };

  // HIGH-1 修复：estChapters 除数与 daemon 一致，用 form.chapterWordBudget（默认 2500）
  // 原 bug：UI 显示"预估 N 章 · 每章约 3000 字"，但 daemon 实际每章约 2500 字，预估比实际少 20%
  // 改后：UI 显示的章数与 daemon 估算完全一致
  const estChapters = Math.max(1, Math.ceil(form.targetWords / form.chapterWordBudget));

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
            webSearch={webSearch} setWebSearch={setWebSearch}
            providers={providers} currentModel={currentModel} currentProviderId={currentProviderId}
            onPickModel={(m, pid) => setCurrentModel(m, pid)}
            targetWordsInput={targetWordsInput} setTargetWordsInput={setTargetWordsInput} />
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
            <p className="font-mono text-[11px] text-amber">≤ {(p.cap / 10000).toFixed(0)} 万字</p>
          </button>
        );
      })}
    </div>
  );
}

function Step2({ kind, form, set, estChapters, busy, onBack, onSubmit, webSearch, setWebSearch, providers, currentModel, currentProviderId, onPickModel, targetWordsInput, setTargetWordsInput }: {
  kind: GenerateKind; form: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void;
  estChapters: number; busy: boolean; onBack: () => void; onSubmit: () => void;
  webSearch: boolean; setWebSearch: (v: boolean) => void;
  providers: { id: string; name: string; models: string[] }[];
  currentModel: string | null;
  currentProviderId: string | null;
  onPickModel: (model: string, providerId: string) => void;
  targetWordsInput: string;
  setTargetWordsInput: (v: string) => void;
}) {
  const preset = KIND_PRESET[kind];
  const cap = preset.cap;
  // 编码当前所选：${providerId}::${model}，与 Studio 顶栏下拉一致
  const modelValue = currentProviderId && currentModel ? `${currentProviderId}::${currentModel}` : '';
  // U5 修复：用 indexOf 切第一个 '::' 分隔点，避免 model 名含 '::' 时被 split 全切断裂
  const handleModelChange = (v: string) => {
    const sep = v.indexOf('::');
    if (sep > 0) onPickModel(v.slice(sep + 2), v.slice(0, sep));
  };

  // 检测当前 chapterWordBudget 是否匹配某个预设档位（用于 SegmentedControl 高亮）
  const matchedPreset = preset.budgetPresets.find(p => p.value === form.chapterWordBudget);

  return (
    <div className="panel-elevated animate-fade-up p-6">
      {/* ===== 分组 1：基础信息 ===== */}
      <SectionTitle icon={<Type size={14} />} title="基础信息" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="标题" hint="可选，留空自动命名">
          <input className="input" placeholder="如：风起观星台" value={form.title} onChange={e => set('title', e.target.value)} />
        </Field>
        <Field label={`目标字数`} hint={`上限 ${cap.toLocaleString()}`}>
          <input type="number" min={1000} step={1000} className="input" value={targetWordsInput}
            onChange={e => setTargetWordsInput(e.target.value)}
            onBlur={() => { const v = Number(targetWordsInput); set('targetWords', Math.min(cap, Math.max(1000, v || 0))); }} />
        </Field>
      </div>
      <Field label="核心创意" required>
        <textarea className="input min-h-[96px] resize-none" placeholder="一句话点子，越具体越好…"
          value={form.idea} onChange={e => set('idea', e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="题材" required>
          <GenreSelect
            value={form.genreId}
            label={form.genre}
            projectType={kind === 'book' ? 'long' : kind === 'short' ? 'short' : 'script'}
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

      {/* ===== 分组 2：生成参数（含每章字数预算） ===== */}
      <SectionTitle icon={<Sliders size={14} />} title="生成参数" className="mt-6" />
      <Field label="使用模型" required>
        <div className="flex items-center gap-2">
          <Cpu size={14} className="shrink-0 text-amber" />
          <select className="input" value={modelValue} onChange={e => handleModelChange(e.target.value)} disabled={providers.length === 0}>
            {/* U4 修复：providers 为空或 currentModel 未就绪时显示占位 option，避免下拉视觉选中与实际状态不符 */}
            {(!currentModel || providers.length === 0) && <option value="">请选择模型…</option>}
            {providers.flatMap(p => p.models.map(m => (
              <option key={p.id + m} value={`${p.id}::${m}`}>{p.name} · {m}</option>
            )))}
          </select>
        </div>
      </Field>

      {/* 每章字数预算：预设档位 + 滑块 + 精确输入 + 联动预览 */}
      <Field label="每章字数预算" hint={`影响章数估算与生成字数（${preset.budgetMin}-${preset.budgetMax}）`}>
        <div className="rounded-md border p-3" style={{ borderColor: 'var(--ink-500)', background: 'var(--ink-900)' }}>
          {/* 预设档位 */}
          <SegmentedControl
            options={preset.budgetPresets}
            value={matchedPreset ? form.chapterWordBudget : -1}
            onChange={v => set('chapterWordBudget', v as number)}
          />
          {/* 自定义提示：当前值不在预设档时显式标识 */}
          {!matchedPreset && (
            <p className="mt-1.5 text-[10px] text-amber">
              · 自定义值 {form.chapterWordBudget} 字（不在预设档，将在 {preset.budgetMin}-{preset.budgetMax} 范围内生效）
            </p>
          )}
          {/* 滑块 + 数值 */}
          <div className="mt-3 flex items-center gap-3">
            <Slider
              value={form.chapterWordBudget}
              min={preset.budgetMin}
              max={preset.budgetMax}
              step={preset.budgetStep}
              onChange={v => set('chapterWordBudget', v)}
            />
            <div className="flex w-24 shrink-0 items-center gap-1">
              <input
                type="number"
                min={preset.budgetMin}
                max={preset.budgetMax}
                step={preset.budgetStep}
                className="input px-2 py-1 text-xs"
                value={form.chapterWordBudget}
                onChange={e => {
                  const v = Number(e.target.value);
                  if (!isNaN(v)) set('chapterWordBudget', Math.min(preset.budgetMax, Math.max(preset.budgetMin, v)));
                }}
              />
              <span className="shrink-0 text-[10px] text-paper-mute">字</span>
            </div>
          </div>
          {/* 联动预览：章数 + 总字数 */}
          <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-paper-mute">
            <Hash size={11} />
            预估 <span className="font-mono text-amber">{estChapters}</span> {kind === 'book' ? '章' : '段'} ·
            总计约 <span className="font-mono text-amber">{(form.targetWords / 10000).toFixed(1)}</span> 万字
          </div>
          {/* H3 修复(第十九轮): 每章字数上下限输入 - daemon 会在此范围内浮动生成
              默认 = budget*0.8/1.2(由 useEffect 自动联动),用户可单独调整 */}
          <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-800)' }}>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-paper-mute">每章字数浮动范围</span>
              <span className="text-[10px] text-paper-mute">默认 = 预算 ×0.8 / ×1.2</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex flex-1 items-center gap-1">
                <label className="shrink-0 text-[10px] text-paper-mute">下限</label>
                <input
                  type="number"
                  min={Math.round(preset.budgetMin * 0.5)}
                  max={form.chapterWordBudget}
                  step={preset.budgetStep}
                  className="input px-2 py-1 text-xs"
                  value={form.chapterWordMin}
                  onChange={e => {
                    const v = Number(e.target.value);
                    if (!isNaN(v)) set('chapterWordMin', Math.min(form.chapterWordBudget, Math.max(Math.round(preset.budgetMin * 0.5), v)));
                  }}
                />
              </div>
              <span className="shrink-0 text-[10px] text-paper-mute">—</span>
              <div className="flex flex-1 items-center gap-1">
                <label className="shrink-0 text-[10px] text-paper-mute">上限</label>
                <input
                  type="number"
                  min={form.chapterWordBudget}
                  max={Math.round(preset.budgetMax * 1.5)}
                  step={preset.budgetStep}
                  className="input px-2 py-1 text-xs"
                  value={form.chapterWordMax}
                  onChange={e => {
                    const v = Number(e.target.value);
                    if (!isNaN(v)) set('chapterWordMax', Math.max(form.chapterWordBudget, Math.min(Math.round(preset.budgetMax * 1.5), v)));
                  }}
                />
              </div>
              <span className="shrink-0 text-[10px] text-paper-mute">字</span>
            </div>
            <p className="mt-1.5 text-[10px] text-paper-mute">
              守护进程生成时,每章字数将在 <span className="font-mono text-amber">{form.chapterWordMin}</span>-<span className="font-mono text-amber">{form.chapterWordMax}</span> 区间内浮动(影响大纲 prompt 与正文 prompt)
            </p>
          </div>
        </div>
      </Field>

      {/* ===== 分组 3：风格设定 ===== */}
      <SectionTitle icon={<Sparkles size={14} />} title="风格设定" className="mt-6" />
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
            {filterTonesByProjectType(TONE_PRESETS, kind === 'book' ? 'long' : 'short').map(t => (
              <option key={t.id} value={t.label}>{t.label}</option>
            ))}
          </select>
          {/* 文风写作要求摘要：取 instruction 前 40 字，让用户知道选这个文风会怎么写 */}
          <p className="mt-1.5 text-[10px] text-paper-mute leading-relaxed">
            · {getTonePreset(form.tone).instruction.slice(0, 40)}…
          </p>
        </Field>
      </div>

      {/* 联网搜索开关 */}
      <div className="mt-5 rounded-md border p-3" style={{ borderColor: 'var(--ink-600)', background: 'var(--ink-900)' }}>
        <Switch
          checked={webSearch}
          onChange={setWebSearch}
          label="联网搜索取材"
          desc="开启后，扫榜/大纲/正文阶段都会先抓取 5 条网页摘要注入上下文，适合年代文、行业文、历史考据"
        />
      </div>

      {/* 操作栏 */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: 'var(--ink-600)' }}>
        <div className="flex items-center gap-2 text-xs text-paper-mute">
          <Hash size={13} /> 预估 <span className="font-mono text-amber">{estChapters}</span> {kind === 'book' ? '章' : '段'} · 每章约 <span className="font-mono text-amber">{form.chapterWordBudget}</span> 字
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

// 分组小标题（视觉分区，提升表单节奏感）
function SectionTitle({ icon, title, className }: { icon: React.ReactNode; title: string; className?: string }) {
  return (
    <div className={cn('mb-3 flex items-center gap-2', className)}>
      <span className="text-amber">{icon}</span>
      <h3 className="text-xs font-medium uppercase tracking-wider text-paper-mute">{title}</h3>
      <span className="h-px flex-1" style={{ background: 'var(--ink-500)' }} />
    </div>
  );
}
