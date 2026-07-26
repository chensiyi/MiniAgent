/// <reference path="../basement.d.ts" />

// 独立环境（bookmarklet 分支）：样式经原生 <style> 注入 document.head，不再依赖 GM_addStyle 垫片。
// marked / DOMPurify 仍为运行期全局（由宿主页或打包提供），非 GM 专属，故保留原消费方式。

// 外部库（marked / DOMPurify），运行期在 iframe 全局作用域可用
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

// UI markdown 渲染：用全局 marked + DOMPurify 本地渲染（不依赖 basement 暴露的 renderMarkdown 全局，
// marked/DOMPurify 由 host.html <script> 编译期注入 iframe 全局作用域，运行期直接消费，无运行时下载）。
// 这样 basement 契约无需为展示层泄漏 renderMarkdown 全局，框架边界更清晰。
// 本地渲染函数（替代原 MiniAgent.renderMarkdown）：
declare const marked: { parse(src: string, opts?: Record<string, unknown>): string | Promise<string> };
function renderMarkdownLocal(src: string): string {
  const parsed = marked.parse(src);
  const html = typeof parsed === 'string' ? parsed : '';
  return DOMPurify.sanitize(html);
}

// 玻璃方框浮层：容器透明无背景板、无圆角、深色玻璃 + 浅色字、顶部遮罩淡出
const STYLE = `
:root{--brand:#378DDD;--brand-soft:rgba(55,141,221,.22);--glass:rgba(18,26,44,.52);--glass-strong:rgba(22,31,52,.66);--glass-border:rgba(255,255,255,.16);--glass-border-strong:rgba(255,255,255,.26);--text:#eef2ff;--text-dim:rgba(238,242,255,.62);--risk-high:#fb923c}
#miniagent-root{position:relative;z-index:2147483647;width:100%;height:100%;display:flex;flex-direction:column;gap:8px;font:14px system-ui;color:var(--text);pointer-events:auto}
.ma-bubbles{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;justify-content:flex-end;gap:6px;padding:4px 2px;order:1;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 10%,#000 100%);mask-image:linear-gradient(to bottom,transparent 0,#000 10%,#000 100%)}
.ma-bubble{padding:6px 9px;max-width:88%;white-space:pre-wrap;word-break:break-word;border:1px solid var(--glass-border);background:var(--glass);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 2px 10px rgba(0,0,0,.18);align-self:flex-start}
.ma-bubble.user{align-self:flex-end;background:var(--brand-soft);border-color:rgba(55,141,221,.5)}
.ma-bubble.tool{align-self:flex-start;font-size:12px;background:rgba(18,26,44,.62)}
.ma-input-row{display:flex;gap:6px;align-items:center;position:relative;order:3}
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
.ma-tools-panel{padding:8px;border:1px solid var(--glass-border-strong);background:var(--glass-strong);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);display:flex;flex-direction:column;gap:4px;min-height:120px;max-height:240px;overflow:auto;width:100%;box-sizing:border-box;order:4}
.ma-tool-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;width:100%;max-width:100%}
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
.ma-toggle{display:block;width:100%;padding:2px 0;margin:0;text-align:center;border:1px solid var(--glass-border);background:var(--glass);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);color:var(--text);cursor:pointer;font-size:11px;line-height:1.3;order:2}
.ma-toggle:hover{background:rgba(255,255,255,.16)}
.ma-collapsed{justify-content:flex-end}
.ma-collapsed .ma-bubbles,.ma-collapsed .ma-input-row,.ma-collapsed .ma-tools-panel{display:none}
`;

// 工具启停面板：读 toolManager.getStates()（以 preset 宇宙为真相源，含已注册/关闭/用户工具），每行开关调 setEnabled（即时生效+持久化）
function renderToolsPanel(panel: HTMLElement): void {
  panel.replaceChildren();
  for (const s of MiniAgent.toolManager.getStates()) {
    const row = document.createElement('label'); row.className = 'ma-tool-row';
    const name = document.createElement('span'); name.className = 'ma-tool-name';
    name.textContent = s.author && s.author !== 'sys' ? `${s.name} @${s.author}` : s.name;
    const desc = document.createElement('span'); desc.className = 'ma-tool-desc';
    desc.textContent = s.description ?? '';
    desc.title = s.description ?? ''; // 鼠标悬停看全文
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.enabled;
    cb.onchange = async () => {
      const next = cb.checked;
      await MiniAgent.toolManager.setEnabled(s.name, next);
      // setEnabled 后取「实际生效态」——禁用被拒绝（如关闭界面/baseTools 不可关）时 live≠next
      const live = MiniAgent.executor.list(true).some((t) => t.name === s.name);
      if (cb.checked !== live) cb.checked = live;
      // 直接落盘黑名单键到 iframe 的 localStorage（basement config 是纯模型不保证自动落盘，见 basement config.ts）。
      // 以实际生效态 live 为准，保证同站点内刷新后开关状态存活。跨站不共享（浏览器对跨源 iframe storage 按站点分区）。
      const json = (() => {
        try {
          const cur = JSON.parse(localStorage.getItem('miniagent:__disabledTools') || '[]');
          const set = new Set(Array.isArray(cur) ? cur : []);
          if (live) set.delete(s.name); else set.add(s.name);
          return JSON.stringify([...set]);
        } catch { return '[]'; }
      })();
      try { localStorage.setItem('miniagent:__disabledTools', json); } catch { /* iframe 不可用时忽略 */ }
    };
    row.append(name, desc, cb); panel.append(row);
  }
}

let root: HTMLElement, bubbles: HTMLElement, input: HTMLInputElement, sendBtn: HTMLButtonElement, stopBtn: HTMLButtonElement;
// 气泡稳定索引：mid → DOM 元素。替代脆弱的 lastAssistantEl/lastToolEl 可变引用
// （工具调用后进入下一轮时，旧引用可能指向已失效/错误的气泡，导致更新/定稿静默丢失）。
const bubblesById = new Map<string, HTMLElement>();
let bubbleSeq = 0; // 无显式 id 时自增生成气泡 id
let acEl: HTMLElement | null = null;
let acItems: { text: string; hint: string }[] = [];
let acIndex = -1;
// 供 ui.* 方法在 mount 之后访问的节点与回调引用
let onSendRef: ((text: string) => void) | null = null;
let toolsPanelEl: HTMLElement | null = null;
let toggleBtnEl: HTMLButtonElement | null = null;

// 手动工具命令自动补全：/tool 补工具名，/tool /param 补参数（显示 parameters.properties[param].description）
function computeAc(text: string): { text: string; hint: string }[] {
  if (!text.startsWith('/')) return [];
  const lastSpace = text.lastIndexOf(' ');
  const after = text.slice(lastSpace + 1);
  const hasPrefix = lastSpace > 0;
  const propsOf = (name: string): Record<string, { description?: string; type?: string }> =>
    (MiniAgent.executor.list(true).find((t) => t.name === name)?.parameters?.properties ?? {}) as Record<string, { description?: string; type?: string }>;
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
      return MiniAgent.executor.list(true)
        .filter((t) => t.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((t) => ({ text: '/' + t.name + ' ', hint: t.description ?? '' }));
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
      const styleEl = document.createElement('style'); styleEl.textContent = STYLE;
      document.head.appendChild(styleEl);
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

      // 见下方节点赋值后注入的「自适应高度」ResizeObserver（需 bubbles 就绪）。

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

      // 自适应高度（仅高度，宽度固定 360px）：iframe 锚定右下角、向上生长、封顶视口。
      // 自然高度 = 面板 chrome（折叠/输入/工具面板 + gap）+ 气泡区全文高；
      // 以 (root.clientHeight - bubbles.clientHeight) + bubbles.scrollHeight 自洽求得：
      // 气泡滚动时前者为 chrome、后者为全文；未滚动时两者抵消为 root.clientHeight。
      // 该值只依赖内容、不依赖自身渲染高度 → 不会越缩越小回环。
      const measure = (): void => {
        const chrome = (root.clientHeight || 0) - (bubbles.clientHeight || 0);
        const content = bubbles.scrollHeight || 0;
        parent.postMessage({ type: 'ma:resize', height: chrome + content }, '*');
      };
      const ro = new ResizeObserver(measure);
      ro.observe(root);
      ro.observe(bubbles);
      measure();

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
      bubblesById.clear();
      acEl = null;
      onSendRef = null;
      toolsPanelEl = null;
      toggleBtnEl = null;
    },

    // 追加一条气泡，返回其稳定 id（mid）。同一调用（助手回复/工具执行）全程用该 id 寻址，
    // 不再依赖 lastXxxEl 可变引用——工具调用后进入下一轮时也能精确命中目标气泡。
    // 传入 id 时优先用传入值（engine 把气泡 id 与 assistant 消息 id 对齐，做到「每个消息一个 id」）。
    append(role: string, text: string, id?: string): string {
      const el = document.createElement('div'); el.className = `ma-bubble ${role}`;
      const mid = id ?? `b${(++bubbleSeq).toString(36)}`;
      el.dataset.mid = mid;
      if (role === 'assistant') {
        // 预建 think 折叠块（隐藏，有 reasoning 时显示）+ 正文容器
        setHTML(el, '<details class="ma-think" style="display:none"><summary>💭 思考过程</summary><div class="ma-think-body"></div></details><div class="ma-md-content"></div>');
        const c = el.querySelector('.ma-md-content') as HTMLElement; if (c) c.textContent = text;
      } else {
        el.textContent = text;
      }
      bubbles.append(el); bubbles.scrollTop = bubbles.scrollHeight;
      bubblesById.set(mid, el);
      return mid;
    },

    // 流式更新指定 id 的气泡：assistant 逐字文本+思考 / tool 进度→结果（流式用 textContent 快）。
    // 按 mid 寻址，命中失败仅告警，绝不静默指向错误气泡。
    update(mid: string, role: string, text: string, reasoning?: string): void {
      const el = bubblesById.get(mid) ?? null;
      if (!el) { console.warn('[MiniAgent.UI] update 跳过：找不到气泡', { mid, role, textLen: text?.length }); return; }
      if (!el.isConnected) { console.warn('[MiniAgent.UI] update 跳过：气泡已脱离 DOM', { mid, role }); return; }
      if (role === 'assistant') {
        const c = el.querySelector('.ma-md-content') as HTMLElement; if (c) c.textContent = text;
        if (reasoning != null) {
          const think = el.querySelector('.ma-think') as HTMLElement;
          if (think) { think.style.display = ''; const tb = el.querySelector('.ma-think-body') as HTMLElement; if (tb) tb.textContent = reasoning; }
        }
      } else { el.textContent = text; }
      bubbles.scrollTop = bubbles.scrollHeight;
    },

    // 把指定 id 的 tool 气泡渲染为 HTML（经 DOMPurify 清洗）。用于 marked 等返回 HTML 的工具结果。
    setToolHTML(mid: string, html: string): void {
      const el = bubblesById.get(mid) ?? null;
      if (!el) return;
      if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
        setHTML(el, DOMPurify.sanitize(html));
      } else {
        el.textContent = html; // 清洗库不可用时回退纯文本，避免 XSS
      }
      bubbles.scrollTop = bubbles.scrollHeight;
    },

    // 流结束：指定 id 的 assistant 气泡正文 + think 正文做 markdown 渲染（一次性，避免流式频繁 setHTML）。
    // 渲染走本地 renderMarkdownLocal（全局 marked + DOMPurify）。
    finalize(mid: string, role: string, text: string, reasoning?: string): void {
      const el = bubblesById.get(mid) ?? null;
      if (!el) { console.warn('[MiniAgent.UI] finalize 跳过：找不到气泡', { mid, role, textLen: text?.length, reasoningLen: reasoning?.length }); return; }
      if (!el.isConnected) { console.warn('[MiniAgent.UI] finalize 跳过：气泡已脱离 DOM', { mid }); return; }
      const c = el.querySelector('.ma-md-content') as HTMLElement;
      if (c) {
        // 正文为空但有过思考（如工具调用轮次助手仅发 tool_calls）：给占位提示，避免主区空白
        if (!text || !text.trim()) {
          c.textContent = reasoning ? '(模型已思考，本轮未返回正文)' : '(空响应)';
        } else {
          try { setHTML(c, renderMarkdownLocal(text)); } catch (e) { console.error('[MiniAgent.UI] renderMarkdown 异常:', e); c.textContent = text; }
        }
      }
      const think = el.querySelector('.ma-think') as HTMLElement;
      if (think) { if (reasoning) { const tb = el.querySelector('.ma-think-body') as HTMLElement; if (tb) setHTML(tb, renderMarkdownLocal(reasoning)); } else think.remove(); }
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

  // 人工确认闸（异步闸门，由 hooks 工具在注册时经 wrapHook 包裹）：base 弹原生确认气泡，true=允许
  requestApproval: async (call: { name: string; code?: string; riskLevel?: string }): Promise<boolean> =>
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
    }),
};

// 迟绑 thisArg（requestApproval 体内 this 指向 ui）已移至 hooks 工具的 register 统一处理（如需要）。

// ---- 以下为 UI 工具与启动器（原 src/agent.ts 内联部分，随 UI 一并归入 tools，使其成为标准 ToolDef）----

// 无 UI 时的空输出槽（UI 工具 unregister 时还原 headless）
const headlessSink: OutputSink = {
  append: () => '', update() {}, finalize() {}, setToolHTML() {}, setRunning() {},
};

// 配置不完整时的提示文案
const CONFIG_HINT = '⚠️ 未配置 API Key。两种设置方式：\n① 打开浏览器 DevTools → Application → Local Storage，直接编辑 `config` 键（JSON：{"apiKey":"你的Key","baseURL":"https://openrouter.ai/api/v1","model":"openrouter/free"}）；\n② 或运行命令：/storage /action set /key config /update true /value {"apiKey":"你的Key","baseURL":"https://openrouter.ai/api/v1","model":"openrouter/free"}';

// 等待 DOM 就绪（UI 挂载用）
function whenDomReady(): Promise<void> {
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') return resolve();
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

// 持久化的最小启动器：UI 被禁用后的"重新启用"入口（独立于已被卸载的 UI 本身，保证可逆、humane）
let launcherEl: HTMLElement | null = null;
function ensureLauncher(): HTMLElement {
  if (launcherEl) return launcherEl;
  const css =
    '#miniagent-launcher{position:fixed;right:14px;bottom:14px;z-index:2147483646;pointer-events:auto}' +
    '#miniagent-launcher button{padding:6px 12px;border:1px solid rgba(55,141,221,.6);border-radius:8px;' +
    'background:rgba(55,141,221,.92);color:#fff;cursor:pointer;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3)}';
  const style = document.createElement('style'); style.textContent = css;
  (document.head ?? document.documentElement).append(style);
  const el = document.createElement('div'); el.id = 'miniagent-launcher';
  el.innerHTML = '<button type="button" title="启用 MiniAgent 界面">💬 启用界面</button>';
  (el.querySelector('button') as HTMLButtonElement).onclick = () => { void MiniAgent.toolManager.setEnabled('ui', true); };
  if (document.body) document.body.append(el);
  else document.addEventListener('DOMContentLoaded', () => document.body.append(el), { once: true });
  launcherEl = el;
  return el;
}
function showLauncher(): void { ensureLauncher().style.display = ''; }
function hideLauncher(): void { ensureLauncher().style.display = 'none'; }
function createLauncher(): void {
  const el = ensureLauncher();
  const uiUp = agent.tools.has('ui');
  el.style.display = uiUp ? 'none' : '';
}

// 消费经 CDN <script> 引入的 basement 全局（运行时仅绑定 executor↔agent，IIFE 已注册内核 hooks；不自动启动其余工具）
const { agent, handleToolCommand } = MiniAgent;

// UI 工具：注册后挂载聊天界面并接管输出/渲染/确认闸；禁用即"关闭界面"（经确认闸、可逆），核心仍 headless 运行。启用即重新挂载。
export const uiTool: ToolDef = {
  name: 'ui',
  author: 'sys',
  deps: [{ name: 'storage', author: 'sys' }], // 依赖 storage：确保其 register（镜像 localStorage）先执行，ui 挂载时 hooks/默认工具已就绪
  description: '界面工具：注册后挂载聊天界面并接管输出/渲染/确认闸；在工具清单禁用即"关闭界面"（经确认闸、可逆），核心仍 headless 运行。启用即重新挂载。',
  parameters: {},
  register: async (_ctx) => {
    console.log('[ui] register 开始');
    try {
      agent.output = ui.chat; // 输出槽接管（agent.output 默认 headless 空实现）
      agent.extensions.set('ui', ui.chat); // UI 渲染能力（marked 已成为独立工具，不经此接管）
      agent.extensions.set('approval', ui.requestApproval); // 确认闸经此接入（核心 requestApproval 委托）
      console.log('[ui] await whenDomReady… readyState=', document.readyState);
      await whenDomReady();
      console.log('[ui] DOM ready，调 mount；当前已存在root=', !!document.getElementById('miniagent-root'));
      ui.chat.mount((text) => {
      // 发送期间按钮在「发送 ↔ 停止」间切换；停止按钮经 agent.chatStop 中断在途请求。
      // 运行态严格由两队列派生（basement 的 agent.isRunning = messageQueue 或 toolCallQueue 非空）：
      // 仅在「消息队列与工具调用队列皆空」时切回发送，否则保持停止——不引入任何需同步的私有标志。
      // 多轮/连发时 sendMessage 因基座引擎守卫（引擎已在跑）会同步立即 resolve，但此时队列仍非空 → isRunning 为 true → 不复位；
      // 引擎全部跑完（队列空）才由 basement engine.finally 复位，此处 .finally 也会再次核对 isRunning 幂等复位。
      const run = (fn: () => Promise<void>): void => {
        ui.chat.setRunning(true, () => agent.chatStop());
        fn().finally(() => {
          if (!agent.isRunning) ui.chat.setRunning(false);
        });
      };
      // 用户直接调用工具：/tool_name /param value
      if (text.startsWith('/')) {
        agent.output.append('user', text);
        run(() => handleToolCommand(text));
        return;
      }
      // 配置检查：apiKey 未配置时提示用户通过工具命令设置
      if (!agent.config.apiKey) {
        agent.output.append('user', text);
        agent.output.append('tool', CONFIG_HINT);
        return;
      }
      run(() => agent.sendMessage(text));
    });
      console.log('[ui] mount 调用完成，root=', !!document.getElementById('miniagent-root'));
      hideLauncher();
      console.log('[ui] register 完成，launcher 已隐藏');
    } catch (e) {
      console.error('[ui] register 抛错:', e);
      throw e;
    }
  },
  unregister: (_ctx) => {
    ui.chat.unmount();
    agent.output = headlessSink; // 还原 headless 空实现
    agent.extensions.delete('ui');
    agent.extensions.delete('approval');
    showLauncher(); // 露出重新启用入口，保证可逆
  },
};

// 模块加载即确保启动器存在：ui 被禁用时显"启用界面"入口；ui 启用时由 register 调 hideLauncher 隐藏
createLauncher();
