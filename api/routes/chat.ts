/**
 * AI 对话路由 —— SSE 流式输出
 * 意图识别：对话续写 / 精修 / 生成，调用对应 skill
 */
import { Router, type Request, type Response } from 'express';
import { messageRepo, projectRepo, providerRepo, chapterRepo } from '../repos.js';
import { runSkill } from '../engine.js';
import { createContinueTask } from './generate.js';
import { cryptoRandomId } from '../db.js';
import type { ChatCompletionMessage } from '@shared/types';

const router = Router();

const fail = (res: Response, code: string, message: string, status = 400) =>
  res.status(status).json({ ok: false, error: { code, message } });

router.post('/', async (req: Request, res: Response) => {
  const { projectId, message, providerId, model, webSearch } = req.body || {};
  if (!message) return fail(res, 'INVALID', '消息内容必填');
  if (!projectId) return fail(res, 'INVALID', '项目 ID 必填');

  const project = projectRepo.get(projectId);
  if (!project) return fail(res, 'NOT_FOUND', '项目不存在', 404);

  const provider = providerId ? providerRepo.get(providerId) : providerRepo.getDefault();
  const useModel = model || provider?.models[0] || 'gpt-4o-mini';

  // 保存用户消息
  messageRepo.create({ projectId, role: 'user', content: message });

  // 意图识别
  const intent = detectIntent(message);
  const assistantId = cryptoRandomId();

  // 联网搜索：请求显式传入优先，否则用项目级开关
  const finalWebSearch = typeof webSearch === 'boolean' ? webSearch : project.webSearchEnabled;

  // SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 守护进程意图：短路处理，不调 runSkill（engine 不支持 daemon skill）
  // daemon_create：基于当前项目直接创建续写任务，跳 /daemon 看进度
  // daemon_view：仅跳 /daemon 查看任务列表
  const isDaemonCreate = intent === 'daemon_create';
  const isDaemonView = intent === 'daemon_view';
  let daemonTaskId: string | undefined;
  let daemonError: string | undefined;

  if (isDaemonCreate) {
    try {
      // BUG-4 修复：派发守护任务时透传用户选择的 model/providerId
      // 原代码：createContinueTask(projectId, finalWebSearch) → 丢失 model 和 providerId，回落到 default provider
      const result = createContinueTask(projectId, finalWebSearch, model, providerId);
      if (result) daemonTaskId = result.task.id;
      else daemonError = '项目不存在';
    } catch (e) {
      daemonError = (e as Error).message;
    }
  }

  const navTarget = (isDaemonCreate || isDaemonView) ? '/daemon' : undefined;
  res.write(`event:meta\ndata:${JSON.stringify({
    messageId: assistantId, intent, webSearch: finalWebSearch,
    action: navTarget ? 'navigate' : undefined, target: navTarget,
    taskId: daemonTaskId,
  })}\n\n`);

  try {
    let acc = '';

    if (navTarget) {
      // 守护进程意图：输出引导文案后直接结束
      if (isDaemonCreate) {
        acc = daemonError
          ? `抱歉，派发守护进程任务失败：${daemonError}`
          : `好的，已为当前项目《${project.title}》派发续写任务到守护进程，正在后台持续写作。`;
      } else {
        acc = '已为你打开守护进程面板，可查看任务进度、暂停/恢复/重试。';
      }
      res.write(`event:chunk\ndata:${JSON.stringify({ delta: acc })}\n\n`);
      messageRepo.create({ projectId, role: 'assistant', content: acc });
      res.write(`event:done\ndata:${JSON.stringify({ messageId: assistantId, content: acc })}\n\n`);
      res.end();
      return;
    }

    // 加载多轮对话历史（最近 8 轮，避免上下文爆炸；旧前缀稳定 → 缓存命中）
    // BUG-2 修复：原 listByProject(projectId) 不传 limit 全量加载后 .slice(-17,-1)
    // 长对话全量加载浪费内存。repos.ts 的 limit 参数语义为「取最近 N 条」(ORDER BY created_at DESC LIMIT N 再 ASC)
    // 传 17：取最近 17 条（含刚保存的当前 user），slice(-17,-1) 去掉当前 user 后得 16 条历史
    const history = messageRepo.listByProject(projectId, 17)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-17, -1) // 去掉刚保存的当前 user 消息，取之前最多 16 条（8 轮）
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const params = buildSkillParams(intent, projectId, message, useModel, providerId, finalWebSearch, history, req.body.chapterId);

    // R1 修复：监听客户端断开，cancelled 标志触发 for-await break
    // 原 bug：客户端断开后 for-await 仍持续从上游 LLM 读 token，后端继续烧钱直到 wall timeout
    // break 会触发 async generator 的 finally → reader.cancel() 释放上游连接
    let cancelled = false;
    const onClose = () => { cancelled = true; };
    req.on('close', onClose);

    try {
      for await (const chunk of runSkill(params)) {
        if (cancelled || res.writableEnded) break;
        acc += chunk;
        // res.write 在客户端断开后可能抛 ERR_STREAM_DESTROYED/EPIPE，需容错
        try {
          res.write(`event:chunk\ndata:${JSON.stringify({ delta: chunk })}\n\n`);
        } catch {
          cancelled = true;
          break;
        }
      }
    } finally {
      req.off('close', onClose);
    }

    if (cancelled) {
      // 客户端已断开，仍保存已生成部分（避免 token 浪费 + 数据丢失）
      if (acc.trim()) messageRepo.create({ projectId, role: 'assistant', content: acc });
      try { res.end(); } catch { /* 已断开 */ }
      return;
    }

    // 保存助手消息
    messageRepo.create({ projectId, role: 'assistant', content: acc });

    // 若意图是续写/精修且存在当前章节，写入章节
    if ((intent === 'write' || intent === 'refine') && req.body.chapterId) {
      const chapter = chapterRepo.get(req.body.chapterId);
      if (chapter) {
        if (intent === 'refine') chapterRepo.snapshot(chapter.id);
        chapterRepo.update(chapter.id, { content: acc, status: 'done' });
        // oh-story 三件套同步：续写后更新章节摘要/伏笔/角色状态（防跑偏一致性）
        // 精修不改情节但字数会变，刷新摘要的 wordBudget 保持 Σ 契约校验准确
        try {
          const { updateStateFromGeneration } = await import('../engine.js');
          await updateStateFromGeneration(projectId, useModel, providerId, chapter.orderIdx);
        } catch {
          // 状态更新失败不阻断对话主流程
        }
      }
    }

    res.write(`event:done\ndata:${JSON.stringify({ messageId: assistantId, content: acc })}\n\n`);
  } catch (e) {
    try {
      res.write(`event:error\ndata:${JSON.stringify({ message: (e as Error).message })}\n\n`);
    } catch { /* 客户端已断开 */ }
  } finally {
    try { res.end(); } catch { /* 客户端已断开 */ }
  }
});

// 流式透传（调试/直接调用）
router.post('/completions', async (req: Request, res: Response) => {
  const { messages, providerId, model, temperature, maxTokens } = req.body || {};
  if (!messages || !model) return fail(res, 'INVALID', 'messages 和 model 必填');

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  try {
    const { streamComplete } = await import('../llm.js');
    for await (const chunk of streamComplete({ providerId, model, messages: messages as ChatCompletionMessage[], temperature, maxTokens })) {
      res.write(`data:${JSON.stringify({ delta: chunk })}\n\n`);
    }
    res.write('data:[DONE]\n\n');
  } catch (e) {
    res.write(`data:${JSON.stringify({ error: (e as Error).message })}\n\n`);
  }
  res.end();
});

function detectIntent(message: string): 'write' | 'refine' | 'analyze' | 'chat' | 'daemon_create' | 'daemon_view' {
  // 守护进程意图优先识别（避免被续写/分析误匹配）
  // 创建/派发任务 → 跳生成向导
  // 注意：必须用非捕获分组 (?:动词).*(?:关键词) 绑定整体，避免 | 把动词拆成独立分支误判
  if (/(?:添加|新建|创建|开始|派发|启动).*(?:守护进程|后台|daemon)|(?:守护进程|daemon).*(?:添加|新建|创建|开始|启动)/.test(message)) return 'daemon_create';
  if (/(?:查看|进入|打开|看看).*(?:守护|daemon|后台|任务)|守护进程(?:状态|列表|面板|页面)/.test(message)) return 'daemon_view';
  if (/守护进程|后台任务|daemon/i.test(message)) return 'daemon_view';
  if (/精修|去.?ai|润色|改写|优化文笔/.test(message)) return 'refine';
  if (/续写|接着写|写一章|生成正文|开写|落笔/.test(message)) return 'write';
  if (/拆文|分析|拆解/.test(message)) return 'analyze';
  return 'chat';
}

function buildSkillParams(intent: string, projectId: string, message: string, model: string, providerId?: string, webSearch?: boolean, history?: ChatCompletionMessage[], chapterId?: string) {
  const skill = (intent === 'chat' ? 'chat' : intent === 'refine' ? 'refine' : intent === 'analyze' ? 'analyze' : 'write') as 'chat' | 'refine' | 'analyze' | 'write';
  // 续写/精修场景：从章节记录取大纲注入 chapterContext，让 LLM 拿到本章定位与目标
  let chapterContext: string | undefined;
  if ((intent === 'write' || intent === 'refine') && chapterId) {
    const ch = chapterRepo.get(chapterId);
    if (ch?.outline) chapterContext = ch.outline;
  }
  return { projectId, skill, model, providerId, userPrompt: message, maxTokens: 2500, webSearch, history, chapterContext };
}

export default router;
