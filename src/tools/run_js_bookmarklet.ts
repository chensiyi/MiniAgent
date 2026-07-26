/// <reference path="../basement.d.ts" />

// run_js 越狱包装（bookmarklet 分支专用）。
// 背景：bookmarklet 的 agent / 存储都在 github.io 的 iframe 沙箱内运行，basement 原 run_js 仅能访问
// iframe 自身的 document/window，碰不到【原网页】。本包装让 run_js 默认在【父页面】上下文执行，
// 从而可以操作原网页 DOM / window / location / fetch，并把结果经 postMessage 回传 iframe。
//
// 安全：run_js 本身 riskLevel:'high'，executor.run 在调用前会走 requestApproval 审批闸
// （见 executor.ts 的 call.name === 'run_js'）；父页面桥只响应来自本 iframe 的消息，边界与原工具一致。
export const runJsTool: ToolDef = {
  name: 'run_js',
  author: 'sys',
  riskLevel: 'high',
  description:
    '执行 JS 代码。危险操作，执行前会请求用户确认。\n' +
    'target 参数：page（默认）= 在【原网页】上下文中执行，可操作原网页的 window/document/location/fetch，' +
    '代码体内通过参数 ctx 访问 {window, document, location, fetch}（需打印请直接用原生 console，走原网页 DevTools）；' +
    'iframe = 回退到 MiniAgent 自身沙箱执行，ctx 提供 {storage, executor, agent, console}（与旧版一致）。\n' +
    'return 的值将作为执行结果回显。',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          "要执行的 JS 源码。page 模式下以 new Function('ctx', ...) 在【原网页】运行：ctx.document/ctx.window 即当前页面；return 的值将作为执行结果回显。",
      },
      target: {
        type: 'string',
        description:
          "执行上下文：page=原网页（默认，可越狱操作当前页面）；iframe=MiniAgent 沙箱（本地，可访问 storage/executor/agent）。",
      },
    },
    required: ['code'],
  },
  call: (args, ctx) => runJs(args, ctx),
};

// ---- 父页面执行结果回传协议（透传返回值，不捕获 console）----
interface RunResult {
  ok: boolean;
  result?: string;
  error?: string;
}

const pending = new Map<string, (d: RunResult) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    const d = (e.data || {}) as Record<string, unknown>;
    if (d.type !== 'ma:runjs:result') return;
    const id = d.id as string | undefined;
    console.log('[MA runjs] <- parent', { id, ok: d.ok, hasResult: d.result !== undefined, hasError: d.error !== undefined });
    if (!id) return;
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(d as unknown as RunResult);
    }
  });
}

// 把代码发到父页面执行，等待 ma:runjs:result 回传。
function runInParent(code: string, timeoutMs = 10000): Promise<RunResult> {
  return new Promise((resolve) => {
    const id = 'r' + Math.random().toString(36).slice(2);
    pending.set(id, resolve);
    console.log('[MA runjs] -> parent', { id, codePreview: code.slice(0, 120) });
    window.parent.postMessage({ type: 'ma:runjs', id, code }, '*');

    // 父页面桥无响应保护：避免旧 bookmarklet / CSP 阻止桥注入时永远挂起。
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      console.warn('[MA runjs] timeout waiting for parent bridge', { id });
      resolve({ ok: false, error: '父页面未在 10 秒内响应 run_js 桥。可能原因：① 书签是旧版，未注入 ma-bridge，请重新复制 dist/bookmarklet.url.txt 创建新书签；② 父页面 CSP 阻止了脚本注入；③ 桥执行代码时抛异常但未被捕获。' });
    }, timeoutMs);
  });
}

// 本地（iframe 沙箱）执行：与 basement 原 run_js 行为一致。
function runLocal(code: string, ctx: RunCtx): string {
  try {
    const fn = new Function('ctx', '"use strict";\n' + code);
    const result = fn(ctx);
    return `执行成功 → ${result === undefined ? '(无返回值)' : safeStringify(result)}`;
  } catch (err) {
    return `执行异常: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'object' && v !== null
      ? (v as { outerHTML?: string }).outerHTML || JSON.stringify(v, null, 2)
      : String(v);
  } catch {
    return String(v);
  }
}

async function runJs(args: Record<string, unknown>, ctx: RunCtx): Promise<string> {
  const code = typeof args.code === 'string' ? args.code : '';
  if (!code) return '没有可执行的代码';
  const target = args.target === 'iframe' ? 'iframe' : 'page';
  if (target === 'iframe') return runLocal(code, ctx);
  const d = await runInParent(code);
  if (!d.ok) return `执行异常: ${d.error ?? '(未知错误)'}`;
  // 透传：父页面 return 的值原样回显（已 stringify），无前缀包装。
  return d.result === undefined ? '(无返回值)' : d.result;
}
