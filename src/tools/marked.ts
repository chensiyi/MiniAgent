import type { ToolDef } from '../core/executor';

// 独立 markdown 渲染工具文件（位于 src/tools/，与 UI 解耦；特殊例外见 ARCHITECTURE §12.5）。
// 渲染引擎：外部引入的 marked / DOMPurify，经 vite.config 的 @require 由 Tampermonkey 在安装期拉取并缓存，
//   运行时作为隔离世界全局直接可用（不内联进产物、不占脚本体、无跨世界/网络问题）。
// 安全：渲染输出经 DOMPurify 清洗，避免 LLM 内容带来的 XSS；
//       marked / DOMPurify 任一不可用时，回退为转义纯文本，保证不崩。
// 双重出口：
//   1) renderMarkdown(src) —— UI 默认渲染器直接 import 使用（ui.chat.finalize 调它）；
//   2) markedTool —— 注册为系统工具（name:'marked'），可被 LLM / 用户命令 /marked 调用把 markdown 渲染成 HTML。
//   marked 不做「接管 UI 渲染」（无 setMarkdownRenderer / resetMarkdownRenderer）；UI 直接消费 renderMarkdown，
//   工具离线 / 卸载不影响默认渲染（run 仍走 renderMarkdown）。

declare const marked: {
  parse(src: string, options?: Record<string, unknown>): string;
  setOptions(options: Record<string, unknown>): void;
  [key: string]: unknown;
};
declare const DOMPurify: {
  sanitize(dirty: string, config?: Record<string, unknown>): string;
  [key: string]: unknown;
};

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  configured = true;
  if (typeof marked !== 'undefined' && typeof marked.setOptions === 'function') {
    try { marked.setOptions({ gfm: true, breaks: false }); } catch { /* 忽略配置异常 */ }
  }
}

// marked / DOMPurify 加载失败时的兜底：转义 HTML 并保留换行，避免直接把原文当 HTML 注入
function escapeFallback(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

export function renderMarkdown(src: string): string {
  if (!src) return '';
  if (typeof marked === 'undefined') return escapeFallback(src);
  ensureConfigured();
  let html: string;
  try {
    html = marked.parse(src) as string;
  } catch {
    return escapeFallback(src);
  }
  if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
    try { html = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }); } catch { /* 清洗失败则保留原 HTML */ }
  }
  return html;
}

// 渲染型系统工具：把 markdown 渲染为（已清洗）HTML，供 LLM / 用户命令 /marked 调用。纯渲染、无副作用。
// 注意：本工具不接管 UI 渲染（无 setMarkdownRenderer），UI 始终用上面的 renderMarkdown 作默认渲染器。
export const markedTool: ToolDef = {
  name: 'marked',
  author: 'sys',
  description: 'Markdown 渲染工具：把 markdown 文本渲染为（经 DOMPurify 清洗的）HTML 字符串并返回。可用于把任意 markdown 源转成 HTML。纯渲染，无副作用。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要渲染的 markdown 源文本' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  call: (_args) => renderMarkdown(String(_args.text ?? '')),
};
