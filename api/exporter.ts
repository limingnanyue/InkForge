/**
 * 导出器：将项目章节导出为 TXT / Markdown / HTML 电子书
 */
import fs from 'fs';
import path from 'path';
import { projectRepo, chapterRepo, exportRepo } from './repos.js';
import { EXPORT_DIR } from './db.js';
import type { ExportFormat } from '@shared/types';

export function exportProject(req: { projectId: string; format: ExportFormat; chapterRange?: string }): { filePath: string; fileName: string } {
  const project = projectRepo.get(req.projectId);
  if (!project) throw new Error('项目不存在');
  let chapters = chapterRepo.listByProject(req.projectId).filter(c => c.content);

  // 章节范围过滤（支持 "1-5" "3" "1,3,5"）
  if (req.chapterRange) {
    chapters = filterChapters(chapters, req.chapterRange);
  }

  // P1 修复(BUG1): 名实不符 —— 原代码 epub/docx 都映射成 'html' 扩展名 + toHtml 内容,
  //   用户导出 EPUB 后阅读器无法识别(实际是 HTML 文件)。短期不引入 epub-gen/docx 重依赖,
  //   改为诚实标注:
  //   - epub → 扩展名 .html(网页版),format 字段存 'html'(诚实),UI 标注"网页版HTML"
  //   - docx → 扩展名 .doc(Word 可打开的 HTML),format 字段存 'docx',UI 标注"Word兼容"
  //   不再让用户误以为拿到的是真正的 .epub 实际却是 HTML。
  const ext = req.format === 'markdown' ? 'md'
    : (req.format === 'epub' || req.format === 'html') ? 'html'
    : req.format === 'docx' ? 'doc'
    : 'txt';
  const fileName = `${sanitize(project.title)}_${Date.now()}.${ext}`;
  const filePath = path.join(EXPORT_DIR, fileName);

  let content: string;
  switch (req.format) {
    case 'markdown': content = toMarkdown(project, chapters); break;
    case 'html':
    case 'epub':
    case 'docx':
      content = toHtml(project, chapters); break;
    case 'txt':
    default: content = toTxt(project, chapters); break;
  }

  // 诚实标注实际产出的格式: epub 请求 → 记录为 'html'(实际就是网页版 HTML)
  const storedFormat: ExportFormat = req.format === 'epub' ? 'html' : req.format;

  // 第二十二轮修复(M后端): writeFileSync 失败时清理磁盘残留文件
  //   原 bug: writeFileSync 不在 try/catch/finally 中,磁盘满/权限/路径过长时:
  //   - 部分写入场景会残留半截文件
  //   - exportRepo.create 不会执行(DB 一致),但磁盘累积残留
  //   现: 失败时主动 unlink 已部分写入的文件,避免 EXPORT_DIR 累积垃圾
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    exportRepo.create({ projectId: req.projectId, format: storedFormat, chapterRange: req.chapterRange || '', filePath });
  } catch (e) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* 忽略二次清理失败 */ }
    throw e;
  }
  return { filePath, fileName };
}

function filterChapters(chapters: any[], range: string): any[] {
  const total = chapters.length;
  // M8 修复：严格校验 range 格式，防 NaN/负数/反转导致 slice 越界返回空数组或越界文件
  // 支持三种格式（1-based）："1-5"（区间）、"1,3,5"（枚举）、"3"（单值）
  if (range.includes('-')) {
    const parts = range.split('-');
    if (parts.length !== 2) throw new Error(`章节范围格式错误：${range}（应为 起-终，如 1-5）`);
    const s = parseInt(parts[0].trim(), 10);
    const e = parseInt(parts[1].trim(), 10);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 1 || e < 1) {
      throw new Error(`章节范围格式错误：${range}（起/终须为正整数）`);
    }
    if (s > e) throw new Error(`章节范围格式错误：${range}（起始章 ${s} 大于终止章 ${e}）`);
    if (s > total) throw new Error(`起始章 ${s} 超出总章数 ${total}`);
    return chapters.slice(s - 1, Math.min(e, total));
  }
  if (range.includes(',')) {
    const idx = range.split(',').map(n => parseInt(n.trim(), 10));
    if (idx.some(n => !Number.isFinite(n) || n < 1)) {
      throw new Error(`章节范围格式错误：${range}（每项须为正整数）`);
    }
    const maxIdx = Math.max(...idx);
    if (maxIdx > total) throw new Error(`章节 ${maxIdx} 超出总章数 ${total}`);
    return chapters.filter((_, i) => idx.includes(i + 1));
  }
  const i = parseInt(range, 10);
  if (!Number.isFinite(i) || i < 1) throw new Error(`章节范围格式错误：${range}（须为正整数）`);
  if (i > total) throw new Error(`章节 ${i} 超出总章数 ${total}`);
  return chapters.slice(i - 1, i);
}

function toTxt(project: any, chapters: any[]): string {
  const lines: string[] = [project.title, '='.repeat(40), ''];
  if (project.summary) lines.push(project.summary, '');
  for (const ch of chapters) {
    lines.push(ch.title, '-'.repeat(30), ch.content, '');
  }
  return lines.join('\n');
}

function toMarkdown(project: any, chapters: any[]): string {
  const lines: string[] = [`# ${project.title}`, ''];
  if (project.summary) lines.push(`> ${project.summary}`, '');
  lines.push(`*共 ${chapters.length} 章 · 约 ${project.currentWords} 字*`, '', '---', '');
  for (const ch of chapters) {
    lines.push(`## ${ch.title}`, '', ch.content, '', '---', '');
  }
  return lines.join('\n');
}

function toHtml(project: any, chapters: any[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
  const body = chapters.map(ch => `<section class="chapter"><h2>${esc(ch.title)}</h2><div class="content">${esc(ch.content)}</div></section>`).join('\n');
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(project.title)}</title>
<style>
  :root{--ink:#0E0B08;--paper:#F5E6C8;--amber:#D4A534;--amber-deep:#8B6914;}
  *{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--paper);font-family:"Noto Serif SC",Georgia,serif;line-height:1.9;max-width:760px;margin:0 auto;padding:48px 24px}
  h1{font-family:"Fraunces",serif;font-weight:300;font-size:2.6rem;letter-spacing:.02em;color:var(--amber);border-bottom:1px solid var(--amber-deep);padding-bottom:.4em;margin:0 0 .3em}
  .meta{color:#a89060;font-size:.9rem;font-family:"Manrope",sans-serif;margin-bottom:2rem}
  section.chapter{margin:2.5rem 0;padding:1.5rem 0;border-top:1px solid #2a2118}
  h2{font-family:"Fraunces",serif;font-weight:500;color:var(--amber);font-size:1.5rem}
  .content{text-indent:2em;margin-top:1rem;letter-spacing:.02em}
  a{color:var(--amber)}
</style></head>
<body>
<h1>${esc(project.title)}</h1>
<div class="meta">共 ${chapters.length} 章 · 约 ${project.currentWords} 字 · InkForge 墨铸</div>
${project.summary ? `<p class="meta">${esc(project.summary)}</p>` : ''}
${body}
</body></html>`;
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
}
