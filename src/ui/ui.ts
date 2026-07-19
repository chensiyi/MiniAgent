import { GM_addStyle } from '$';
import { withHooks } from '../core/withHooks';

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
`;

let root: HTMLElement;
let bubbles: HTMLElement;
let input: HTMLInputElement;
let sendBtn: HTMLButtonElement;
let stopBtn: HTMLButtonElement;
let lastAssistantEl: HTMLElement | null = null;

export const ui = {
  // chat：纯渲染方法（普通函数，不可 hook 逻辑）
  chat: {
    // —— 气泡区 + 输入行 两段式结构（无 header / 无卡片） ——
    mount(onSend: (text: string) => void): void {
      if (document.getElementById('miniagent-root')) return;
      GM_addStyle(STYLE);

      root = document.createElement('div');
      root.id = 'miniagent-root';
      root.innerHTML = `
        <div class="ma-bubbles"></div>
        <div class="ma-input-row">
          <input class="ma-input" type="text" placeholder="问点什么…（Enter 发送）" />
          <button class="ma-send" type="button">发送</button>
          <button class="ma-stop" type="button" style="display:none">停止</button>
        </div>
      `;
      document.body.appendChild(root);

      bubbles = root.querySelector('.ma-bubbles') as HTMLElement;
      input = root.querySelector('.ma-input') as HTMLInputElement;
      sendBtn = root.querySelector('.ma-send') as HTMLButtonElement;
      stopBtn = root.querySelector('.ma-stop') as HTMLButtonElement;

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
    },

    // 流式逐字更新最近一条 assistant 气泡
    updateLast(role: string, text: string): void {
      if (role === 'assistant' && lastAssistantEl) {
        lastAssistantEl.textContent = text;
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
  requestApproval: withHooks(async (call: { name: string; code: string }): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const el = document.createElement('div');
      el.className = 'ma-bubble tool';
      el.innerHTML = `
        <div>LLM 请求运行代码（${call.name}），是否允许？</div>
        <pre class="ma-code"></pre>
        <div class="ma-approve">
          <button class="ok" type="button">允许</button>
          <button class="no" type="button">拒绝</button>
        </div>
      `;
      (el.querySelector('.ma-code') as HTMLElement).textContent = call.code;
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
