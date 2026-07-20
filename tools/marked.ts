// 独立 markdown 渲染工具（位于根目录 tools/，与 UI 解耦）
// 渲染引擎：外部引入的 marked（核心聊天渲染由 agent.ts 的 ensureExternalLibs 在启动期从
//   jsDelivr 拉取为全局变量 marked；用户自建工具可用 tool_manager register 的 /libs 在安装期内联 marked）。
// 安全：渲染输出经外部 DOMPurify 清洗，避免 LLM 内容带来的 XSS；
//       marked / DOMPurify 任一不可用时，回退为转义纯文本，保证不崩。
// 接入点：ui.ts 的 finalizeLast 调用 renderMarkdown，把助手正文 / think 正文渲染为 HTML。

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
