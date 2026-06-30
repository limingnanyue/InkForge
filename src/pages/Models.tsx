/**
 * 模型中心 —— LLM 提供商配置（按厂商分组 + 联网搜索）
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Plus, Eye, EyeOff, Zap, Star, Trash2, Cpu, CheckCircle2, XCircle, Globe, RefreshCw, Download, Check } from 'lucide-react';
import { api } from '@/api/client';
import { useApp } from '@/stores/app';
import BlurText from '@/components/BlurText';
import { Spinner, Modal, useToast } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Provider, ProviderKind } from '@shared/types';

const KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini',
  glm: '智谱 GLM', deepseek: 'DeepSeek', doubao: '豆包',
  qwen: '通义', kimi: 'Kimi', hunyuan: '混元', ernie: '文心',
  ollama: 'Ollama', kilo: 'Kilo 公益', kkai: 'KKAPI 网关', custom: '自定义',
};

// 厂商分组：海外 / 国内 / 本地 / 公益
const KIND_CATEGORY: Record<ProviderKind, 'overseas' | 'domestic' | 'local' | 'public'> = {
  openai: 'overseas', anthropic: 'overseas', gemini: 'overseas',
  deepseek: 'domestic', qwen: 'domestic', glm: 'domestic',
  doubao: 'domestic', kimi: 'domestic', hunyuan: 'domestic', ernie: 'domestic',
  ollama: 'local', kilo: 'public', kkai: 'overseas', custom: 'local',
};
const CATEGORY_PRIORITY: Record<string, number> = { overseas: 0, domestic: 1, public: 2, local: 3 };

const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/mcp';

export default function Models() {
  const { providers, defaultProviderId, loadProviders, currentModel, currentProviderId, setCurrentModel } = useApp();
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const { toast, node } = useToast();

  useEffect(() => {
    (async () => {
      try { await loadProviders(); }
      catch (e) { toast((e as Error).message, 'err'); }
      finally { setLoading(false); }
    })();
  }, [loadProviders, toast]);

  // 按 kind 分组排序：海外 → 国内 → 本地，组内保持原序
  const sortedProviders = useMemo(() => {
    return [...providers].sort((a, b) =>
      (CATEGORY_PRIORITY[KIND_CATEGORY[a.kind]] ?? 9) - (CATEGORY_PRIORITY[KIND_CATEGORY[b.kind]] ?? 9)
    );
  }, [providers]);

  const defaultProvider = providers.find(p => p.id === defaultProviderId) || providers[0] || null;

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-8">
      <header className="mb-6 flex items-end justify-between gap-4 animate-fade-up">
        <div>
          <h1 className="font-display text-4xl text-paper">模型中心</h1>
          <BlurText text="配置 LLM 提供商 API Key 后即可生成" as="p" className="mt-1.5 text-sm text-paper-mute" delay={120} stagger={18} />
        </div>
        <button className="btn-primary shrink-0" onClick={() => setAddOpen(true)}><Plus size={16} /> 添加提供商</button>
      </header>

      {/* 顶部：联网搜索全局卡片 */}
      <WebSearchGlobalCard defaultProvider={defaultProvider} onChanged={loadProviders} />

      {/* 厂商卡片网格 */}
      {loading ? (
        <div className="flex h-40 items-center justify-center text-paper-mute"><Spinner /></div>
      ) : sortedProviders.length === 0 ? (
        <p className="text-sm text-paper-mute">暂无提供商，点击右上角添加。</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {sortedProviders.map((p, i) => (
            <ProviderCard key={p.id} provider={p} isDefault={p.id === defaultProviderId}
              onChanged={loadProviders} index={i}
              currentModel={currentModel} currentProviderId={currentProviderId}
              onPickModel={(model) => { setCurrentModel(model, p.id); toast(`已切换为 ${p.name} · ${model}`); }} />
          ))}
        </div>
      )}

      <AddProviderModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={loadProviders} />
      {node}
    </div>
  );
}

/* ============ 联网搜索全局卡片 ============ */
function WebSearchGlobalCard({
  defaultProvider, onChanged,
}: {
  defaultProvider: Provider | null; onChanged: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setKeyInput(defaultProvider?.webSearch.apiKey || '');
  }, [defaultProvider?.id, defaultProvider?.webSearch.apiKey]);

  const saveKey = async () => {
    if (!defaultProvider) { toast('请先添加提供商', 'err'); return; }
    const cur = defaultProvider.webSearch;
    if (keyInput === (cur.apiKey || '')) return;
    setSaving(true);
    try {
      // 全局 Key 存到默认提供商的 webSearch.apiKey，由所有启用联网搜索的提供商共享
      await api.models.updateProvider(defaultProvider.id, {
        webSearch: { ...cur, apiKey: keyInput.trim() },
      });
      onChanged();
      toast('AnySearch API Key 已保存');
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setSaving(false); }
  };

  return (
    <div className="panel-elevated animate-fade-up p-5"
      style={{ background: 'linear-gradient(135deg, rgba(90,138,106,0.10), rgba(212,165,52,0.04))' }}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
          style={{ background: 'rgba(90,138,106,0.15)', border: '1px solid rgba(90,138,106,0.3)' }}>
          <Globe size={18} className="text-celadon" />
        </div>
        <div className="min-w-0">
          <h2 className="font-display text-lg text-paper">联网搜索 · AnySearch MCP</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-paper-dim">
            调用 LLM 前先抓取网页摘要注入上下文，提升年代文 / 行业文 / 历史考据的真实感。匿名可用，配置 API Key 提额。
          </p>
          <p className="mt-1.5 font-mono text-[11px] text-paper-mute">{ANYSEARCH_ENDPOINT}</p>
        </div>
      </div>

      <div className="mt-4">
        <label className="mb-1.5 block text-xs font-medium text-paper-mute">
          AnySearch API Key
          <span className="ml-2 font-normal text-paper-mute">此 Key 适用于所有启用联网搜索的提供商</span>
        </label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input className="input pr-9 font-mono" type={showKey ? 'text' : 'password'}
              placeholder="留空则匿名调用（限速）"
              value={keyInput} onChange={e => setKeyInput(e.target.value)} onBlur={saveKey}
              disabled={!defaultProvider} />
            <button type="button" onClick={() => setShowKey(v => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-paper-mute hover:text-paper">
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {saving && <Spinner className="h-4 w-4 text-paper-mute" />}
        </div>
      </div>
    </div>
  );
}

/* ============ 厂商卡片 ============ */
function ProviderCard({
  provider, isDefault, onChanged, index,
  currentModel, currentProviderId, onPickModel,
}: {
  provider: Provider; isDefault: boolean; onChanged: () => void; index: number;
  currentModel: string; currentProviderId: string | null;
  onPickModel: (model: string) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState(provider.apiKey);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [balance, setBalance] = useState<{ available: boolean; balance?: string; message?: string } | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const { toast } = useToast();

  const configured = !!provider.apiKey?.trim();
  const isOllama = provider.kind === 'ollama';
  const isKilo = provider.kind === 'kilo';
  const statusOk = configured || isOllama || isKilo;  // Kilo 公益无需 API Key
  // 当前卡片是否为全局选中：providerId 匹配 + model 匹配（跨 provider 重名模型才精确）
  const isCardActive = currentProviderId === provider.id && !!currentModel;
  const isModelActive = (m: string) => isCardActive && currentModel === m;

  useEffect(() => { setKeyInput(provider.apiKey); }, [provider.apiKey]);

  // 挂载时自动查询一次余额
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBalanceLoading(true);
      try {
        const r = await api.models.balance(provider.id);
        if (!cancelled) setBalance(r);
      } catch (e) {
        if (!cancelled) setBalance({ available: false, message: (e as Error).message });
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id]);

  const saveKey = async () => {
    if (keyInput === provider.apiKey) return;
    try {
      await api.models.updateProvider(provider.id, { apiKey: keyInput });
      onChanged();
      toast('API Key 已保存');
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  const fetchBalance = async () => {
    setBalanceLoading(true);
    try {
      const r = await api.models.balance(provider.id);
      setBalance(r);
    } catch (e) {
      setBalance({ available: false, message: (e as Error).message });
      toast((e as Error).message, 'err');
    } finally {
      setBalanceLoading(false);
    }
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    try {
      const r = await api.models.fetchModels(provider.id);
      toast(`已拉取 ${r.fetched ?? r.models.length} 个模型`);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setFetchingModels(false);
    }
  };

  const test = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await api.models.testProvider(provider.id);
      setTestResult({ ok: r.ok, msg: r.message });
    } catch (e) { setTestResult({ ok: false, msg: (e as Error).message }); }
    finally { setTesting(false); }
  };
  const setDefault = async () => {
    try { await api.models.setDefault(provider.id); onChanged(); toast('已设为默认'); }
    catch (e) { toast((e as Error).message, 'err'); }
  };
  const remove = async () => {
    try { await api.models.deleteProvider(provider.id); onChanged(); toast('已删除'); }
    catch (e) { toast((e as Error).message, 'err'); }
  };

  return (
    <div className="panel-elevated animate-fade-up p-5" style={{ animationDelay: `${index * 50}ms` }}>
      {/* 头部：厂商名 + kind 徽标 + 状态点 + 默认星标 */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu size={18} className="text-amber" />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-display text-lg text-paper">{provider.name}</h3>
              <span className={cn('h-2 w-2 rounded-full', statusOk ? 'bg-celadon' : 'bg-cinnabar')}
                title={statusOk ? '已配置' : '未配置'} />
            </div>
            <p className="font-mono text-[11px] text-paper-mute">{provider.baseUrl}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="badge badge-mute">{KIND_LABEL[provider.kind]}</span>
          {isDefault && <span className="badge badge-amber"><Star size={11} /> 默认</span>}
        </div>
      </div>

      {/* 模型 chips：可点击切换为全局当前模型，选中者高亮 */}
      <p className="mb-1.5 text-[11px] text-paper-mute">
        {provider.models.length === 0 ? '无模型，点击下方「获取模型」拉取' : '点击模型名切换为当前使用'}
      </p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {provider.models.map((m, i) => {
          const active = isModelActive(m);
          const flagship = i === 0;  // 第一个为旗舰
          return (
            <button
              key={m}
              type="button"
              onClick={() => onPickModel(m)}
              title={active ? '当前使用中' : flagship ? '旗舰模型 · 点击切换为当前' : '点击切换为当前'}
              className={cn(
                'inline-flex items-center gap-1 rounded px-2.5 py-1.5 font-mono text-[11px] transition-all',
                active
                  ? 'text-ink-900'
                  : flagship
                    ? 'hover:-translate-y-0.5'
                    : 'badge badge-mute hover:border-amber-deep hover:text-amber'
              )}
              style={active
                ? { background: 'linear-gradient(90deg,var(--amber-deep),var(--amber))', border: '1px solid var(--amber)' }
                : flagship
                  ? { background: 'rgba(212,165,52,0.10)', color: 'var(--amber)', border: '1px solid var(--amber)' }
                  : undefined}
            >
              {active && <Check size={10} strokeWidth={3} />}
              {m}
            </button>
          );
        })}
        {isOllama && <span className="badge badge-green font-mono text-[10px]">本地部署 · 无需 API Key</span>}
        {isKilo && <span className="badge badge-green font-mono text-[10px]">公益免费 · 每日配额</span>}
      </div>

      {/* API Key */}
      <label className="mb-1.5 block text-xs font-medium text-paper-mute">
        API Key
        {(isOllama || isKilo) && <span className="font-normal text-paper-mute">（{isOllama ? '本地部署' : '公益免费'}可留空）</span>}
      </label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input className="input pr-9 font-mono" type={showKey ? 'text' : 'password'}
            placeholder={(isOllama || isKilo) ? '（可选）' : 'sk-...'}
            value={keyInput} onChange={e => setKeyInput(e.target.value)} onBlur={saveKey} />
          <button type="button" onClick={() => setShowKey(v => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-paper-mute hover:text-paper">
            {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </div>

      {/* 余额 + 获取模型 */}
      <div className="mt-3 flex items-center justify-between gap-3 rounded-md p-2.5"
        style={{ background: 'rgba(212,165,52,0.04)', border: '1px solid var(--ink-500)' }}>
        {/* 左半：余额 */}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="text-xs font-medium text-paper-dim">余额</span>
            <button type="button" onClick={fetchBalance} disabled={balanceLoading}
              className="p-1.5 text-paper-mute hover:text-paper disabled:opacity-50">
              <RefreshCw size={12} />
            </button>
          </div>
          {balanceLoading ? (
            <Spinner className="h-3 w-3" />
          ) : balance === null ? (
            <span className="text-[11px] text-paper-mute">点击刷新查询</span>
          ) : balance.available ? (
            <span className="font-mono text-sm text-amber">{balance.balance}</span>
          ) : (
            <span className="text-[11px] text-paper-mute">{balance.message}</span>
          )}
        </div>
        {/* 右半：获取模型 */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button className="btn-ghost py-1.5 text-xs" onClick={fetchModels} disabled={fetchingModels}>
            {fetchingModels ? <Spinner className="h-3.5 w-3.5" /> : <Download size={13} />} 获取模型
          </button>
          <span className="text-[10px] leading-tight text-paper-mute">从 API 拉取可用模型并合并</span>
        </div>
      </div>

      {/* 操作行 */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn-ghost py-1.5 text-xs" onClick={test} disabled={testing}>
          {testing ? <Spinner className="h-3.5 w-3.5" /> : <Zap size={13} />} 测试连通
        </button>
        {!isDefault && <button className="btn-ghost py-1.5 text-xs" onClick={setDefault}><Star size={13} /> 设为默认</button>}
        <button className="btn-ghost py-1.5 text-xs text-cinnabar" onClick={remove}><Trash2 size={13} /> 删除</button>
        {testResult && (
          <span className={cn('badge', testResult.ok ? 'badge-green' : 'badge-red')}>
            {testResult.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />} {testResult.ok ? '连通正常' : '失败'}
          </span>
        )}
      </div>
      {testResult && !testResult.ok && <p className="mt-2 text-[11px] text-cinnabar">{testResult.msg}</p>}
    </div>
  );
}

/* ============ 添加自定义提供商 ============ */
// 各厂商默认配置：baseUrl / 名称 / 2026 年 6 月最新模型 ID
const KIND_DEFAULTS: Record<ProviderKind, { name: string; baseUrl: string; models: string[] }> = {
  openai:    { name: 'OpenAI',          baseUrl: 'https://api.openai.com/v1',                              models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'o1-preview', 'gpt-4o', 'gpt-4o-mini', 'gpt-image-2'] },
  anthropic: { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com',                             models: ['claude-4.6-opus-20260205', 'claude-4.6-sonnet-20260217', 'claude-fable-5', 'claude-3-5-haiku'] },
  gemini:    { name: 'Google Gemini',   baseUrl: 'https://generativelanguage.googleapis.com/v1beta',     models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  glm:       { name: '智谱 GLM',         baseUrl: 'https://open.bigmodel.cn/api/paas/v4',                 models: ['glm-5.2-pro', 'glm-5.2-flash', 'glm-4-air'] },
  deepseek:  { name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1',                           models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-r1'] },
  doubao:    { name: '字节豆包 Seed',     baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',              models: ['seed-write-pro', 'seed-large', 'seed-flash'] },
  qwen:      { name: '阿里通义 Qwen',    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',    models: ['qwen3.7-turbo', 'qwen3.7-longtext'] },
  kimi:      { name: '月之暗面 Kimi',     baseUrl: 'https://api.moonshot.cn/v1',                            models: ['kimi-k2.7-main', 'kimi-k2.7-code'] },
  hunyuan:   { name: '腾讯混元',          baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',              models: ['hunyuan-hy3-preview'] },
  ernie:     { name: '百度文心 ERNIE',    baseUrl: 'https://qianfan.baidubce.com/v2',                       models: ['ernie-bot-5.1', 'ernie-speed-5.1'] },
  ollama:    { name: '本地 Ollama',      baseUrl: 'http://localhost:11434/v1',                              models: ['llama-4-scout-17b', 'qwen2.5-32b-instruct', 'deepseek-v4'] },
  kilo:      { name: 'Kilo 公益聚合',     baseUrl: 'https://api.kilo.ai/api/openrouter',                     models: ['kilo-auto/free', 'qwen/qwen3.6-plus:free', 'minimax/minimax-m2.5:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'arcee-ai/trinity-large-preview:free', 'stepfun/step-3.5-flash:free'] },
  kkai:      { name: 'KKAPI 网关聚合',    baseUrl: 'https://api.kkaiapi.com/v1',                              models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'claude-4.6-sonnet-20260217', 'gemini-2.5-pro', 'deepseek-v4-pro', 'qwen3.7-turbo', 'gpt-image-2', 'dall-e-3', 'sd3-large', 'flux-pro-1.1'] },
  custom:    { name: '自定义',           baseUrl: '',                                                       models: [] },
};

function AddProviderModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProviderKind>('openai');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  // 切换 kind 时联动：若 name/baseUrl/models 仍是上一个 kind 的默认值（或为空），则一起更新
  const onKindChange = (next: ProviderKind) => {
    const def = KIND_DEFAULTS[next];
    const prevDef = KIND_DEFAULTS[kind];
    // 用户没改动过（等于上一项默认值）才联动覆盖，避免抹掉用户输入
    const nameUntouched = !name || name === prevDef.name;
    const urlUntouched = !baseUrl || baseUrl === prevDef.baseUrl;
    const modelsUntouched = !models || models === prevDef.models.join(', ');
    setKind(next);
    if (nameUntouched) setName(def.name);
    if (urlUntouched) setBaseUrl(def.baseUrl);
    if (modelsUntouched) setModels(def.models.join(', '));
  };

  const submit = async () => {
    if (!name.trim()) { toast('请填写名称', 'err'); return; }
    setBusy(true);
    try {
      await api.models.addProvider({
        name: name.trim(), kind, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(),
        models: models.split(',').map(s => s.trim()).filter(Boolean),
        webSearch: { enabled: false },
      });
      toast('提供商已添加');
      // 重置为 openai 默认
      setName(''); setKind('openai'); setBaseUrl('https://api.openai.com/v1'); setApiKey(''); setModels('');
      onAdded(); onClose();
    } catch (e) { toast((e as Error).message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="添加提供商">
      <div className="space-y-4">
        <Field label="名称"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="如：我的 OpenAI" autoFocus /></Field>
        {/* 第二十二轮修复(H14): grid-cols-1 sm:grid-cols-2 移动端单列降级 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="类型">
            <select className="input" value={kind} onChange={e => onKindChange(e.target.value as ProviderKind)}>
              <optgroup label="海外">
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Google Gemini</option>
              </optgroup>
              <optgroup label="国内">
                <option value="glm">智谱 GLM</option>
                <option value="deepseek">DeepSeek</option>
                <option value="doubao">字节豆包</option>
                <option value="qwen">阿里通义</option>
                <option value="kimi">月之暗面 Kimi</option>
                <option value="hunyuan">腾讯混元</option>
                <option value="ernie">百度文心</option>
              </optgroup>
              <optgroup label="本地">
                <option value="ollama">Ollama</option>
                <option value="custom">自定义</option>
              </optgroup>
              <optgroup label="公益免费">
                <option value="kilo">Kilo 公益聚合（OpenAI 兼容，免费配额）</option>
              </optgroup>
              <optgroup label="网关聚合">
                <option value="kkai">KKAPI 网关（OpenAI 兼容，文本+图像多模型中转）</option>
              </optgroup>
            </select>
          </Field>
          <Field label="Base URL">
            <input className="input font-mono text-[11px]" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://..." />
            {KIND_DEFAULTS[kind] && (
              <span className="mt-1 block text-[10px] text-paper-mute">
                {kind === 'ollama' ? '本地部署，无需 https' : '厂商官方端点，可改'}
              </span>
            )}
          </Field>
        </div>
        <Field label="API Key">
          <input className="input font-mono" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={(kind === 'ollama' || kind === 'kilo') ? '（本地/公益可留空）' : 'sk-...'} />
        </Field>
        <Field label="模型（逗号分隔）">
          <input className="input font-mono text-[11px]" value={models} onChange={e => setModels(e.target.value)} placeholder="gpt-4o, gpt-4o-mini" />
          {KIND_DEFAULTS[kind]?.models.length ? (
            <span className="mt-1 block text-[10px] text-paper-mute">已预填 {KIND_DEFAULTS[kind].models.length} 个 2026 最新模型 ID</span>
          ) : null}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>{busy ? <Spinner className="h-4 w-4" /> : <Plus size={16} />} 添加</button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-medium text-paper-mute">{label}</span>{children}</label>;
}
