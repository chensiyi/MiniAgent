// 独立 markdown 渲染工具（位于根目录 tools/，与 UI 解耦）
// 渲染引擎：外部引入的 marked（用户用 tool_manager register 的 /libs 在安装期内联 marked+DOMPurify，
//   自此工具自包含、离线可用；参数名 raw）。
// 安全：渲染输出经内联 DOMPurify 清洗，避免 LLM 内容带来的 XSS；
//       marked / DOMPurify 任一不可用时，回退为转义纯文本，保证不崩。
// 自动渲染接入点：marked 工具 register 时经 ctx.agent.extensions.get('ui').setMarkdownRenderer 接管 UI 渲染
//   （UI 作为可插拔组件注册在 agent.extensions 通用能力表的 'ui' 键），把助手正文 / think 正文自动渲染为 HTML；
//   unregister 时经 resetMarkdownRenderer 还原默认渲染器。核心不硬引用 UI——若 UI 未挂载（headless），
//   register 静默跳过，不影响工具自身。
//   （默认渲染器仍由本模块的 renderMarkdown 提供，依赖全局 marked，由 agent.ts 的 ensureExternalLibs 兜底。）

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
