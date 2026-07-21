import { GM_addStyle } from '$';
import { withHooks } from '../core/withHooks';
import { executor } from '../core/executor';
import { renderMarkdown } from '../tools/marked';

// @require 注入的外部库，运行期在 userscript 全局作用域可用
declare const DOMPurify: { sanitize(dirty: string, config?: Record<string, unknown>): string; [key: string]: unknown };

// Trusted Types 兼容：require-trusted-types-for 'script' 下 innerHTML 必须是 TrustedHTML。
// 建一次性策略包装 HTML；无 trustedTypes 或建策略失败则回退直接赋值。
const _tt = (globalThis as unknown as { trustedTypes?: { createPolicy: (n: string, r: { createHTML: (s: string) => string }) => { createHTML: (s: string) => unknown } } }).trustedTypes;
let _hp: { createHTML: (s: string) => unknown } | null = null;
if (_tt) {
  const g = globalThis as unknown as { __maHp?: { createHTML: (s: string) => unknown } | null };
  if (!g.__maHp) { try { g.__maHp = _tt.createPolicy('miniagent', { createHTML: (s: string) => s }); } catch { g.__maHp = null; } }
  _hp = g.__maHp ?? null;
}
function setHTML(el: Element, html: string): void { el.innerHTML = _hp ? (_hp.createHTML(html) as unknown as string) : html; }

// UI markdown 渲染：直接用 src/tools/marked.ts 的 renderMarkdown（依赖全局 marked/DOMPurify，
// 二者均由 vite.config 的 @require 编译期注入 userscript 全局作用域，运行期直接消费，无运行时下载）。
// marked 作为独立工具文件常驻 src（见 ARCHITECTURE §12.5），不接管 UI 渲染；UI 始终用此默认渲染器。

// 玻璃方框浮层（对齐 docs/ui-design.html v4）：容器透明无背景板、无圆角、深色玻璃 + 浅色字、顶部遮罩淡出
const STYLE = `
:root{--brand:#378DDD;--brand-soft:rgba(55,141,221,.22);--glass:rgba(18,26,44,.52);--glass-strong:rgba(22,31,52,.66);--glass-border:rgba(255,255,255,.16);--glass-border-strong:rgba(255,255,255,.26);--text:#eef2ff;--text-dim:rgba(238,242,255,.62);--risk-high:#fb923c}
#miniagent-root{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;gap:8px;font:14px system-ui;color:var(--text)}
.ma-bubbles{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:4px 2px;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 10%,#000 100%);mask-image:linear-gradient(to bottom,transparent 0,#000 10%,#000 100%)}
.ma-bubble{padding:6px 9px;max-width:88%;white-space:pre-wrap;word-break:break-word;border:1px solid var(--glass-border);background:var(--glass);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 2px 10px rgba(0,0,0,.18);align-self:flex-start}
.ma-bubble.user{align-self:flex-end;background:var(--brand-soft);border-color:rgba(55,141,221,.5)}
.ma-bubble.tool{align-self:flex-start;font-size:12px;background:rgba(18,26,44,.62)}
.ma-input-row{display:flex;gap:6px;align-items:center;position:relative}
.ma-ac{position:absolute;left:0;right:0;bottom:100%;margin-bottom:4px;background:var(--glass-strong);border:1px solid var(--glass-border);overflow:auto;max-height:210px;box-shadow:0 4px 16px rgba(0,0,0,.3);color:var(--text)}
.ma-ac-item{padding:6px 10px;cursor:pointer;display:flex;flex-direction:column;gap:1px}
.ma-ac-item.active,.ma-ac-item:hover{background:var(--brand-soft)}
.ma-ac-name{font-weight:600;color:#6fb0f0;font-size:12px}
.ma-ac-hint{color:var(--text-dim);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ma-input{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--glass-border);outline:0;background:var(--glass);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);color:var(--text)}
.ma-input::placeholder{color:var(--text-dim)}
.ma-input-row button{padding:8px 14px;border:1px solid rgba(55,141,221,.5);background:rgba(55,141,221,.85);color:#fff;cursor:pointer;white-space:nowrap}
.ma-input-row button.stop{background:rgba(248,113,113,.85);border-color:rgba(248,113,113,.5)}
.ma-code{max-height:160px;overflow:auto;margin:6px 0;padding:6px 8px;background:rgba(0,0,0,.35);color:#cfe0f5;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all}
.ma-approve{display:flex;gap:8px;margin-top:4px}
.ma-approve button{flex:1;border:0;padding:5px 0;font-size:12px;cursor:pointer;color:#fff}
.ma-approve .ok{background:rgba(55,141,221,.9)}
.ma-approve .no{background:rgba(255,255,255,.12);color:var(--text)}
.ma-risk{color:var(--risk-high);font-weight:600}
.ma-tools{padding:8px 10px;border:1px solid var(--glass-border);background:var(--glass);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);cursor:pointer}
.ma-tools-panel{padding:8px;border:1px solid var(--glass-border-strong);background:var(--glass-strong);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);display:flex;flex-direction:column;gap:4px;min-height:120px;max-height:40vh;overflow:auto}
.ma-tool-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.ma-tool-name{word-break:break-all;flex-shrink:0}
.ma-tool-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;color:var(--text-dim);font-size:11px}
.ma-think{margin:0 0 6px;border-left:3px solid var(--brand);overflow:hidden}
.ma-think summary{cursor:pointer;padding:4px 8px;font-size:12px;color:var(--text-dim);background:var(--brand-soft);user-select:none}
.ma-think summary:hover{background:rgba(55,141,221,.14)}
.ma-think-body{padding:6px 8px;font-size:12px;color:var(--text-dim);max-height:300px;overflow:auto;white-space:pre-wrap}
.ma-md-content{color:var(--text);white-space:normal}
.ma-md-content p{margin:4px 0}
.ma-md-content h1,.ma-md-content h2,.ma-md-content h3{margin:8px 0 4px;line-height:1.3}
.ma-md-content ul,.ma-md-content ol{margin:4px 0;padding-left:20px}
.ma-md-content blockquote{margin:4px 0;padding:2px 8px;border-left:3px solid var(--glass-border);color:var(--text-dim)}
.ma-md-content pre{max-height:200px;overflow:auto;margin:6px 0;padding:6px 8px;background:rgba(0,0,0,.3);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all}
.ma-md-content :not(pre) > code{padding:1px 4px;background:rgba(255,255,255,.12);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.ma-md-content img{max-width:100%}
.ma-md-content table{border-collapse:collapse;margin:6px 0;font-size:12px}
.ma-md-content th,.ma-md-content td{border:1px solid var(--glass-border);padding:2px 6px}
.ma-md-content hr{border:0;border-top:1px solid var(--glass-border);margin:8px 0}
.ma-md-content a{color:#6fb0f0}
.ma-toggle{display:block;width:100%;padding:2px 0;margin:0;text-align:center;border:1px solid var(--glass-border);background:var(--glass);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);color:var(--text);cursor:pointer;font-size:11px;line-height:1.3}
.ma-toggle:hover{background:rgba(255,255,255,.16)}
.ma-collapsed .ma-bubbles,.ma-collapsed .ma-input-row,.ma-collapsed .ma-tools-panel{display:none}
`;

// 工具启停面板：读 executor.allToolStates()，每行开关调 setEnabled（即时生效+持久化，§3）
function renderToolsPanel(panel: HTMLElement): void {
  panel.replaceChildren();
  for (const s of executor.allToolStates()) {
    const row = document.createElement('label'); row.className = 'ma-tool-row';
    const name = document.createElement('span'); name.className = 'ma-tool-name';
    name.textContent = s.author && s.author !== 'sys' ? `${s.name} @${s.author}` : s.name;
    const desc = document.createElement('span'); desc.className = 'ma-tool-desc';
    desc.textContent = s.description ?? '';
    desc.title = s.description ?? ''; // 鼠标悬停看全文
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.enabled;
    cb.onchange = async () => {
      const next = cb.checked;
      await executor.setEnabled(s.name, next);
      // 禁用被用户拒绝时 setEnabled 未生效（如关闭界面），复选框还原为实际启用态
      const live = executor.list(true).some((t) => t.name === s.name);
      if (cb.checked !== live) cb.checked = live;
    };
    row.append(name, desc, cb); panel.append(row);
  }
}

let root: HTMLElement, bubbles: HTMLElement, input: HTMLInputElement, sendBtn: HTMLButtonElement, stopBtn: HTMLButtonElement;
let lastAssistantEl: HTMLElement | null = null, lastToolEl: HTMLElement | null = null;
let acEl: HTMLElement | null = null;
let acItems: { text: string; hint: string }[] = [];
let acIndex = -1;
// 供 ui.* 方法在 mount 之后访问的节点与回调引用
let onSendRef: ((text: string) => void) | null = null;
let toolsPanelEl: HTMLElement | null = null;
let toggleBtnEl: HTMLButtonElement | null = null;

// 手动工具命令自动补全：/tool 补工具名，/tool /param 补参数（显示 inputSchema.properties[param].description）
function computeAc(text: string): { text: string; hint: string }[] {
  if (!text.startsWith('/')) return [];
  const lastSpace = text.lastIndexOf(' ');
  const after = text.slice(lastSpace + 1);
  const hasPrefix = lastSpace > 0;
  const propsOf = (name: string): Record<string, { description?: string; type?: string }> =>
    (executor.list(true).find((t) => t.name === name)?.inputSchema?.properties ?? {}) as Record<string, { description?: string; type?: string }>;
  const usedParams = (toolName: string, activeQ: string): Set<string> => {
    const used = new Set<string>(); const re = /\/(\S+)/g; let m: RegExpExecArray | null;
    while ((m = re.exec(text))) { const w = m[1]; if (w === toolName || w === activeQ) continue; used.add(w); }
    return used;
  };
  const paramItems = (toolName: string, q: string): { text: string; hint: string }[] => {
    const props = propsOf(toolName);
    return Object.entries(props)
      .filter(([k]) => !usedParams(toolName, q).has(k) && k.toLowerCase().includes(q))
      .slice(0, 8)
      .map(([k, v]) => ({ text: '/' + k + ' ', hint: (v.description ?? '') + (v.type ? ` (${v.type})` : '') }));
  };
  if (after.startsWith('/')) {
    const q = after.slice(1).toLowerCase();
    if (!hasPrefix) {
      return executor.list(true)
        .filter((t) => t.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((t) => ({ text: '/' + t.name + ' ', hint: t.description }));
    }
    const toolName = text.slice(1, lastSpace).split(/\s+/)[0];
    return paramItems(toolName, q);
  }
  if (after === '' && hasPrefix) {
    const toolName = text.slice(1, lastSpace).split(/\s+/)[0];
    return paramItems(toolName, '');
  }
  return [];
}

function renderAc(): void {
  const el = acEl;
  if (!el) return;
  if (!acItems.length) { el.style.display = 'none'; el.replaceChildren(); return; }
  el.replaceChildren();
  acItems.forEach((it, i) => {
    const item = document.createElement('div'); item.className = 'ma-ac-item' + (i === acIndex ? ' active' : '');
    const name = document.createElement('div'); name.className = 'ma-ac-name'; name.textContent = it.text.trim();
    const hint = document.createElement('div'); hint.className = 'ma-ac-hint'; hint.textContent = it.hint;
    item.append(name, hint);
    item.onmousedown = (e) => { e.preventDefault(); acceptAc(it.text); };
    item.onmouseenter = () => { acIndex = i; renderAc(); };
    el.append(item);
  });
  el.style.display = '';
}

function updateAc(): void {
  if (!acEl || !input) return;
  acItems = computeAc(input.value);
  acIndex = acItems.length ? 0 : -1;
  renderAc();
}

function acceptAc(insert: string): void {
  if (!input) return;
  const text = input.value;
  const lastSpace = text.lastIndexOf(' ');
  const before = lastSpace === -1 ? '' : text.slice(0, lastSpace + 1);
  input.value = before + insert;
  input.focus();
  updateAc();
}

export const ui = {
  chat: {
    // 气泡区 + 输入行 两段式结构（无 header / 无卡片，玻璃落在 .ma-bubble 上）
    mount(onSend: (text: string) => void): void {
      if (document.getElementById('miniagent-root')) return;
      GM_addStyle(STYLE);
      root = document.createElement('div'); root.id = 'miniagent-root';
      setHTML(root, `
        <button class="ma-toggle" type="button" title="折叠/展开面板">▾</button>
        <div class="ma-bubbles"></div>
        <div class="ma-input-row">
          <button class="ma-tools" type="button" title="工具开关">⚙</button>
          <input class="ma-input" type="text" placeholder="问点什么…（Enter 发送）" />
          <button class="ma-send" type="button">发送</button>
          <button class="ma-stop" type="button" style="display:none">停止</button>
        </div>
        <div class="ma-tools-panel" style="display:none"></div>`);
      document.body.append(root);

      bubbles = root.querySelector('.ma-bubbles') as HTMLElement;
      input = root.querySelector('.ma-input') as HTMLInputElement;
      sendBtn = root.querySelector('.ma-send') as HTMLButtonElement;
      stopBtn = root.querySelector('.ma-stop') as HTMLButtonElement;
      const toolsBtn = root.querySelector('.ma-tools') as HTMLButtonElement;
      toolsPanelEl = root.querySelector('.ma-tools-panel') as HTMLElement;
      acEl = document.createElement('div'); acEl.className = 'ma-ac'; acEl.style.display = 'none';
      (root.querySelector('.ma-input-row') as HTMLElement).append(acEl);
      onSendRef = onSend;
      toolsBtn.onclick = () => ui.tools.toggle();
      toggleBtnEl = root.querySelector('.ma-toggle') as HTMLButtonElement;
      toggleBtnEl.onclick = () => ui.panel.toggle();
      const doSend = (): void => {
        const text = input.value.trim(); if (!text) return;
        input.value = ''; if (acEl) acEl.style.display = 'none'; onSendRef?.(text);
      };
      sendBtn.onclick = doSend;
      input.oninput = () => ui.chat.refreshAutocomplete();
      input.onblur = () => { if (acEl) acEl.style.display = 'none'; };
      input.onkeydown = (e) => {
        if (acEl && acEl.style.display !== 'none' && acItems.length) {
          if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; renderAc(); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; renderAc(); return; }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (acIndex >= 0) ui.chat.acceptAutocomplete(acItems[acIndex].text); return; }
          if (e.key === 'Escape') { acEl.style.display = 'none'; return; }
        }
        if (e.key === 'Enter') { e.preventDefault(); doSend(); }
      };
    },

    // 卸载：移除 DOM 并清空节点引用（供 ui 工具 unregister 调用；重挂载由 mount 重新初始化，幂等）。
    unmount(): void {
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null as unknown as HTMLElement;
      bubbles = null as unknown as HTMLElement;
      input = null as unknown as HTMLInputElement;
      sendBtn = null as unknown as HTMLButtonElement;
      stopBtn = null as unknown as HTMLButtonElement;
      lastAssistantEl = null;
      lastToolEl = null;
      acEl = null;
      onSendRef = null;
      toolsPanelEl = null;
      toggleBtnEl = null;
    },

    append(role: string, text: string): void {
      const el = document.createElement('div'); el.className = `ma-bubble ${role}`;
      if (role === 'assistant') {
        // 预建 think 折叠块（隐藏，有 reasoning 时显示）+ 正文容器
        setHTML(el, '<details class="ma-think" style="display:none"><summary>💭 思考过程</summary><div class="ma-think-body"></div></details><div class="ma-md-content"></div>');
        const c = el.querySelector('.ma-md-content') as HTMLElement; if (c) c.textContent = text;
        lastAssistantEl = el;
      } else {
        el.textContent = text;
        if (role === 'tool') lastToolEl = el;
      }
      bubbles.append(el); bubbles.scrollTop = bubbles.scrollHeight;
    },

    // 流式更新最近一条气泡：assistant 逐字文本+思考 / tool 进度→结果（流式用 textContent 快）
    updateLast(role: string, text: string, reasoning?: string): void {
      const el = role === 'tool' ? lastToolEl : role === 'assistant' ? lastAssistantEl : null;
      if (!el) return;
      if (role === 'assistant') {
        const c = el.querySelector('.ma-md-content') as HTMLElement; if (c) c.textContent = text;
        if (reasoning != null) {
          const think = el.querySelector('.ma-think') as HTMLElement;
          if (think) { think.style.display = ''; const tb = el.querySelector('.ma-think-body') as HTMLElement; if (tb) tb.textContent = reasoning; }
        }
      } else { el.textContent = text; }
      bubbles.scrollTop = bubbles.scrollHeight;
    },

    // 把最近一条 tool 气泡渲染为 HTML（经 DOMPurify 清洗）。用于 marked 等返回 HTML 的工具结果。
    setToolHTML(html: string): void {
      if (!lastToolEl) return;
      if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
        setHTML(lastToolEl, DOMPurify.sanitize(html));
      } else {
        lastToolEl.textContent = html; // 清洗库不可用时回退纯文本，避免 XSS
      }
      bubbles.scrollTop = bubbles.scrollHeight;
    },

    // 流结束：assistant 正文 + think 正文做 markdown 渲染（一次性，避免流式频繁 setHTML）。
    // 渲染走默认 renderMarkdown（依赖全局 marked，由 @require 注入；marked 工具不接管 UI 渲染）。
    finalizeLast(role: string, text: string, reasoning?: string): void {
      const el = role === 'assistant' ? lastAssistantEl : null;
      if (!el) return;
      const c = el.querySelector('.ma-md-content') as HTMLElement; if (c) setHTML(c, renderMarkdown(text));
      const think = el.querySelector('.ma-think') as HTMLElement;
      if (think) { if (reasoning) { const tb = el.querySelector('.ma-think-body') as HTMLElement; if (tb) setHTML(tb, renderMarkdown(reasoning)); } else think.remove(); }
    },

    // 运行态：发送变身停止（绑 onStop=agent.chatStop）并禁用输入
    setRunning(running: boolean, onStop?: () => void): void {
      sendBtn.style.display = running ? 'none' : '';
      stopBtn.style.display = running ? '' : 'none';
      input.disabled = running;
      if (running && onStop) stopBtn.onclick = onStop;
    },

    // 触发发送（等同点击「发送」）
    send(): void {
      const text = input?.value.trim(); if (!text || !onSendRef) return;
      if (input) input.value = ''; if (acEl) acEl.style.display = 'none'; onSendRef(text);
    },
    // 设置输入框内容并刷新自动补全
    setInput(text: string): void { if (!input) return; input.value = text; updateAc(); },
    // 依据当前输入框内容刷新手动工具命令自动补全
    refreshAutocomplete(): void { updateAc(); },
    // 接受某个自动补全项（insert 为含尾部空格的插入文本）
    acceptAutocomplete(insert: string): void { acceptAc(insert); },
  },

  // 面板折叠/展开控制（行为抽离，便于外部调用）
  panel: {
    toggle(): void {
      if (!root || !toggleBtnEl) return;
      const collapsed = root.classList.toggle('ma-collapsed');
      toggleBtnEl.textContent = collapsed ? '▴' : '▾';
      if (!collapsed && toolsPanelEl && toolsPanelEl.style.display === '') renderToolsPanel(toolsPanelEl);
    },
    setCollapsed(c: boolean): void {
      if (!root || !toggleBtnEl) return;
      const now = root.classList.contains('ma-collapsed');
      if (now === c) return;
      root.classList.toggle('ma-collapsed', c);
      toggleBtnEl.textContent = c ? '▴' : '▾';
      if (!c && toolsPanelEl && toolsPanelEl.style.display === '') renderToolsPanel(toolsPanelEl);
    },
    isCollapsed(): boolean { return !!root && root.classList.contains('ma-collapsed'); },
  },

  // 工具启停面板控制
  tools: {
    toggle(): void {
      if (!toolsPanelEl) return;
      if (toolsPanelEl.style.display === 'none') { renderToolsPanel(toolsPanelEl); toolsPanelEl.style.display = ''; }
      else toolsPanelEl.style.display = 'none';
    },
    open(): void { if (!toolsPanelEl) return; renderToolsPanel(toolsPanelEl); toolsPanelEl.style.display = ''; },
    close(): void { if (toolsPanelEl) toolsPanelEl.style.display = 'none'; },
    // 面板正打开时刷新开关列表（运行时状态可能已变化）
    refresh(): void { if (toolsPanelEl && toolsPanelEl.style.display !== 'none') renderToolsPanel(toolsPanelEl); },
  },

  // 人工确认闸（withHooks 异步闸门）：base 弹原生确认气泡，true=允许
  requestApproval: withHooks(async (call: { name: string; code?: string; riskLevel?: string }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const el = document.createElement('div'); el.className = 'ma-bubble tool';
      const risk = call.riskLevel ? ` <span class="ma-risk">[${call.riskLevel}]</span>` : '';
      setHTML(el, `
        <div>工具请求执行（${call.name}）${risk}，是否允许？</div>
        ${call.code ? '<pre class="ma-code"></pre>' : ''}
        <div class="ma-approve"><button class="ok" type="button">允许</button><button class="no" type="button">拒绝</button></div>`);
      if (call.code) (el.querySelector('.ma-code') as HTMLElement).textContent = call.code;
      const finish = (ok: boolean): void => { el.remove(); resolve(ok); };
      (el.querySelector('.ok') as HTMLButtonElement).onclick = () => finish(true);
      (el.querySelector('.no') as HTMLButtonElement).onclick = () => finish(false);
      bubbles.append(el); bubbles.scrollTop = bubbles.scrollHeight;
    })),
};

// 迟绑 thisArg：requestApproval 体内 this 指向 ui（局部上下文），避免 TDZ。
(ui.requestApproval as unknown as { __thisArg?: unknown }).__thisArg = ui;
