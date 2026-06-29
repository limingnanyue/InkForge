/**
 * 守护进程：任务队列消费 + 流水线编排
 * - 独立 worker 进程轮询 SQLite 队列
 * - 断点续传：checkpoint 持久化，重启后恢复
 * - 事件总线：SSE 推送进度
 */
import { EventEmitter } from 'events';
import { taskRepo, taskLogRepo, chapterRepo, projectRepo, stateRepo, providerRepo } from './repos.js';
import { runSkill, generateOutline, generateSetup, parseOutline, updateStateFromGeneration, buildChapterAnchor, reconcileState, buildVolumeOutlines, checkChapterQuality } from './engine.js';
import { complete } from './llm.js';
import type { Task, StreamEvent, ProviderKind } from '@shared/types';

// ============ Cancel Token（worker 主动停止信号）============
// 任务开始时 registerToken，cancel/pause 端点调 cancelToken 把 cancelled=true
// 章节循环每次迭代 + withHeartbeat 的 next() 检查 isCancelled，命中则抛 CANCEL_ERROR
// 任务结束（无论成功/失败/抛错）在 finally 块清理 token，防 Map 无限增长
const cancelTokens = new Map<string, { cancelled: boolean }>();

const CANCEL_ERROR = 'TASK_CANCELLED';

export function cancelToken(taskId: string): void {
  const t = cancelTokens.get(taskId);
  if (t) t.cancelled = true;
}

function registerToken(taskId: string): void {
  cancelTokens.set(taskId, { cancelled: false });
}

function isCancelled(taskId: string): boolean {
  return cancelTokens.get(taskId)?.cancelled === true;
}

// ============ 事件总线 ============
export const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emit(event: StreamEvent): void {
  bus.emit('stream', event);
}

export function onStream(listener: (event: StreamEvent) => void): () => void {
  bus.on('stream', listener);
  return () => bus.off('stream', listener);
}

function logTask(taskId: string, level: 'info' | 'warn' | 'error', message: string): void {
  taskLogRepo.create(taskId, level, message);
  emit({ type: 'task:log', taskId, level, message });
}

function progress(taskId: string, progress: number, message: string): void {
  taskRepo.update(taskId, { progress, message });
  emit({ type: 'task:progress', taskId, progress, message });
}

// M7：长流式 chunk 累加包装，每 30s 调一次 taskRepo.heartbeat 防 claimNext 误回收
// 用法：for await (const chunk of withHeartbeat(task.id, stream)) { content += chunk; }
// BUG-3 修复：原 next()「先检查 30s → 发心跳 → 再 await inner.next()」，单次 inner.next()
// 阻塞 4-5 分钟时期间完全无心跳，逼近 claimNext 5min 回收阈值。改用 setInterval 与 inner.next()
// 并发：每 30s 发一次心跳，inner.next() 返回后 clearInterval。本函数无 abortSignal 入参
// （cancel 由任务删除/状态变更实现，loop 顶层 catch 处理），finally 必然清理 interval。
function withHeartbeat<T>(taskId: string, iter: AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const inner = iter[Symbol.asyncIterator]();
      return {
        next: async () => {
          // 流式读取期间响应 cancel/pause：命中则抛 CANCEL_ERROR，让 for-await 上层 catch 退出
          if (isCancelled(taskId)) throw new Error(CANCEL_ERROR);
          const beatInterval = setInterval(() => {
            try { taskRepo.heartbeat(taskId); } catch (e) { console.warn('[heartbeat] 失败', (e as Error).message); }
          }, 30_000);
          try {
            return await inner.next();
          } finally {
            clearInterval(beatInterval);
          }
        },
        return: (v?: T) => inner.return?.(v) ?? Promise.resolve({ value: undefined as any, done: true }),
        throw: (e?: any) => inner.throw?.(e) ?? Promise.resolve({ value: undefined as any, done: true }),
      };
    },
  };
}

// ============ Worker 主循环 ============
let running = false;

export function startWorker(): void {
  if (running) return;
  running = true;
  // D2 修复：loop() 是 async 但 startWorker 同步调用，需 .catch 防 unhandledRejection 杀进程
  loop().catch(err => {
    console.error('[daemon] loop 顶层异常退出，5s 后自愈重启:', err);
    running = false;
    setTimeout(() => { running = true; loop().catch(() => {}); }, 5000);
  });
}

async function loop(): Promise<void> {
  while (running) {
    // D2 修复：claimNext / sleep 都在 try 之外，DB 异常会杀 worker。
    // 整体包一层 try/catch，捕获后等待 5s 自愈（防 SQLITE_BUSY / 磁盘满 / 文件锁）
    let task: Task | null = null;
    try {
      task = taskRepo.claimNext();
    } catch (e) {
      console.error('[daemon] claimNext 失败，5s 后重试:', (e as Error).message);
      await sleep(5000);
      continue;
    }
    if (!task) {
      await sleep(2000);
      continue;
    }
    try {
      const retryTag = task.retryCount > 0 ? `（第 ${task.retryCount + 1} 次尝试）` : '';
      logTask(task.id, 'info', `开始执行任务：${task.type}${retryTag}`);
      registerToken(task.id);
      try {
        await runTask(task);
      } finally {
        cancelTokens.delete(task.id);
      }
      // 任务执行完后再次确认任务仍存在（项目可能在执行中被删除，触发 task 级联删除）
      // D5 修复：get 单独 try/catch，DB 异常时不让已成功的任务走重试路径
      // 原 bug：get 抛错 → 冒泡到外层 catch → 把已成功的任务标记为失败重试 → 浪费 token 重做
      let stillExists = true;
      try {
        stillExists = !!taskRepo.get(task.id);
      } catch (e) {
        console.error(`[daemon] 任务完成后检查存在性失败 ${task.id}:`, (e as Error).message);
        // 假设仍存在，继续走 done 标记（最坏情况下 update 会抛错被内层 try 捕获）
      }
      if (!stillExists) {
        logTask(task.id, 'warn', '任务已随项目删除而移除，跳过状态更新');
        continue;
      }
      // BUG-8 修复：标记 done 单独包 try/catch，DB 异常（磁盘满/锁）不能杀 worker
      // 否则：done 写失败 → 冒泡到外层 catch → catch 又调 taskRepo.update 可能再抛 → 整个 loop 终止
      try {
        taskRepo.update(task.id, { status: 'done', progress: 1, message: '完成', retryCount: 0 });
        emit({ type: 'task:done', taskId: task.id });
        logTask(task.id, 'info', '任务完成');
      } catch (e) {
        logTask(task.id, 'error', `任务已执行成功但标记完成失败：${(e as Error).message}（不重试，继续下个任务）`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      // Cancel/Pause：worker 被信号停止，不重试，保持 paused/已删除状态（checkpoint 保留可 resume 续传）
      if (msg === CANCEL_ERROR) {
        try {
          const fresh = taskRepo.get(task.id);
          if (fresh) {
            // pause 场景：任务仍存在（status=paused），记录日志
            logTask(task.id, 'info', `任务已${fresh.status === 'paused' ? '暂停' : '取消'}，worker 在章节边界停止`);
            emit({ type: 'task:log', taskId: task.id, level: 'warn', message: '任务已停止（checkpoint 保留，可 resume 续传）' });
          }
          // cancel 场景：任务已删除，task_log 随级联删除，无法写日志，只跳过重试
        } catch (e2) {
          console.error(`[daemon] 读取取消任务 ${task.id} 出错:`, (e2 as Error).message);
        }
        continue;
      }
      // BUG-8：catch 分支的 DB 操作也单独包 try/catch，避免二次抛出杀 loop
      let fresh: Task | null = null;
      try {
        fresh = taskRepo.get(task.id);
      } catch (e2) {
        console.error(`[daemon] 读取失败任务 ${task.id} 出错:`, (e2 as Error).message);
        continue;
      }
      // 任务可能随项目删除而不存在，跳过重试逻辑
      if (!fresh) continue;
      // 失败自动重试：保留 checkpoint，状态置回 queued，retry_count+1
      if (fresh.retryCount < fresh.maxRetries) {
        const nextRetry = fresh.retryCount + 1;
        const delayMs = Math.min(60000, 2000 * Math.pow(2, nextRetry - 1)); // 指数退避 2/4/8s
        try {
          taskRepo.update(task.id, {
            status: 'queued',
            progress: 0,
            message: `失败：${msg.slice(0, 80)} · ${delayMs / 1000}s 后第 ${nextRetry} 次重试`,
            retryCount: nextRetry,
          });
        } catch (e2) {
          console.error(`[daemon] 写重试状态失败 ${task.id}:`, (e2 as Error).message);
          continue;
        }
        emit({ type: 'task:log', taskId: task.id, level: 'warn', message: `任务失败（${msg}），${delayMs / 1000}s 后自动重试（${nextRetry}/${fresh.maxRetries}）` });
        logTask(task.id, 'warn', `失败：${msg} · ${delayMs / 1000}s 后第 ${nextRetry}/${fresh.maxRetries} 次重试（保留进度）`);
        await sleep(delayMs);
      } else {
        try {
          taskRepo.update(task.id, { status: 'failed', message: `重试已耗尽：${msg.slice(0, 100)}` });
          emit({ type: 'task:failed', taskId: task.id, message: msg });
          logTask(task.id, 'error', `任务最终失败（重试 ${fresh.maxRetries} 次后放弃）：${msg}`);
        } catch (e2) {
          console.error(`[daemon] 写最终失败状态失败 ${task.id}:`, (e2 as Error).message);
        }
      }
    }
  }
}

export function stopWorker(): void {
  running = false;
}

// ============ 任务分发 ============
async function runTask(task: Task): Promise<void> {
  // 任务级模型选择：优先用 task.config 里的 model/providerId（前端一键生成传入）
  // 不传则回落到 default provider 的旗舰模型
  // 原 bug：始终用 default provider 旗舰模型，忽略前端所选 currentModel/currentProviderId
  const cfg = task.config as { model?: string; providerId?: string; webSearch?: boolean };
  let provider = cfg.providerId ? providerRepo.get(cfg.providerId) : providerRepo.getDefault();
  if (!provider && cfg.providerId) {
    // 指定的 provider 已被删除 → 回落到 default，避免任务直接失败
    logTask(task.id, 'warn', `指定的 provider ${cfg.providerId} 不存在，回落到默认 provider`);
    provider = providerRepo.getDefault();
  }
  // G1 修复：原 validModel 是死变量，pipeline 仍传未校验的 model
  // 现在把校验结果直接赋给 model，配置漂移时真正回落到旗舰
  const rawModel = cfg.model || provider?.models[0] || 'gpt-4o-mini';
  const model = provider && provider.models.includes(rawModel) ? rawModel : (provider?.models[0] || rawModel);
  if (cfg.model && model !== cfg.model) {
    logTask(task.id, 'warn', `模型 ${cfg.model} 不在该 provider 列表中，回落到旗舰 ${model}`);
  }
  const providerId = provider?.id;
  // 任务级联网搜索开关（由 GenerateRequest.webSearch 传入）
  const webSearch = !!cfg.webSearch;

  switch (task.type) {
    case 'book':
      await runBookPipeline(task, model, providerId, webSearch);
      break;
    case 'short':
      await runShortPipeline(task, model, providerId, webSearch);
      break;
    case 'chapter':
      await runChapterGeneration(task, model, providerId, webSearch);
      break;
    case 'refine':
      await runRefine(task, model, providerId);
      break;
    case 'refine-book':
      await runRefineBook(task, model, providerId);
      break;
    default: {
      // 防未来新增 TaskType 时 worker 卡 running → claimNext 5min 回收 → 再 claim → 死循环
      throw new Error(`未知任务类型：${task.type}`);
    }
  }
}

// H1 修复：从项目已完成章节平均字数推断每章字数预算
// 用途：续写任务、单章生成任务未显式传 chapterWordBudget 时，从历史章节推断
//      避免新生成章节字数与原章节不一致（原项目用 3500 生成，续写回落 2500 导致割裂）
function inferChapterWordBudget(projectId: string): number {
  const chapters = chapterRepo.listByProject(projectId);
  const doneChapters = chapters.filter(c => c.content && c.wordCount > 100);
  if (doneChapters.length === 0) return 2500;
  const avg = doneChapters.reduce((s, c) => s + (c.wordCount || 0), 0) / doneChapters.length;
  // 去极端值（删除/重写异常章）：clamp 到 1500-8000
  return Math.max(1500, Math.min(8000, Math.round(avg)));
}

// H4 修复：maxTokens 按 provider kind 放大 token/字 系数
// 国产模型 1 字 ≈ 1.5-2 token，若 maxTokens 直接等于 chapterWordBudget（字数），
// 实际可输出字数 ≈ maxTokens / 1.5，章节会被截断（典型表现：结尾不完整/突兀截断）
// wordBudget（质量门用）保持字数语义不变，只放大 maxTokens 给模型留 token 空间
// 国产（deepseek/qwen/glm/doubao/kimi/hunyuan/ernie）：1.5×
// OpenAI 系（openai/anthropic/gemini/kilo）：1.2×
// ollama/custom/未知：1.5×（保守放大，宁多勿少）
// B7 修复: 加模块级缓存,避免 2000 章循环内反复查 SQLite provider 表(累积 ~200ms 开销)
// provider 修改频率极低(且不影响运行中任务的 ratio),缓存永久驻留可接受
const _tokenRatioCache = new Map<string, number>();
function tokenCharRatio(providerId?: string): number {
  if (!providerId) return 1.5;
  const cached = _tokenRatioCache.get(providerId);
  if (cached !== undefined) return cached;
  const provider = providerRepo.get(providerId);
  let ratio = 1.5;
  if (provider) {
    const CN_KINDS: ProviderKind[] = ['deepseek', 'qwen', 'glm', 'doubao', 'kimi', 'hunyuan', 'ernie'];
    // KKAPI 走 OpenAI 兼容网关，按 OpenAI 标准计费 → 1.2×（与 kilo 一致）
    const LIGHT_KINDS: ProviderKind[] = ['openai', 'anthropic', 'gemini', 'kilo', 'kkai'];
    if (CN_KINDS.includes(provider.kind)) ratio = 1.5;
    else if (LIGHT_KINDS.includes(provider.kind)) ratio = 1.2;
    else ratio = 1.5;  // ollama/custom
  }
  _tokenRatioCache.set(providerId, ratio);
  return ratio;
}
// 缓存失效钩子:provider 修改/删除时调用(由 routes/models.ts 在 PATCH/DELETE 后触发)
export function invalidateTokenRatioCache(providerId?: string): void {
  if (providerId) _tokenRatioCache.delete(providerId);
  else _tokenRatioCache.clear();
}

// ============ 一键成书流水线（最高 500 万字）============
async function runBookPipeline(task: Task, model: string, providerId?: string, webSearch = false): Promise<void> {
  const cfg = task.config as {
    projectId: string; targetWords: number; config: any; idea: string; title: string;
    chapterWordBudget?: number;
  };
  const { projectId, targetWords } = cfg;
  // 每章字数预算：用户可配置，默认 2500（影响大纲章数估算、章节 maxTokens、质量门字数门判定）
  // H1 修复：续写任务未显式传时，从历史章节平均字数推断（防字数不一致）
  const chapterWordBudget = cfg.chapterWordBudget ?? inferChapterWordBudget(projectId);
  // BUG1 辅助：把实际生效的 chapterWordBudget 打到 task log，方便用户排查"选了 2000 但实际 2500"
  logTask(task.id, 'info', `每章字数预算：${chapterWordBudget} 字${cfg.chapterWordBudget ? '（用户配置）' : '（从历史章节平均推断）'} · token 系数 ${tokenCharRatio(providerId)}×`);

  // 断点续传：从 checkpoint 读取进度
  const checkpoint = task.checkpoint as { phase?: string; chapterIdx?: number; outlineJson?: string; scanInsight?: string };
  const phase = checkpoint.phase || 'scan';
  // BUG-3 修复：scan 阶段生成的 scanInsight 在同次执行内不会回写到 task 对象
  // 用局部变量 hold，setup 阶段优先取局部变量，重试场景才从 checkpoint 读
  let scanInsight: string | undefined = checkpoint.scanInsight;

  if (phase === 'scan') {
    progress(task.id, 0.05, webSearch ? '扫榜 + 联网取材中…' : '扫榜分析中…');
    const { text: scanResult } = await complete({
      providerId, model, webSearch,
      projectId,
      searchQuery: `${cfg.config.genre} 网文 热门 套路 2026`,
      messages: [
        { role: 'system', content: '分析题材市场，输出切入点与人设方向，200字内。' },
        { role: 'user', content: `题材：${cfg.config.genre}\n创意：${cfg.idea}` },
      ],
      temperature: 0.7, maxTokens: 512,
    });
    stateRepo.update(projectId, { idea: cfg.idea + '\n\n【扫榜洞察】\n' + scanResult });
    scanInsight = scanResult;  // 局部变量 hold，下方 setup 阶段直接用
    taskRepo.update(task.id, { checkpoint: { phase: 'setup', scanInsight: scanResult } });
    logTask(task.id, 'info', '扫榜完成');
  }

  // setup 阶段：生成世界观设定 + 角色档案，落库后进入 buildContextPrompt 稳定段
  // 原 bug：daemon 跳过此阶段，state.setting/state.characters 永远为空 →
  //   项目详情页「大纲/状态」Tab 的「世界观设定」「角色」永远空白
  if (phase === 'scan' || phase === 'setup') {
    progress(task.id, 0.08, webSearch ? '生成世界观 + 角色档案 + 联网取材中…' : '生成世界观 + 角色档案…');
    // 已有 setting 则跳过（断点续传时避免重做）
    const curState = stateRepo.get(projectId);
    if (!curState?.setting) {
      await generateSetup({
        projectId, model, providerId, config: cfg.config, idea: cfg.idea,
        scanInsight,  // BUG-3 修复：用局部变量（首次执行）或 checkpoint.scanInsight（重试）
        webSearch,
      });
      logTask(task.id, 'info', '世界观 + 角色档案生成完成');
    }
    taskRepo.update(task.id, { checkpoint: { phase: 'outline' } });
  }

  // 大纲阶段
  let outline = checkpoint.outlineJson;
  if (!outline) {
    const totalChapters = Math.max(1, Math.ceil(targetWords / chapterWordBudget));
    // 超长篇（>200 章）会触发分卷生成，每卷一条日志避免长时间无输出被误判卡死
    if (totalChapters > 200) {
      logTask(task.id, 'info', `超长篇（${totalChapters} 章）启用分卷大纲生成，预计 ${Math.ceil(totalChapters / 20)} 卷`);
    }
    progress(task.id, 0.1, totalChapters > 200 ? `分卷大纲生成中（共 ${Math.ceil(totalChapters / 20)} 卷）…` : '生成分章大纲…');
    // 断点续传：从 checkpoint 读取已生成卷的累积 chapters（分卷大纲场景）
    // 重试时 prevVolumes 已有 N 卷数据 → generateOutline 从第 N+1 卷继续，避免从头开始永远卡同一卷
    const cpOutline = checkpoint as { prevVolumesJson?: string };
    const prevVolumes = cpOutline.prevVolumesJson
      ? (() => { try { return parseOutline(cpOutline.prevVolumesJson); } catch { return undefined; } })()
      : undefined;
    if (prevVolumes && prevVolumes.length > 0) {
      logTask(task.id, 'info', `大纲断点续传：已生成 ${prevVolumes.length} 章（约 ${Math.floor(prevVolumes.length / 20)} 卷），从下一卷继续`);
    }
    // H3 修复：generateOutline 是单次 await，200 章大纲 ~30000 tokens，国产慢模型 8-10min
    // 期间 task.updated_at 停滞 → claimNext 5min STALE_MS 阈值误回收 → 多 worker 部署重复生成
    // 用 setInterval 周期发心跳，generateOutline 返回后 clearInterval
    const outlineBeat = setInterval(() => {
      try { taskRepo.heartbeat(task.id); } catch (e) { console.warn('[outline-heartbeat] 失败', (e as Error).message); }
    }, 30_000);
    try {
      outline = await generateOutline({
        projectId, model, providerId, targetWords, config: cfg.config, idea: cfg.idea, webSearch,
        chapterWordBudget,
        prevVolumes,
        onVolumeProgress: (done, total) => {
          logTask(task.id, 'info', `大纲分卷生成 ${done}/${total} 卷完成`);
          progress(task.id, 0.1 + 0.05 * (done / total), `大纲分卷 ${done}/${total}…`);
        },
        onVolumeCheckpoint: (accumulated, doneVolumes, totalVolumes) => {
          // 每完成一卷立即回写 checkpoint：失败/重试时从该卷后继续
          // 注意：checkpoint 用浅合并，phase 保持 outline 不变（直到全部完成才转 chapter）
          taskRepo.update(task.id, { checkpoint: { phase: 'outline', prevVolumesJson: JSON.stringify(accumulated) } });
          logTask(task.id, 'info', `大纲 checkpoint 已保存：${doneVolumes}/${totalVolumes} 卷（${accumulated.length} 章）`);
        },
      });
    } finally {
      clearInterval(outlineBeat);
    }
    taskRepo.update(task.id, { checkpoint: { phase: 'chapter', outlineJson: outline } });
    logTask(task.id, 'info', '大纲生成完成');
  }

  const chapters = parseOutline(outline);
  if (chapters.length === 0) throw new Error('大纲解析失败，请重试');

  // oh-story：长篇 >20 章时生成卷级大纲并落库（供 buildDynamicContext 注入【卷级总览】）
  const existingState = stateRepo.get(projectId);
  if (!existingState?.volumeOutlines || existingState.volumeOutlines.length === 0) {
    const volOutlines = buildVolumeOutlines(chapters.length);
    if (volOutlines.length > 0) {
      stateRepo.update(projectId, { volumeOutlines: volOutlines });
      logTask(task.id, 'info', `生成长篇卷纲：${volOutlines.length} 卷`);
    }
  }

  // === 重启筛查：以数据库实际状态为准，防止跳过/重复 ===
  // 先确保所有大纲章节的记录都存在（标题/大纲补齐，content 不覆盖已有）
  // BUG-1 修复：用 orderIdx 做 Map 索引，而非数组下标
  // 原因：用户删除中间章节后 orderIdx 不连续，数组下标与 orderIdx 失去对应关系，
  //   existing[i] 可能是 orderIdx=3 的章节而非 orderIdx=i，导致补建/续写错位
  const existing = chapterRepo.listByProject(projectId);
  const existingMap = new Map(existing.map(c => [c.orderIdx, c]));
  for (let i = 0; i < chapters.length; i++) {
    if (!existingMap.has(i)) {
      chapterRepo.create({ projectId, title: chapters[i].title, outline: chapters[i].outline, orderIdx: i });
    }
  }
  const fresh = chapterRepo.listByProject(projectId);
  const freshMap = new Map(fresh.map(c => [c.orderIdx, c]));

  // 找出第一个「未完成」（content 为空 或 status !== done）的章节（按 orderIdx）
  let startIdx = chapters.length;
  for (let i = 0; i < chapters.length; i++) {
    const c = freshMap.get(i);
    if (!c || !c.content || c.status !== 'done') { startIdx = i; break; }
  }
  // checkpoint 仅作下限兜底：仅当 checkpoint 比实际进度更靠后才前移（防止 DB 状态被外部篡改导致跳章）
  // 反之若 checkpoint 比 DB 更旧（崩溃前未及时写 checkpoint），信任 DB，不回退重做已 done 章节（避免覆盖正文）
  const cpIdx = typeof checkpoint.chapterIdx === 'number' ? checkpoint.chapterIdx : 0;
  if (cpIdx > startIdx) startIdx = cpIdx;

  if (startIdx < chapters.length) {
    logTask(task.id, 'info', `重启筛查：已完成 ${startIdx}/${chapters.length} 章，从第 ${startIdx + 1} 章续写`);
    // 补全缺失的章节摘要（保证上下文流畅）；传 chapters 让重启补全也带上 positioning/coreEmotion
    // onProgress 每章一条日志：避免 80 章回填时长时间无输出被误判卡死
    const recon = await reconcileState(projectId, model, providerId, chapters, (done, total) => {
      // reconcileState 含串行 LLM 调用（80 章回填可能 40-80 分钟），每章回填后发心跳
      // 否则 task.updated_at 停滞超过 claimNext 的 5 分钟阈值，多 worker 下任务会被误回收
      taskRepo.heartbeat(task.id);
      if (total > 0) logTask(task.id, 'info', `补全剧情记忆 ${done}/${total}（重启回填）`);
    });
    if (recon.backfilled > 0) logTask(task.id, 'info', `补全 ${recon.backfilled} 章缺失记忆完成`);
  }

  for (let i = startIdx; i < chapters.length; i++) {
    if (isCancelled(task.id)) throw new Error(CANCEL_ERROR);
    const ch = chapters[i];
    progress(task.id, 0.1 + (0.8 * (i / chapters.length)), `正在生成第 ${i + 1}/${chapters.length} 章《${ch.title}》`);

    // BUG-1 修复：用 freshMap.get(i) 而非 fresh[i]，章节删除后下标错位
    let chapter = freshMap.get(i);
    if (!chapter) {
      chapter = chapterRepo.create({ projectId, title: ch.title, outline: ch.outline, orderIdx: i });
      freshMap.set(i, chapter);  // 同步到 Map，后续循环可直接取
    }

    // 生成正文（注入位置锚点 + 防跑偏上下文 + 上一章 assistant 作为 history 提升缓存命中）
    // oh-story：按章节定位类型调整 maxTokens（高压章给更多空间，低压/信息章压缩防注水）
    chapterRepo.update(chapter.id, { status: 'generating' });
    let content = '';
    const anchor = buildChapterAnchor(projectId, i, chapters.length, ch.title, ch.outline, ch.positioning, chapterWordBudget, ch.coreEmotion);
    // 章末钩子提示 + 定位对位的字数提示
    const positioningHint = ch.positioning
      ? `（本章为${ch.positioning}，按【本章定位】的字数预算与情绪强度写作）`
      : '';
    const prompt = `${anchor}

请写本章正文${positioningHint}。章末钩子：${ch.hook}

要求：直接输出正文，不要标题，不要解释。严格承接上一章结尾，保持人设一致。剧情推进到位即可结束，不得为凑字数注水。`;
    // 上一章 assistant 输出作为 history（前缀稳定 → OpenAI/Anthropic 缓存命中）
    // BUG-1 修复：用 freshMap.get(i-1) 而非 fresh[i-1]
    const prevChapter = i > 0 ? freshMap.get(i - 1) : undefined;
    const prevHistory = prevChapter?.content
      ? [{ role: 'assistant' as const, content: prevChapter.content.slice(0, 4000) }]
      : [];
    // maxTokens 按定位系数微调：高压章 1.1×，信息/低压章 0.8-0.85×（贴合字数预算Σ契约）
    const TOKEN_MULT: Record<string, number> = { 'high-pressure': 1.1, 'normal-progress': 1.0, 'trial-error': 0.9, 'relationship': 1.0, 'low-pressure': 0.85, 'info-organize': 0.8 };
    const positioningMult = ch.positioning ? (TOKEN_MULT[ch.positioning] ?? 1.0) : 1.0;
    // wordBudget 保持字数语义（质量门按字数判定，不放大）
    const wordBudget = Math.round(chapterWordBudget * positioningMult);
    // H4 修复：maxTokens 按国产模型 token/字 系数放大（1 字 ≈ 1.5-2 token），
    // 否则国产模型实际可输出字数 ≈ maxTokens / 1.5，章节被截断
    const chapterMaxTokens = Math.round(wordBudget * tokenCharRatio(providerId));

    // 章节质量门：生成 → 质检 → 不达标重写一次（避免死循环 + 浪费 token，最多 1 次重写）
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        content = '';
        for await (const chunk of withHeartbeat(task.id, runSkill({ projectId, skill: 'write', model, providerId, userPrompt: prompt, chapterContext: ch.outline, history: prevHistory, maxTokens: chapterMaxTokens, webSearch }))) {
          content += chunk;
        }
        // 质量门检测（字数门 + 跑题门）
        try {
          const quality = await checkChapterQuality({
            projectId, model, providerId,
            chapterIdx: i, chapterTitle: ch.title, outline: ch.outline,
            positioning: ch.positioning, coreEmotion: ch.coreEmotion,
            content, wordBudget,
          });
          if (quality.ok) {
            if (quality.issues.length > 0) {
              logTask(task.id, 'info', `第 ${i + 1} 章质检通过（score ${quality.score.toFixed(2)}）：${quality.issues.join('；')}`);
            }
            break;  // 通过，跳出重写循环
          }
          // 不达标：attempt === 0 时重写一次，attempt === 1 时保留最后结果
          if (attempt === 0) {
            logTask(task.id, 'warn', `第 ${i + 1} 章质检不达标（score ${quality.score.toFixed(2)}），重写一次：${quality.issues.join('；')}`);
            continue;  // 重写一次
          }
          // 重写后仍不达标：保留最后一次结果，标记 warn，不阻断流程
          logTask(task.id, 'warn', `第 ${i + 1} 章重写后仍不达标（score ${quality.score.toFixed(2)}），保留当前结果：${quality.issues.join('；')}`);
          break;
        } catch (e) {
          // 质检异常：不阻断，用当前 content 继续
          logTask(task.id, 'warn', `第 ${i + 1} 章质检异常（不阻断）：${(e as Error).message.slice(0, 100)}`);
          break;
        }
      }
    } catch (e) {
      // 生成失败：回滚 chapter 状态，避免卡在 generating 永远显示"生成中"
      // try/catch 包裹：状态回滚自身若失败（如 DB 约束）不应覆盖原始 LLM 异常
      try { chapterRepo.update(chapter.id, { status: 'failed' }); } catch (e) { console.warn('[chapter-status-rollback] 失败', (e as Error).message); }
      throw e;
    }
    chapterRepo.update(chapter.id, { content, status: 'done' });
    // 同步把刚生成的正文写回 freshMap，让下一章的 prevHistory 能取到本章正文
    // 原 BUG：fresh 是循环开始前的快照，循环内 DB 已更新但快照不变 →
    //   fresh[i-1].content 永远是空值 → 从第 2 章起 prevHistory 永远为空
    //   → 上一章承接信息丢失，跨章一致性变差，OpenAI/Anthropic 缓存命中也失效
    // BUG-1 修复：用 freshMap.set 而非 fresh[i]=
    freshMap.set(i, { ...chapter, content, status: 'done' as const });

    // 每章后立即更新防跑偏三件套（章节摘要/伏笔/角色状态）
    // oh-story：传入大纲里的 positioning + coreEmotion，落库到 ChapterSummary 供三层归档展示
    // 失败不阻断正文落库：状态更新失败只 warn，不让单章状态失败导致整任务重试（与 runChapterGeneration 一致）
    try {
      logTask(task.id, 'info', `更新剧情记忆 · 防跑偏（第 ${i + 1} 章）`);
      await updateStateFromGeneration(projectId, model, providerId, i, ch.positioning, ch.coreEmotion);
    } catch (e) {
      logTask(task.id, 'warn', `第 ${i + 1} 章状态更新失败（不影响正文）：${(e as Error).message.slice(0, 100)}`);
    }
    // BUG-4 修复：checkpoint chapterIdx 推进必须在 updateStateFromGeneration 成功之后
    // 否则 updateState 抛错 → 重试时 startIdx 按"已 done"计算会跳过本章状态更新，导致章节有正文但缺摘要/伏笔
    taskRepo.update(task.id, { checkpoint: { phase: 'chapter', outlineJson: outline, chapterIdx: i + 1 } });
  }

  // 精修阶段（抽样精修最近几章）
  progress(task.id, 0.95, '精修去 AI 味…');
  const allChapters = chapterRepo.listByProject(projectId);
  const toRefine = allChapters.slice(-3);
  for (const ch of toRefine) {
    if (!ch.content) continue;
    let refined = '';
    // 精修 maxTokens 按原文字数动态调整：精修"只改表达不增删情节"，token 空间贴近原文字数 + 10% 余量
    // 原 maxTokens 4096 ≈ 5500 汉字，给 2000-3000 字原文 5500 字空间 → LLM 注水扩写
    // H4 修复：再按国产模型 token/字 系数放大，否则精修结果会被截断（国产 1 字≈1.5-2 token）
    const refineMaxTokens = Math.round(Math.max(2000, (ch.wordCount || chapterWordBudget) * 1.1) * tokenCharRatio(providerId));
    // D3 修复：包 withHeartbeat 防 claimNext 误回收；webSearch:false 显式关闭联网
    for await (const chunk of withHeartbeat(task.id, runSkill({ projectId, skill: 'refine', model, providerId, userPrompt: `精修以下正文：\n${ch.content}`, maxTokens: refineMaxTokens, webSearch: false }))) {
      refined += chunk;
    }
    if (refined.length > 100) chapterRepo.update(ch.id, { content: refined });
  }

  projectRepo.updateWordCount(projectId);
}

// ============ 一键成短篇流水线（二十万字）============
async function runShortPipeline(task: Task, model: string, providerId?: string, webSearch = false): Promise<void> {
  const cfg = task.config as {
    projectId: string; targetWords: number; config: any; idea: string;
    chapterWordBudget?: number;
  };
  const { projectId, targetWords } = cfg;
  // 短篇默认 5000 字/段；若项目已有段落则从平均字数推断（H1：防字数不一致）
  // inferChapterWordBudget 无历史时回落 2500，对短篇偏小，所以显式给 5000 兜底
  const chapters = chapterRepo.listByProject(projectId);
  const doneSegs = chapters.filter(c => c.content && c.wordCount > 100);
  const inferred = doneSegs.length > 0
    ? Math.max(2000, Math.min(10000, Math.round(doneSegs.reduce((s, c) => s + (c.wordCount || 0), 0) / doneSegs.length)))
    : 5000;
  const chapterWordBudget = cfg.chapterWordBudget ?? inferred;
  // BUG1 辅助：把实际生效的 chapterWordBudget 打到 task log
  logTask(task.id, 'info', `每章字数预算：${chapterWordBudget} 字${cfg.chapterWordBudget ? '（用户配置）' : '（从历史段落平均推断）'} · token 系数 ${tokenCharRatio(providerId)}×`);
  const segmentCount = Math.max(1, Math.ceil(targetWords / chapterWordBudget));
  const checkpoint = task.checkpoint as { segmentIdx?: number; outlineJson?: string; setupDone?: boolean };

  // setup 阶段：生成世界观 + 角色档案（短篇同样需要，让正文人设有据可循）
  // 原 bug：短篇 pipeline 直接生成大纲，state.setting/state.characters 永远为空
  if (!checkpoint.setupDone) {
    const curState = stateRepo.get(projectId);
    if (!curState?.setting) {
      progress(task.id, 0.05, webSearch ? '生成世界观 + 角色档案 + 联网取材中…' : '生成世界观 + 角色档案…');
      await generateSetup({
        projectId, model, providerId, config: cfg.config, idea: cfg.idea, webSearch,
      });
      logTask(task.id, 'info', '世界观 + 角色档案生成完成');
    }
    taskRepo.update(task.id, { checkpoint: { setupDone: true } });
  }

  // 生成短篇大纲（分段）—— 断点续传
  let outlineJson = checkpoint.outlineJson;
  if (!outlineJson) {
    progress(task.id, 0.1, webSearch ? '短篇结构 + 联网取材中…' : '生成短篇结构…');
    const prompt = `为短篇生成 ${segmentCount} 段结构。每段约 ${chapterWordBudget} 字。
题材：${cfg.config.genre} | 创意：${cfg.idea} | 钩子风格：${cfg.config.hookStyle} | 结局：${cfg.config.ending}
输出 JSON 数组：[{"title":"段落标题","outline":"段落大纲"}]，只输出 JSON。`;

    const { text: outlineText } = await complete({
      providerId, model, webSearch,
      projectId,
      searchQuery: `${cfg.config.genre} 短篇 结构 套路`,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8, maxTokens: 8192,  // 与 book pipeline 一致；2048 会让 LLM 输出在段数多时被截断（无闭合 ]）
      // BUG-5 修复：短篇 20 万字 = 40 段 JSON 输出，国产慢模型可能 >5min，按段数放宽 wall timeout
      wallTimeoutMs: segmentCount > 20 ? 8 * 60 * 1000 : 5 * 60 * 1000,
    });
    outlineJson = outlineText;
    taskRepo.update(task.id, { checkpoint: { setupDone: true, outlineJson } });
  }
  const segments = parseOutline(outlineJson).map(s => ({ ...s, hook: '' }));
  if (segments.length === 0) {
    // 解析失败时把原始输出前 300 字打到日志，方便排查（不再只说「解析失败」）
    const head = (outlineJson || '').slice(0, 300).replace(/\n/g, ' ');
    throw new Error(`短篇结构解析失败（LLM 输出未含合法 JSON 数组）。原始输出前 300 字：${head}`);
  }

  // === 重启筛查：以数据库实际状态为准 ===
  // BUG-1 修复：用 orderIdx Map 替代数组下标，章节删除后不致错位
  const existingShort = chapterRepo.listByProject(projectId);
  const existingShortMap = new Map(existingShort.map(c => [c.orderIdx, c]));
  let startIdx = segments.length;
  for (let i = 0; i < segments.length; i++) {
    const c = existingShortMap.get(i);
    if (!c || !c.content || c.status !== 'done') { startIdx = i; break; }
  }
  // checkpoint 仅作下限兜底：信任 DB 实际状态，不回退重做已 done 段（避免覆盖正文）
  const cpSeg = typeof checkpoint.segmentIdx === 'number' ? checkpoint.segmentIdx : 0;
  if (cpSeg > startIdx) startIdx = cpSeg;
  if (startIdx < segments.length) {
    logTask(task.id, 'info', `重启筛查：已完成 ${startIdx}/${segments.length} 段，从第 ${startIdx + 1} 段续写`);
    // 传 segments 让重启补全也带上 positioning/coreEmotion（与 book 流水线一致）
    // onProgress 加心跳：reconcileState 串行 LLM 调用耗时长，防 claimNext 5min 阈值误回收
    await reconcileState(projectId, model, providerId, segments, () => {
      taskRepo.heartbeat(task.id);
    });
  }

  for (let i = startIdx; i < segments.length; i++) {
    if (isCancelled(task.id)) throw new Error(CANCEL_ERROR);
    const seg = segments[i];
    progress(task.id, 0.1 + 0.8 * (i / segments.length), `生成第 ${i + 1}/${segments.length} 段《${seg.title}》`);
    // BUG-1 修复：用 existingShortMap.get(i) 而非 existingShort[i]
    let chapter = existingShortMap.get(i);
    if (!chapter) {
      chapter = chapterRepo.create({ projectId, title: seg.title, outline: seg.outline, orderIdx: i });
      existingShortMap.set(i, chapter);
    }
    chapterRepo.update(chapter.id, { status: 'generating' });
    let content = '';
    // BUG-1 修复：用 existingShortMap.get(i-1) 而非 existingShort[i-1]
    const segPrev = i > 0 ? existingShortMap.get(i - 1) : undefined;
    const segPrevHistory = segPrev?.content
      ? [{ role: 'assistant' as const, content: segPrev.content.slice(0, 4000) }]
      : [];
    // 短篇质量门：生成 → 质检 → 不达标重写一次（与 book 流水线一致，wordBudget=5000）
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        content = '';
        // 短篇段约 chapterWordBudget 字，maxTokens 按国产模型 token/字 系数放大（H4 防截断）
        // B6 修复: prompt 上界是 chapterWordBudget * 1.1,maxTokens 需匹配上界
        // wordBudget 保持字数语义不变，用于质量门判定
        const segMaxTokens = Math.round(chapterWordBudget * 1.1 * tokenCharRatio(providerId));
        for await (const chunk of withHeartbeat(task.id, runSkill({ projectId, skill: 'write', model, providerId, userPrompt: `写段落《${seg.title}》，约 ${chapterWordBudget} 字（${Math.round(chapterWordBudget * 0.9)}-${Math.round(chapterWordBudget * 1.1)} 字）。大纲：${seg.outline}。直接输出正文，剧情推进到位即可，不得注水。`, history: segPrevHistory, maxTokens: segMaxTokens, webSearch }))) {
          content += chunk;
        }
        // 质量门检测（字数门 + 跑题门）
        try {
          const quality = await checkChapterQuality({
            projectId, model, providerId,
            chapterIdx: i, chapterTitle: seg.title, outline: seg.outline,
            positioning: seg.positioning, coreEmotion: seg.coreEmotion,
            content, wordBudget: chapterWordBudget,
          });
          if (quality.ok) {
            if (quality.issues.length > 0) {
              logTask(task.id, 'info', `第 ${i + 1} 段质检通过（score ${quality.score.toFixed(2)}）：${quality.issues.join('；')}`);
            }
            break;
          }
          if (attempt === 0) {
            logTask(task.id, 'warn', `第 ${i + 1} 段质检不达标（score ${quality.score.toFixed(2)}），重写一次：${quality.issues.join('；')}`);
            continue;
          }
          logTask(task.id, 'warn', `第 ${i + 1} 段重写后仍不达标（score ${quality.score.toFixed(2)}），保留当前结果：${quality.issues.join('；')}`);
          break;
        } catch (e) {
          logTask(task.id, 'warn', `第 ${i + 1} 段质检异常（不阻断）：${(e as Error).message.slice(0, 100)}`);
          break;
        }
      }
    } catch (e) {
      // 生成失败：回滚段状态，避免卡在 generating
      // try/catch 包裹：状态回滚自身若失败（如 DB 约束）不应覆盖原始 LLM 异常
      try { chapterRepo.update(chapter.id, { status: 'failed' }); } catch (e) { console.warn('[chapter-status-rollback] 失败', (e as Error).message); }
      throw e;
    }
    chapterRepo.update(chapter.id, { content, status: 'done' });
    // 同步把刚生成的正文写回 existingShortMap，让下一段的 segPrevHistory 能取到本段正文
    // 原 BUG：existingShort 是循环开始前的快照，循环内 DB 已更新但快照不变 →
    //   existingShort[i-1].content 永远是空值 → 从第 2 段起 segPrevHistory 永远为空
    // BUG-1 修复：用 existingShortMap.set 而非 existingShort[i]=
    existingShortMap.set(i, { ...chapter, content, status: 'done' as const });
    // 每段后更新防跑偏记忆（传 positioning/coreEmotion 与 book 流水线一致）
    // 失败不阻断正文落库：状态更新失败只 warn，不让单段状态失败导致整任务重试
    try {
      await updateStateFromGeneration(projectId, model, providerId, i, seg.positioning, seg.coreEmotion);
    } catch (e) {
      logTask(task.id, 'warn', `第 ${i + 1} 段状态更新失败（不影响正文）：${(e as Error).message.slice(0, 100)}`);
    }
    // BUG-4 修复：checkpoint 推进必须在 updateState 成功之后，避免重试跳过状态更新
    taskRepo.update(task.id, { checkpoint: { segmentIdx: i + 1, outlineJson } });
  }

  // 精修：精修最近 2 段（短篇段较长，精修多段保证质量）
  progress(task.id, 0.95, '精修中…');
  const toRefineShort = chapterRepo.listByProject(projectId).slice(-2);
  for (const ch of toRefineShort) {
    if (!ch.content) continue;
    let refined = '';
    // 短篇段约 chapterWordBudget 字，精修 maxTokens 按原文字数 + 10% 余量（防注水扩写）
    // H4 修复：再按国产模型 token/字 系数放大，否则精修结果会被截断
    const refineMaxTokens = Math.round(Math.max(3000, (ch.wordCount || chapterWordBudget) * 1.1) * tokenCharRatio(providerId));
    // D3 修复：包 withHeartbeat 防 claimNext 误回收；webSearch:false 显式关闭联网
    for await (const chunk of withHeartbeat(task.id, runSkill({ projectId, skill: 'refine', model, providerId, userPrompt: `精修：\n${ch.content}`, maxTokens: refineMaxTokens, webSearch: false }))) {
      refined += chunk;
    }
    if (refined.length > 100) chapterRepo.update(ch.id, { content: refined });
  }
  projectRepo.updateWordCount(projectId);
}

// ============ 单章生成 ============
async function runChapterGeneration(task: Task, model: string, providerId?: string, webSearch = false): Promise<void> {
  const cfg = task.config as { projectId: string; chapterId: string; prompt: string; chapterWordBudget?: number };
  // 单章字数预算：用户可指定，否则从项目历史章节平均字数推断（H1：防字数不一致）
  const chapterWordBudget = cfg.chapterWordBudget ?? inferChapterWordBudget(cfg.projectId);
  const chapter = chapterRepo.get(cfg.chapterId);
  if (!chapter) throw new Error('章节不存在');
  chapterRepo.update(chapter.id, { status: 'generating' });
  progress(task.id, 0.3, `生成《${chapter.title}》`);
  let content = '';
  // D1 修复：流失败时回滚 status='failed'，避免 chapter 永远卡 'generating' 显示「生成中」
  // 与 runBookPipeline / runShortPipeline 行为一致
  // 单章质量门：与流水线一致，不达标重写一次（wordBudget=chapterWordBudget）
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      content = '';
      // H4 修复：maxTokens 按国产模型 token/字 系数放大，否则章节被截断
      // B6 修复: prompt 上界是 chapterWordBudget * 1.2,maxTokens 需匹配上界(否则 LLM 按上界写满会被截断)
      // wordBudget 保持字数语义不变，用于质量门判定
      const chMaxTokens = Math.round(chapterWordBudget * 1.2 * tokenCharRatio(providerId));
      for await (const chunk of withHeartbeat(task.id, runSkill({ projectId: chapter.projectId, skill: 'write', model, providerId, userPrompt: cfg.prompt || `写第《${chapter.title}》正文，约 ${Math.round(chapterWordBudget * 0.8)}-${Math.round(chapterWordBudget * 1.2)} 字。大纲：${chapter.outline}`, chapterContext: chapter.outline, maxTokens: chMaxTokens, webSearch }))) {
        content += chunk;
      }
      try {
        const quality = await checkChapterQuality({
          projectId: chapter.projectId, model, providerId,
          chapterIdx: chapter.orderIdx, chapterTitle: chapter.title, outline: chapter.outline,
          content, wordBudget: chapterWordBudget,
        });
        if (quality.ok) {
          if (quality.issues.length > 0) {
            logTask(task.id, 'info', `《${chapter.title}》质检通过（score ${quality.score.toFixed(2)}）：${quality.issues.join('；')}`);
          }
          break;
        }
        if (attempt === 0) {
          logTask(task.id, 'warn', `《${chapter.title}》质检不达标（score ${quality.score.toFixed(2)}），重写一次：${quality.issues.join('；')}`);
          continue;
        }
        logTask(task.id, 'warn', `《${chapter.title}》重写后仍不达标（score ${quality.score.toFixed(2)}），保留当前结果：${quality.issues.join('；')}`);
        break;
      } catch (e) {
        logTask(task.id, 'warn', `《${chapter.title}》质检异常（不阻断）：${(e as Error).message.slice(0, 100)}`);
        break;
      }
    }
  } catch (e) {
    try { chapterRepo.update(chapter.id, { status: 'failed' }); } catch (e) { console.warn('[chapter-status-rollback] 失败', (e as Error).message); }
    throw e;
  }
  chapterRepo.update(chapter.id, { content, status: 'done' });
  // oh-story 三件套同步：单章生成后更新摘要/伏笔/角色状态（与 daemon 流水线行为一致）
  // 单章无 positioning（大纲里没有），传 undefined 走默认定位
  try {
    await updateStateFromGeneration(chapter.projectId, model, providerId, chapter.orderIdx);
  } catch (e) {
    // 状态更新失败不阻断单章生成主流程
    console.warn('[chapter-status-update] 失败', (e as Error).message);
  }
}

// ============ 精修 ============
async function runRefine(task: Task, model: string, providerId?: string): Promise<void> {
  const cfg = task.config as { projectId: string; chapterId: string };
  const chapter = chapterRepo.get(cfg.chapterId);
  if (!chapter?.content) throw new Error('章节无内容');
  progress(task.id, 0.3, `精修《${chapter.title}》`);
  let refined = '';
  // D3 修复：(1) 包 withHeartbeat 防 claimNext 5min 超时误回收
  // (2) webSearch:false 显式关闭联网（精修不应触发抓取）
  // (3) maxTokens 按原文字数动态计算（与 runBookPipeline/runShortPipeline 一致，防 4096 注水扩写）
  // H4 修复：再按国产模型 token/字 系数放大，否则精修结果会被截断
  const refineMaxTokens = Math.round(Math.max(2000, (chapter.wordCount || 2500) * 1.1) * tokenCharRatio(providerId));
  for await (const chunk of withHeartbeat(task.id, runSkill({ projectId: chapter.projectId, skill: 'refine', model, providerId, userPrompt: `精修以下正文：\n${chapter.content}`, maxTokens: refineMaxTokens, webSearch: false }))) {
    refined += chunk;
  }
  chapterRepo.snapshot(chapter.id);
  if (refined.length > 100) chapterRepo.update(chapter.id, { content: refined });
}

// ============ 整书去 AI 味精修（守护进程批量任务）============
// 遍历项目所有 done 章节，逐章跑 refine skill 去 AI 味
// 支持断点续传：checkpoint.lastChapterId 记录上次精修到哪一章，重试/续传时跳过已精修章节
// 与 runBookPipeline 一致的工程化：心跳防回收 + cancel token + 章节边界检查
async function runRefineBook(task: Task, model: string, providerId?: string): Promise<void> {
  const cfg = task.config as { projectId: string };
  const projectId = cfg.projectId;

  // 每次启动重新拉取最新章节列表（避免两次运行之间章节被删/改导致下标错位）
  const allChapters = chapterRepo.listByProject(projectId).filter(c => c.content && c.content.length > 100);
  if (allChapters.length === 0) throw new Error('项目无已生成内容的章节，无可精修对象');
  const total = allChapters.length;

  // 断点续传：用 lastChapterOrderIdx 定位（比 lastChapterId 更稳，章节 id 删除后下标错位）
  // refinedCount 用于前端显示「已精修 N/M」
  // BUG-2 修复：原用 lastChapterId + findIndex 定位，章节删除后下标错位
  //   改用 lastChapterOrderIdx：找到第一个 orderIdx > lastChapterOrderIdx 的章节作为起点
  const checkpoint = task.checkpoint as { lastChapterId?: string; lastChapterOrderIdx?: number; totalChapters?: number; refinedCount?: number };
  let startIdx = 0;
  if (typeof checkpoint.lastChapterOrderIdx === 'number') {
    // 用 orderIdx 定位：章节删除不影响（找第一个 orderIdx > 已完成 orderIdx 的章节）
    startIdx = allChapters.findIndex(c => c.orderIdx > checkpoint.lastChapterOrderIdx!);
    if (startIdx < 0) startIdx = allChapters.length;
  } else if (checkpoint.lastChapterId) {
    // 兼容旧 checkpoint：用 id 定位（章节未删除时仍可用）
    const lastDoneIdx = allChapters.findIndex(c => c.id === checkpoint.lastChapterId);
    if (lastDoneIdx >= 0) startIdx = lastDoneIdx + 1;
  }

  // 已全部精修过
  if (startIdx >= total) {
    logTask(task.id, 'info', `整书精修已完成（共 ${total} 章），无需重做`);
    progress(task.id, 1, '整书精修已完成');
    return;
  }

  logTask(task.id, 'info', `整书精修启动：共 ${total} 章，从第 ${startIdx + 1} 章开始`);

  for (let i = startIdx; i < total; i++) {
    if (isCancelled(task.id)) throw new Error(CANCEL_ERROR);
    const ch = allChapters[i];
    progress(task.id, 0.05 + 0.9 * (i / total), `精修第 ${i + 1}/${total} 章《${ch.title}》`);

    // 跳过空内容（理论上前面 filter 已过滤，双保险）
    if (!ch.content || ch.content.length < 100) {
      logTask(task.id, 'warn', `第 ${i + 1} 章内容过短（${ch.content?.length || 0} 字），跳过精修`);
      // BUG-2 修复：checkpoint 同时记录 lastChapterOrderIdx，章节删除后续传不错位
      taskRepo.update(task.id, { checkpoint: { lastChapterId: ch.id, lastChapterOrderIdx: ch.orderIdx, totalChapters: total, refinedCount: i + 1 } });
      continue;
    }

    let refined = '';
    // 精修 maxTokens 按原文字数 × 1.1（与 runRefine 一致，防注水扩写）
    // H4 修复：再按国产模型 token/字 系数放大，否则精修结果会被截断
    const refineMaxTokens = Math.round(Math.max(2000, (ch.wordCount || ch.content.length) * 1.1) * tokenCharRatio(providerId));
    try {
      for await (const chunk of withHeartbeat(task.id, runSkill({
        projectId, skill: 'refine', model, providerId,
        userPrompt: `精修以下正文：\n${ch.content}`,
        maxTokens: refineMaxTokens, webSearch: false,  // 精修不应联网
      }))) {
        refined += chunk;
      }
    } catch (e) {
      // cancel 信号：不推进 checkpoint，直接抛出让 loop 识别（与 runBookPipeline 一致）
      if ((e as Error).message === CANCEL_ERROR) throw e;
      // 单章精修失败：不阻断整书流程，记 warn 继续下一章
      logTask(task.id, 'warn', `第 ${i + 1} 章精修失败（跳过，不影响其他章）：${(e as Error).message.slice(0, 100)}`);
      // BUG-2 修复：checkpoint 同时记录 lastChapterOrderIdx
      taskRepo.update(task.id, { checkpoint: { lastChapterId: ch.id, lastChapterOrderIdx: ch.orderIdx, totalChapters: total, refinedCount: i + 1 } });
      continue;
    }

    // 精修结果过短（< 100 字）视为失败，不覆盖原内容
    if (refined.length < 100) {
      logTask(task.id, 'warn', `第 ${i + 1} 章精修结果过短（${refined.length} 字），保留原文不覆盖`);
    } else {
      // 精修前先存快照（与 runRefine 一致，保留精修前版本供回滚）
      chapterRepo.snapshot(ch.id);
      chapterRepo.update(ch.id, { content: refined });
      logTask(task.id, 'info', `第 ${i + 1} 章精修完成：${ch.content.length} 字 → ${refined.length} 字`);
    }

    // checkpoint 推进（每章后立即写，断点续传粒度 = 1 章）
    // BUG-2 修复：checkpoint 同时记录 lastChapterOrderIdx，章节删除后续传不错位
    taskRepo.update(task.id, { checkpoint: { lastChapterId: ch.id, lastChapterOrderIdx: ch.orderIdx, totalChapters: total, refinedCount: i + 1 } });
  }

  progress(task.id, 1, `整书精修完成（共 ${total} 章）`);
  logTask(task.id, 'info', `整书精修完成（共 ${total} 章）`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
