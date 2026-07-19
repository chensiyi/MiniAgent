import { GM_addStyle } from '$';
import { withHooks } from '../core/withHooks';
import { executor } from '../core/executor';

// Trusted Types 兼容：部分页面 / 用户脚本框架对文档启用 require-trusted-types-for 'script'，
// 给 innerHTML 赋值必须是 TrustedHTML 对象，否则整段被浏览器拦截（脚本 mount 即崩）。
// 建一个一次性策略包装 HTML；若环境无 trustedTypes 或建策略失败，回退直接赋值。
const _tt = (globalThis as unknown as { trustedTypes?: {
  createPolicy: (name: string, rule: { createHTML: (s: string) => string }) => { createHTML: (s: string) => unknown };
} }).trustedTypes;
let _htmlPolicy: { createHTML: (s: string) => unknown } | null = null;
if (_tt?.createPolicy) {
  const g = globalThis as unknown as { __maHtmlPolicy?: { createHTML: (s: string) => unknown } | null };
  if (!g.__maHtmlPolicy) {
    try {
      g.__maHtmlPolicy = _tt.createPolicy('miniagent', { createHTML: (s: string) => s });
    } catch {
      g.__maHtmlPolicy = null;
    }
  }
  _htmlPolicy = g.__maHtmlPolicy ?? null;
}
function setHTML(el: Element, html: string): void {
  if (_htmlPolicy) {
    (el as unknown as { innerHTML: string }).innerHTML = _htmlPolicy.createHTML(html) as unknown as string;
  } else {
    el.innerHTML = html;
  }
}

// 极简结构：① 气泡区（玻璃在每条气泡上）② 输入行（输入框 + 发送/停止）。
// 无标题栏、无卡片背景板；玻璃效果直接落在 .ma-bubble 上。
const STYLE = `
/* —— 容器：仅定位 + 间距，无背景板 —— */
#miniagent-root{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;display:flex;flex-direction:column;gap:8px;font:14px system-ui;color:#1a1c22}
/* —— 气泡区：仅布局，玻璃在每条气泡上 —— */
.ma-bubbles{display:flex;flex-direction:column;max-height:50vh;overflow-y:auto;gap:6px}
.ma-bubble{padding:8px 12px;max-width:300px;white-space:pre-wrap;word-break:break-word;border-radius:12px;border:1px solid rgba(255,255,255,.6);background:rgba(255,255,255,.5);backdrop-filter:blur(10px)}
.ma-bubble.assistant{background:rgba(214,234,255,.55)}
.ma-bubble.tool{font-size:12px;background:rgba(255,243,224,.65)}
/* —— 输入行：原生输入框 + 发送/停止，无背景板 —— */
.ma-input-row{display:flex;gap:6px;align-items:center}
.ma-input{flex:1;min-width:0;padding:8px 10px;border:1px solid rgba(0,0,0,.15);border-radius:8px;outline:0;background:rgba(255,255,255,.7);backdrop-filter:blur(10px)}
.ma-input-row button{padding:8px 14px;border:0;border-radius:8px;background:#1677ff;color:#fff;cursor:pointer;white-space:nowrap}
.ma-input-row button.stop{background:#ff4d4f}
/* —— 确认气泡与代码块（沿用气泡玻璃） —— */
.ma-code{max-height:160px;overflow:auto;margin:6px 0;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.06);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all}
.ma-approve{display:flex;gap:8px;margin-top:4px}
.ma-approve button{flex:1;border:0;border-radius:8px;padding:5px 0;font-size:12px;cursor:pointer}
.ma-approve .ok{background:#1677ff;color:#fff}
.ma-approve .no{background:rgba(0,0,0,.08);color:#444}
.ma-risk{color:#ff4d4f;font-weight:600}
/* —— 工具启停面板（文档 §3 三视图/启停） —— */
.ma-tools{padding:8px 10px;border:0;border-radius:8px;background:rgba(255,255,255,.7);backdrop-filter:blur(10px);cursor:pointer}
.ma-tools-panel{padding:8px;border:1px solid rgba(255,255,255,.6);border-radius:10px;background:rgba(255,255,255,.5);backdrop-filter:blur(10px);display:flex;flex-direction:column;gap:4px;max-height:40vh;overflow:auto}
.ma-tool-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.ma-tool-name{word-break:break-all}
`;

// 工具启停面板渲染：读 executor.allToolStates()，每行开关调 executor.setEnabled（即时生效 + 持久化，对齐文档 §3）
function renderToolsPanel(panel: HTMLElement): void {
  setHTML(panel, '');
  for (const s of executor.allToolStates()) {
    const row = document.createElement('label');
    row.className = 'ma-tool-row';
    const name = document.createElement('span');
    name.className = 'ma-tool-name';
    name.textContent = s.author && s.author !== 'core' ? `${s.name} @${s.author}` : s.name;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.addEventListener('change', () => executor.setEnabled(s.name, cb.checked));
    row.appendChild(name);
    row.appendChild(cb);
    panel.appendChild(row);
  }
}

let root: HTMLElement;
let bubbles: HTMLElement;
let input: HTMLInputElement;
let sendBtn: HTMLButtonElement;
let stopBtn: HTMLButtonElement;
let lastAssistantEl: HTMLElement | null = null;
let lastToolEl: HTMLElement | null = null;

export const ui = {
  // chat：纯渲染方法（普通函数，不可 hook 逻辑）
  chat: {
    // —— 气泡区 + 输入行 两段式结构（无 header / 无卡片） ——
    mount(onSend: (text: string) => void): void {
      if (document.getElementById('miniagent-root')) return;
      GM_addStyle(STYLE);

      root = document.createElement('div');
      root.id = 'miniagent-root';
      setHTML(root, `
        <div class="ma-bubbles"></div>
        <div class="ma-input-row">
          <input class="ma-input" type="text" placeholder="问点什么…（Enter 发送）" />
          <button class="ma-send" type="button">发送</button>
          <button class="ma-stop" type="button" style="display:none">停止</button>
          <button class="ma-tools" type="button" title="工具开关">⚙</button>
        </div>
        <div class="ma-tools-panel" style="display:none"></div>
      `);
      document.body.appendChild(root);

      bubbles = root.querySelector('.ma-bubbles') as HTMLElement;
      input = root.querySelector('.ma-input') as HTMLInputElement;
      sendBtn = root.querySelector('.ma-send') as HTMLButtonElement;
      stopBtn = root.querySelector('.ma-stop') as HTMLButtonElement;
      const toolsBtn = root.querySelector('.ma-tools') as HTMLButtonElement;
      const toolsPanel = root.querySelector('.ma-tools-panel') as HTMLElement;
      toolsBtn.addEventListener('click', () => {
        if (toolsPanel.style.display === 'none') {
          renderToolsPanel(toolsPanel);
          toolsPanel.style.display = '';
        } else {
          toolsPanel.style.display = 'none';
        }
      });

      const doSend = (): void => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        onSend(text);
      };
      sendBtn.addEventListener('click', doSend);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSend();
        }
      });
    },

    append(role: string, text: string): void {
      const el = document.createElement('div');
      el.className = `ma-bubble ${role}`;
      el.textContent = text;
      bubbles.appendChild(el);
      bubbles.scrollTop = bubbles.scrollHeight;
      if (role === 'assistant') lastAssistantEl = el;
      else if (role === 'tool') lastToolEl = el;
    },

    // 流式更新最近一条气泡：assistant 逐字 / tool 执行结果替换（进度气泡 → 结果）
    updateLast(role: string, text: string): void {
      const el = role === 'tool' ? lastToolEl : role === 'assistant' ? lastAssistantEl : null;
      if (el) {
        el.textContent = text;
        bubbles.scrollTop = bubbles.scrollHeight;
      }
    },

    // 运行态：running 时把输入行的"发送"变身"停止"（绑 onStop=agent.chatStop）并禁用输入
    setRunning(running: boolean, onStop?: () => void): void {
      sendBtn.style.display = running ? 'none' : '';
      stopBtn.style.display = running ? '' : 'none';
      input.disabled = running;
      if (running && onStop) stopBtn.onclick = onStop;
    },
  },

  // 人工确认闸：withHooks 异步闸门（base 弹原生确认气泡，true=允许）。
  // auto-allow/拦截留作权限系统 hook 点（TODO，ctx 未进运行时）；当前 base 始终弹窗。
  requestApproval: withHooks(async (call: { name: string; code?: string; riskLevel?: string }): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const el = document.createElement('div');
      el.className = 'ma-bubble tool';
      const risk = call.riskLevel ? ` <span class="ma-risk">[${call.riskLevel}]</span>` : '';
      setHTML(el, `
        <div>工具请求执行（${call.name}）${risk}，是否允许？</div>
        ${call.code ? '<pre class="ma-code"></pre>' : ''}
        <div class="ma-approve">
          <button class="ok" type="button">允许</button>
          <button class="no" type="button">拒绝</button>
        </div>
      `);
      if (call.code) (el.querySelector('.ma-code') as HTMLElement).textContent = call.code;
      const finish = (ok: boolean): void => {
        el.remove();
        resolve(ok);
      };
      (el.querySelector('.ok') as HTMLButtonElement).addEventListener('click', () => finish(true));
      (el.querySelector('.no') as HTMLButtonElement).addEventListener('click', () => finish(false));
      bubbles.appendChild(el);
      bubbles.scrollTop = bubbles.scrollHeight;
    });
  }),
};
