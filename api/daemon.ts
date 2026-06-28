/**
 * 守护进程：任务队列消费 + 流水线编排
 * - 独立 worker 进程轮询 SQLite 队列
 * - 断点续传：checkpoint 持久化，重启后恢复
 * - 事件总线：SSE 推送进度
 */
import { EventEmitter } from 'events';
import { taskRepo, taskLogRepo, chapterRepo, projectRepo, stateRepo, providerRepo } from './repos.js';
import { runSkill, generateOutline, parseOutline, updateStateFromGeneration, buildChapterAnchor, reconcileState, buildVolumeOutlines } from './engine.js';
import { complete } from './llm.js';
import type { Task, StreamEvent } from '@shared/types';

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
function withHeartbeat<T>(taskId: string, iter: AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const inner = iter[Symbol.asyncIterator]();
      let lastBeat = Date.now();
      return {
        next: async () => {
          const now = Date.now();
          if (now - lastBeat > 30_000) {
            try { taskRepo.heartbeat(taskId); } catch { /* ignore */ }
            lastBeat = now;
          }
          return inner.next();
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
      await runTask(task);
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
  }
}

// ============ 一键成书流水线（百万字）============
async function runBookPipeline(task: Task, model: string, providerId?: string, webSearch = false): Promise<void> {
  const cfg = task.config as {
    projectId: string; targetWords: number; config: any; idea: string; title: string;
  };
  const { projectId, targetWords } = cfg;

  // 断点续传：从 checkpoint 读取进度
  const checkpoint = task.checkpoint as { phase?: string; chapterIdx?: number; outlineJson?: string };
  const phase = checkpoint.phase || 'scan';

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
    taskRepo.update(task.id, { checkpoint: { phase: 'outline' } });
    logTask(task.id, 'info', '扫榜完成');
  }

  // 大纲阶段
  let outline = checkpoint.outlineJson;
  if (!outline) {
    progress(task.id, 0.1, '生成分章大纲…');
    outline = await generateOutline({ projectId, model, providerId, targetWords, config: cfg.config, idea: cfg.idea, webSearch });
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
  const existing = chapterRepo.listByProject(projectId);
  for (let i = 0; i < chapters.length; i++) {
    if (!existing[i]) {
      chapterRepo.create({ projectId, title: chapters[i].title, outline: chapters[i].outline, orderIdx: i });
    }
  }
  const fresh = chapterRepo.listByProject(projectId);

  // 找出第一个「未完成」（content 为空 或 status !== done）的章节
  let startIdx = chapters.length;
  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    if (!c.content || c.status !== 'done') { startIdx = i; break; }
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
      if (total > 0) logTask(task.id, 'info', `补全剧情记忆 ${done}/${total}（重启回填）`);
    });
    if (recon.backfilled > 0) logTask(task.id, 'info', `补全 ${recon.backfilled} 章缺失记忆完成`);
  }

  for (let i = startIdx; i < chapters.length; i++) {
    const ch = chapters[i];
    progress(task.id, 0.1 + (0.8 * (i / chapters.length)), `正在生成第 ${i + 1}/${chapters.length} 章《${ch.title}》`);

    let chapter = fresh[i];
    if (!chapter) {
      chapter = chapterRepo.create({ projectId, title: ch.title, outline: ch.outline, orderIdx: i });
    }

    // 生成正文（注入位置锚点 + 防跑偏上下文 + 上一章 assistant 作为 history 提升缓存命中）
    // oh-story：按章节定位类型调整 maxTokens（高压章给更多空间，低压/信息章压缩防注水）
    chapterRepo.update(chapter.id, { status: 'generating' });
    let content = '';
    const anchor = buildChapterAnchor(projectId, i, chapters.length, ch.title, ch.outline, ch.positioning, 2500, ch.coreEmotion);
    // 章末钩子提示 + 定位对位的字数提示
    const positioningHint = ch.positioning
      ? `（本章为${ch.positioning}，按【本章定位】的字数预算与情绪强度写作）`
      : '';
    const prompt = `${anchor}

请写本章正文${positioningHint}。章末钩子：${ch.hook}

要求：直接输出正文，不要标题，不要解释。严格承接上一章结尾，保持人设一致。剧情推进到位即可结束，不得为凑字数注水。`;
    // 上一章 assistant 输出作为 history（前缀稳定 → OpenAI/Anthropic 缓存命中）
    const prevHistory = i > 0 && fresh[i - 1]?.content
      ? [{ role: 'assistant' as const, content: fresh[i - 1].content.slice(0, 4000) }]
      : [];
    // maxTokens 按定位系数微调：高压章 1.1×，信息/低压章 0.8-0.85×（贴合字数预算Σ契约）
    const TOKEN_MULT: Record<string, number> = { 'high-pressure': 1.1, 'normal-progress': 1.0, 'trial-error': 0.9, 'relationship': 1.0, 'low-pressure': 0.85, 'info-organize': 0.8 };
    const chapterMaxTokens = Math.round(2500 * (ch.positioning ? (TOKEN_MULT[ch.positioning] ?? 1.0) : 1.0));
    try {
      for await (const chunk of withHeartbeat(task.id, runSkill({ projectId, skill: 'write', model, providerId, userPrompt: prompt, chapterContext: ch.outline, history: prevHistory, maxTokens: chapterMaxTokens, webSearch }))) {
        content += chunk;
      }
    } catch (e) {
      // 生成失败：回滚 chapter 状态，避免卡在 generating 永远显示"生成中"
      // try/catch 包裹：状态回滚自身若失败（如 DB 约束）不应覆盖原始 LLM 异常
      try { chapterRepo.update(chapter.id, { status: 'failed' }); } catch { /* 忽略 */ }
      throw e;
    }
    chapterRepo.update(chapter.id, { content, status: 'done' });

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
    const refineMaxTokens = Math.max(2000, Math.round((ch.wordCount || 2500) * 1.1));
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
  };
  const { projectId, targetWords } = cfg;
  const segmentCount = Math.max(1, Math.ceil(targetWords / 5000));
  const checkpoint = task.checkpoint as { segmentIdx?: number; outlineJson?: string };

  // 生成短篇大纲（分段）—— 断点续传
  let outlineJson = checkpoint.outlineJson;
  if (!outlineJson) {
    progress(task.id, 0.1, webSearch ? '短篇结构 + 联网取材中…' : '生成短篇结构…');
    const prompt = `为短篇生成 ${segmentCount} 段结构。每段约 5000 字。
题材：${cfg.config.genre} | 创意：${cfg.idea} | 钩子风格：${cfg.config.hookStyle} | 结局：${cfg.config.ending}
输出 JSON 数组：[{"title":"段落标题","outline":"段落大纲"}]，只输出 JSON。`;

    const { text: outlineText } = await complete({
      providerId, model, webSearch,
      projectId,
      searchQuery: `${cfg.config.genre} 短篇 结构 套路`,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8, maxTokens: 8192,  // 与 book pipeline 一致；2048 会让 LLM 输出在段数多时被截断（无闭合 ]）
    });
    outlineJson = outlineText;
    taskRepo.update(task.id, { checkpoint: { outlineJson } });
  }
  const segments = parseOutline(outlineJson).map(s => ({ ...s, hook: '' }));
  if (segments.length === 0) {
    // 解析失败时把原始输出前 300 字打到日志，方便排查（不再只说「解析失败」）
    const head = (outlineJson || '').slice(0, 300).replace(/\n/g, ' ');
    throw new Error(`短篇结构解析失败（LLM 输出未含合法 JSON 数组）。原始输出前 300 字：${head}`);
  }

  // === 重启筛查：以数据库实际状态为准 ===
  const existingShort = chapterRepo.listByProject(projectId);
  let startIdx = segments.length;
  for (let i = 0; i < Math.max(existingShort.length, segments.length); i++) {
    const c = existingShort[i];
    if (!c || !c.content || c.status !== 'done') { startIdx = i; break; }
  }
  // checkpoint 仅作下限兜底：信任 DB 实际状态，不回退重做已 done 段（避免覆盖正文）
  const cpSeg = typeof checkpoint.segmentIdx === 'number' ? checkpoint.segmentIdx : 0;
  if (cpSeg > startIdx) startIdx = cpSeg;
  if (startIdx < segments.length) {
    logTask(task.id, 'info', `重启筛查：已完成 ${startIdx}/${segments.length} 段，从第 ${startIdx + 1} 段续写`);
    // 传 segments 让重启补全也带上 positioning/coreEmotion（与 book 流水线一致）
    await reconcileState(projectId, model, providerId, segments);
  }

  for (let i = startIdx; i < segments.length; i++) {
    const seg = segments[i];
    progress(task.id, 0.1 + 0.8 * (i / segments.length), `生成第 ${i + 1}/${segments.length} 段《${seg.title}》`);
    let chapter = existingShort[i];
    if (!chapter) {
      chapter = chapterRepo.create({ projectId, title: seg.title, outline: seg.outline, orderIdx: i });
    }
    chapterRepo.update(chapter.id, { status: 'generating' });
    let content = '';
    const segPrevHistory = i > 0 && existingShort[i - 1]?.content
      ? [{ role: 'assistant' as const, content: existingShort[i - 1].content.slice(0, 4000) }]
      : [];
    try {
      for await (const chunk of withHeartbeat(task.id, runSkill({ projectId, skill: 'write', model, providerId, userPrompt: `写段落《${seg.title}》，约 5000 字（4500-5500 字）。大纲：${seg.outline}。直接输出正文，剧情推进到位即可，不得注水。`, history: segPrevHistory, maxTokens: 5000, webSearch }))) {
        content += chunk;
      }
    } catch (e) {
      // 生成失败：回滚段状态，避免卡在 generating
      // try/catch 包裹：状态回滚自身若失败（如 DB 约束）不应覆盖原始 LLM 异常
      try { chapterRepo.update(chapter.id, { status: 'failed' }); } catch { /* 忽略 */ }
      throw e;
    }
    chapterRepo.update(chapter.id, { content, status: 'done' });
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
    // 短篇段约 5000 字，精修 maxTokens 按原文字数 + 10% 余量（防注水扩写）
    const refineMaxTokens = Math.max(3000, Math.round((ch.wordCount || 5000) * 1.1));
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
  const cfg = task.config as { projectId: string; chapterId: string; prompt: string };
  const chapter = chapterRepo.get(cfg.chapterId);
  if (!chapter) throw new Error('章节不存在');
  chapterRepo.update(chapter.id, { status: 'generating' });
  progress(task.id, 0.3, `生成《${chapter.title}》`);
  let content = '';
  // D1 修复：流失败时回滚 status='failed'，避免 chapter 永远卡 'generating' 显示「生成中」
  // 与 runBookPipeline / runShortPipeline 行为一致
  try {
    for await (const chunk of withHeartbeat(task.id, runSkill({ projectId: chapter.projectId, skill: 'write', model, providerId, userPrompt: cfg.prompt || `写第《${chapter.title}》正文，约 2000-3000 字。大纲：${chapter.outline}`, chapterContext: chapter.outline, maxTokens: 2500, webSearch }))) {
      content += chunk;
    }
  } catch (e) {
    try { chapterRepo.update(chapter.id, { status: 'failed' }); } catch { /* 忽略回滚失败 */ }
    throw e;
  }
  chapterRepo.update(chapter.id, { content, status: 'done' });
  // oh-story 三件套同步：单章生成后更新摘要/伏笔/角色状态（与 daemon 流水线行为一致）
  // 单章无 positioning（大纲里没有），传 undefined 走默认定位
  try {
    await updateStateFromGeneration(chapter.projectId, model, providerId, chapter.orderIdx);
  } catch {
    // 状态更新失败不阻断单章生成主流程
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
  const refineMaxTokens = Math.max(2000, Math.round((chapter.wordCount || 2500) * 1.1));
  for await (const chunk of withHeartbeat(task.id, runSkill({ projectId: chapter.projectId, skill: 'refine', model, providerId, userPrompt: `精修以下正文：\n${chapter.content}`, maxTokens: refineMaxTokens, webSearch: false }))) {
    refined += chunk;
  }
  chapterRepo.snapshot(chapter.id);
  if (refined.length > 100) chapterRepo.update(chapter.id, { content: refined });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
