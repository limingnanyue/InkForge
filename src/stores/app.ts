/**
 * 全局状态管理（Zustand）
 */
import { create } from 'zustand';
import { api } from '@/api/client';
import type { Project, Provider, Task } from '@shared/types';

const LS_MODEL_KEY = 'inkforge.currentModel';
const LS_PROVIDER_KEY = 'inkforge.currentProviderId';

interface AppState {
  // 当前项目
  currentProject: Project | null;
  projects: Project[];
  // 提供商
  providers: Provider[];
  defaultProviderId: string | null;
  // 全局当前模型（跨页面持久化：模型中心 chip 切换 → Studio 下拉同步）
  currentModel: string;
  currentProviderId: string | null;
  setCurrentModel: (model: string, providerId?: string) => void;
  // 任务（实时更新）
  tasks: Task[];
  // UI
  mobileNavOpen: boolean;
  // actions
  loadProjects: () => Promise<void>;
  setCurrentProject: (p: Project | null) => void;
  loadProviders: () => Promise<void>;
  loadTasks: (projectId?: string) => Promise<void>;
  upsertTask: (t: Task) => void;
  toggleMobileNav: () => void;
  setMobileNav: (v: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  currentProject: null,
  projects: [],
  providers: [],
  defaultProviderId: null,
  currentModel: typeof localStorage !== 'undefined' ? (localStorage.getItem(LS_MODEL_KEY) || '') : '',
  currentProviderId: typeof localStorage !== 'undefined' ? (localStorage.getItem(LS_PROVIDER_KEY) || null) : null,
  tasks: [],
  mobileNavOpen: false,

  loadProjects: async () => {
    const projects = await api.projects.list();
    set({ projects });
  },
  setCurrentProject: (p) => set({ currentProject: p }),
  loadProviders: async () => {
    const providers = await api.models.providers();
    const def = providers.find(p => p.isDefault) || providers[0];
    // 初始化：若 currentModel/currentProviderId 未配置或失效，回落到默认提供商旗舰模型
    let model = get().currentModel;
    let providerId = get().currentProviderId;
    const validProvider = providerId ? providers.find(p => p.id === providerId) : null;
    if (!validProvider) {
      providerId = def?.id || null;
      model = '';
    }
    // BUG-9 修复：currentModel 可能已被 provider 编辑移除，做失效校验
    if (model && validProvider && validProvider.models.length && !validProvider.models.includes(model)) {
      model = validProvider.models[0];  // 回落到该 provider 旗舰模型
    }
    if (!model && validProvider && validProvider.models.length) model = validProvider.models[0];
    if (!model && def && def.models.length) model = def.models[0];
    if (model) localStorage.setItem(LS_MODEL_KEY, model);
    if (providerId) localStorage.setItem(LS_PROVIDER_KEY, providerId);
    set({ providers, defaultProviderId: def?.id || null, currentModel: model, currentProviderId: providerId });
  },
  setCurrentModel: (model, providerId) => {
    localStorage.setItem(LS_MODEL_KEY, model);
    if (providerId !== undefined) {
      localStorage.setItem(LS_PROVIDER_KEY, providerId);
    }
    set({ currentModel: model, currentProviderId: providerId ?? get().currentProviderId });
  },
  loadTasks: async (projectId) => {
    const tasks = await api.tasks.list(projectId);
    set({ tasks });
  },
  upsertTask: (t) => {
    const tasks = get().tasks;
    const idx = tasks.findIndex(x => x.id === t.id);
    if (idx >= 0) {
      const next = [...tasks]; next[idx] = t; set({ tasks: next });
    } else {
      set({ tasks: [t, ...tasks] });
    }
  },
  toggleMobileNav: () => set(s => ({ mobileNavOpen: !s.mobileNavOpen })),
  setMobileNav: (v) => set({ mobileNavOpen: v }),
}));
