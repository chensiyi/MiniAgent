import { GM_addStyle } from '$';
import { withHooks } from '../core/withHooks';
import { executor } from '../core/executor';
import { renderMarkdown } from './markdown';

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

// 气泡区（玻璃在每条气泡上）+ 输入行（输入框 + 发送/停止/工具开关）
const STYLE = `
#miniagent-root{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;display:flex;flex-direction:column;gap:8px;font:14px system-ui;color:#1a1c22}
.ma-bubbles{display:flex;flex-direction:column;max-height:100vh;overflow-y:auto;gap:6px}
.ma-bubble{padding:8px 12px;max-width:300px;white-space:pre-wrap;word-break:break-word;border-radius:12px;border:1px solid rgba(255,255,255,.6);background:rgba(255,255,255,.5);backdrop-filter:blur(10px)}
.ma-bubble.assistant{background:rgba(214,234,255,.55)}
.ma-bubble.tool{font-size:12px;background:rgba(255,243,224,.65)}
.ma-input-row{display:flex;gap:6px;align-items:center}
.ma-input{flex:1;min-width:0;padding:8px 10px;border:1px solid rgba(0,0,0,.15);border-radius:8px;outline:0;background:rgba(255,255,255,.7);backdrop-filter:blur(10px)}
.ma-input-row button{padding:8px 14px;border:0;border-radius:8px;background:#1677ff;color:#fff;cursor:pointer;white-space:nowrap}
.ma-input-row button.stop{background:#ff4d4f}
.ma-code{max-height:160px;overflow:auto;margin:6px 0;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.06);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all}
.ma-approve{display:flex;gap:8px;margin-top:4px}
.ma-approve button{flex:1;border:0;border-radius:8px;padding:5px 0;font-size:12px;cursor:pointer}
.ma-approve .ok{background:#1677ff;color:#fff}
.ma-approve .no{background:rgba(0,0,0,.08);color:#444}
.ma-risk{color:#ff4d4f;font-weight:600}
.ma-tools{padding:8px 10px;border:0;border-radius:8px;background:rgba(255,255,255,.7);backdrop-filter:blur(10px);cursor:pointer}
.ma-tools-panel{padding:8px;border:1px solid rgba(255,255,255,.6);border-radius:10px;background:rgba(255,255,255,.5);backdrop-filter:blur(10px);display:flex;flex-direction:column;gap:4px;max-height:40vh;overflow:auto}
.ma-tool-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.ma-tool-name{word-break:break-all}
.ma-think{margin:0 0 6px;border-left:3px solid #1677ff;border-radius:0 6px 6px 0;overflow:hidden}
.ma-think summary{cursor:pointer;padding:4px 8px;font-size:12px;color:#555;background:rgba(22,119,255,.08);user-select:none}
.ma-think summary:hover{background:rgba(22,119,255,.14)}
.ma-think-body{padding:6px 8px;font-size:12px;color:#444;max-height:300px;overflow:auto;white-space:pre-wrap}
.ma-md-content{white-space:normal}
.ma-md-content p{margin:4px 0}
.ma-md-content h1,.ma-md-content h2,.ma-md-content h3{margin:8px 0 4px;line-height:1.3}
.ma-md-content ul,.ma-md-content ol{margin:4px 0;padding-left:20px}
.ma-md-content blockquote{margin:4px 0;padding:2px 8px;border-left:3px solid rgba(0,0,0,.15);color:#666}
.ma-md-content pre.ma-md-pre{max-height:200px;overflow:auto;margin:6px 0;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.06);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all}
.ma-md-content code{padding:1px 4px;border-radius:3px;background:rgba(0,0,0,.06);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.ma-md-content a{color:#1677ff}
`;

// 工具启停面板：读 executor.allToolStates()，每行开关调 setEnabled（即时生效+持久化，§3）
function renderToolsPanel(panel: HTMLElement): void {
  panel.replaceChildren();
  for (const s of executor.allToolStates()) {
    const row = document.createElement('label'); row.className = 'ma-tool-row';
    const name = document.createElement('span'); name.className = 'ma-tool-name';
    name.textContent = s.author && s.author !== 'core' ? `${s.name} @${s.author}` : s.name;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.enabled;
    cb.onchange = () => executor.setEnabled(s.name, cb.checked);
    row.append(name, cb); panel.append(row);
  }
}

let root: HTMLElement, bubbles: HTMLElement, input: HTMLInputElement, sendBtn: HTMLButtonElement, stopBtn: HTMLButtonElement;
let lastAssistantEl: HTMLElement | null = null, lastToolEl: HTMLElement | null = null;

export const ui = {
  chat: {
    // 气泡区 + 输入行 两段式结构（无 header / 无卡片，玻璃落在 .ma-bubble 上）
    mount(onSend: (text: string) => void): void {
      if (document.getElementById('miniagent-root')) return;
      GM_addStyle(STYLE);
      root = document.createElement('div'); root.id = 'miniagent-root';
      setHTML(root, `
        <div class="ma-bubbles"></div>
        <div class="ma-input-row">
          <input class="ma-input" type="text" placeholder="问点什么…（Enter 发送）" />
          <button class="ma-send" type="button">发送</button>
          <button class="ma-stop" type="button" style="display:none">停止</button>
          <button class="ma-tools" type="button" title="工具开关">⚙</button>
        </div>
        <div class="ma-tools-panel" style="display:none"></div>`);
      document.body.append(root);

      bubbles = root.querySelector('.ma-bubbles') as HTMLElement;
      input = root.querySelector('.ma-input') as HTMLInputElement;
      sendBtn = root.querySelector('.ma-send') as HTMLButtonElement;
      stopBtn = root.querySelector('.ma-stop') as HTMLButtonElement;
      const toolsBtn = root.querySelector('.ma-tools') as HTMLButtonElement;
      const toolsPanel = root.querySelector('.ma-tools-panel') as HTMLElement;
      toolsBtn.onclick = () => {
        if (toolsPanel.style.display === 'none') { renderToolsPanel(toolsPanel); toolsPanel.style.display = ''; }
        else toolsPanel.style.display = 'none';
      };
      const doSend = (): void => {
        const text = input.value.trim(); if (!text) return;
        input.value = ''; onSend(text);
      };
      sendBtn.onclick = doSend;
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSend(); } };
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
    // 流结束：assistant 正文 + think 正文做 markdown 渲染（一次性，避免流式频繁 setHTML）
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
