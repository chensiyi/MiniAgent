// ==UserScript==
// @name         MiniAgent
// @namespace    https://github.com/chensiyi/MiniAgent
// @version      0.2.0.20260727001517
// @description  极简 userScript 智能体（原生 DOM + GM 桥接 LLM；核心经 @require 引入 basement 全局 MiniAgent）
// @downloadURL  https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@tampermonkey/dist/miniagent.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@tampermonkey/dist/miniagent.user.js
// @match        *://*/*
// @require      https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@basement-0.2.6/dist/miniagent-basement.js
// @require      https://cdn.jsdelivr.net/npm/marked@12/marked.min.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js
// @connect      *
// @grant        GM_addStyle
// @grant        GM_deleteValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_setValue
// @noframes
// ==/UserScript==

(function() {
	"use strict";
	var _GM_addStyle = (() => typeof GM_addStyle != "undefined" ? GM_addStyle : void 0)();
	var _GM_deleteValue = (() => typeof GM_deleteValue != "undefined" ? GM_deleteValue : void 0)();
	var _GM_getValue = (() => typeof GM_getValue != "undefined" ? GM_getValue : void 0)();
	var _GM_listValues = (() => typeof GM_listValues != "undefined" ? GM_listValues : void 0)();
	var _GM_setValue = (() => typeof GM_setValue != "undefined" ? GM_setValue : void 0)();
	var _tt = globalThis.trustedTypes;
	var _hp = null;
	if (_tt) {
		const g = globalThis;
		if (!g.__maHp) try {
			g.__maHp = _tt.createPolicy("miniagent", { createHTML: (s) => s });
		} catch {
			g.__maHp = null;
		}
		_hp = g.__maHp ?? null;
	}
	function setHTML(el, html) {
		el.innerHTML = _hp ? _hp.createHTML(html) : html;
	}
	function renderMarkdownLocal(src) {
		const parsed = marked.parse(src);
		const html = typeof parsed === "string" ? parsed : "";
		return DOMPurify.sanitize(html);
	}
	var STYLE = `
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
	function renderToolsPanel(panel) {
		panel.replaceChildren();
		for (const s of MiniAgent.toolManager.getStates()) {
			const row = document.createElement("label");
			row.className = "ma-tool-row";
			const name = document.createElement("span");
			name.className = "ma-tool-name";
			name.textContent = s.author && s.author !== "sys" ? `${s.name} @${s.author}` : s.name;
			const desc = document.createElement("span");
			desc.className = "ma-tool-desc";
			desc.textContent = s.description ?? "";
			desc.title = s.description ?? "";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = s.enabled;
			cb.onchange = async () => {
				const next = cb.checked;
				await MiniAgent.toolManager.setEnabled(s.name, next);
				const live = MiniAgent.executor.list(true).some((t) => t.name === s.name);
				if (cb.checked !== live) cb.checked = live;
			};
			row.append(name, desc, cb);
			panel.append(row);
		}
	}
	var root;
	var bubbles;
	var input;
	var sendBtn;
	var stopBtn;
	var bubblesById = new Map();
	var bubbleSeq = 0;
	var acEl = null;
	var acItems = [];
	var acIndex = -1;
	var onSendRef = null;
	var toolsPanelEl = null;
	var toggleBtnEl = null;
	function computeAc(text) {
		if (!text.startsWith("/")) return [];
		const lastSpace = text.lastIndexOf(" ");
		const after = text.slice(lastSpace + 1);
		const hasPrefix = lastSpace > 0;
		const propsOf = (name) => MiniAgent.executor.list(true).find((t) => t.name === name)?.parameters?.properties ?? {};
		const usedParams = (toolName, activeQ) => {
			const used = new Set();
			const re = /\/(\S+)/g;
			let m;
			while (m = re.exec(text)) {
				const w = m[1];
				if (w === toolName || w === activeQ) continue;
				used.add(w);
			}
			return used;
		};
		const paramItems = (toolName, q) => {
			const props = propsOf(toolName);
			return Object.entries(props).filter(([k]) => !usedParams(toolName, q).has(k) && k.toLowerCase().includes(q)).slice(0, 8).map(([k, v]) => ({
				text: "/" + k + " ",
				hint: (v.description ?? "") + (v.type ? ` (${v.type})` : "")
			}));
		};
		if (after.startsWith("/")) {
			const q = after.slice(1).toLowerCase();
			if (!hasPrefix) return MiniAgent.executor.list(true).filter((t) => t.name.toLowerCase().includes(q)).slice(0, 8).map((t) => ({
				text: "/" + t.name + " ",
				hint: t.description ?? ""
			}));
			const toolName = text.slice(1, lastSpace).split(/\s+/)[0];
			return paramItems(toolName, q);
		}
		if (after === "" && hasPrefix) {
			const toolName = text.slice(1, lastSpace).split(/\s+/)[0];
			return paramItems(toolName, "");
		}
		return [];
	}
	function renderAc() {
		const el = acEl;
		if (!el) return;
		if (!acItems.length) {
			el.style.display = "none";
			el.replaceChildren();
			return;
		}
		el.replaceChildren();
		acItems.forEach((it, i) => {
			const item = document.createElement("div");
			item.className = "ma-ac-item" + (i === acIndex ? " active" : "");
			const name = document.createElement("div");
			name.className = "ma-ac-name";
			name.textContent = it.text.trim();
			const hint = document.createElement("div");
			hint.className = "ma-ac-hint";
			hint.textContent = it.hint;
			item.append(name, hint);
			item.onmousedown = (e) => {
				e.preventDefault();
				acceptAc(it.text);
			};
			item.onmouseenter = () => {
				acIndex = i;
				renderAc();
			};
			el.append(item);
		});
		el.style.display = "";
	}
	function updateAc() {
		if (!acEl || !input) return;
		acItems = computeAc(input.value);
		acIndex = acItems.length ? 0 : -1;
		renderAc();
	}
	function acceptAc(insert) {
		if (!input) return;
		const text = input.value;
		const lastSpace = text.lastIndexOf(" ");
		const before = lastSpace === -1 ? "" : text.slice(0, lastSpace + 1);
		input.value = before + insert;
		input.focus();
		updateAc();
	}
	var ui = {
		chat: {
			mount(onSend) {
				if (document.getElementById("miniagent-root")) return;
				_GM_addStyle(STYLE);
				root = document.createElement("div");
				root.id = "miniagent-root";
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
				bubbles = root.querySelector(".ma-bubbles");
				input = root.querySelector(".ma-input");
				sendBtn = root.querySelector(".ma-send");
				stopBtn = root.querySelector(".ma-stop");
				const toolsBtn = root.querySelector(".ma-tools");
				toolsPanelEl = root.querySelector(".ma-tools-panel");
				acEl = document.createElement("div");
				acEl.className = "ma-ac";
				acEl.style.display = "none";
				root.querySelector(".ma-input-row").append(acEl);
				onSendRef = onSend;
				toolsBtn.onclick = () => ui.tools.toggle();
				toggleBtnEl = root.querySelector(".ma-toggle");
				toggleBtnEl.onclick = () => ui.panel.toggle();
				const doSend = () => {
					const text = input.value.trim();
					if (!text) return;
					input.value = "";
					if (acEl) acEl.style.display = "none";
					onSendRef?.(text);
				};
				sendBtn.onclick = doSend;
				input.oninput = () => ui.chat.refreshAutocomplete();
				input.onblur = () => {
					if (acEl) acEl.style.display = "none";
				};
				input.onkeydown = (e) => {
					if (acEl && acEl.style.display !== "none" && acItems.length) {
						if (e.key === "ArrowDown") {
							e.preventDefault();
							acIndex = (acIndex + 1) % acItems.length;
							renderAc();
							return;
						}
						if (e.key === "ArrowUp") {
							e.preventDefault();
							acIndex = (acIndex - 1 + acItems.length) % acItems.length;
							renderAc();
							return;
						}
						if (e.key === "Enter" || e.key === "Tab") {
							e.preventDefault();
							if (acIndex >= 0) ui.chat.acceptAutocomplete(acItems[acIndex].text);
							return;
						}
						if (e.key === "Escape") {
							acEl.style.display = "none";
							return;
						}
					}
					if (e.key === "Enter") {
						e.preventDefault();
						doSend();
					}
				};
			},
			unmount() {
				if (root && root.parentNode) root.parentNode.removeChild(root);
				root = null;
				bubbles = null;
				input = null;
				sendBtn = null;
				stopBtn = null;
				bubblesById.clear();
				acEl = null;
				onSendRef = null;
				toolsPanelEl = null;
				toggleBtnEl = null;
			},
			append(role, text, id) {
				const el = document.createElement("div");
				el.className = `ma-bubble ${role}`;
				const mid = id ?? `b${(++bubbleSeq).toString(36)}`;
				el.dataset.mid = mid;
				if (role === "assistant") {
					setHTML(el, "<details class=\"ma-think\" style=\"display:none\"><summary>💭 思考过程</summary><div class=\"ma-think-body\"></div></details><div class=\"ma-md-content\"></div>");
					const c = el.querySelector(".ma-md-content");
					if (c) c.textContent = text;
				} else el.textContent = text;
				bubbles.append(el);
				bubbles.scrollTop = bubbles.scrollHeight;
				bubblesById.set(mid, el);
				return mid;
			},
			update(mid, role, text, reasoning) {
				const el = bubblesById.get(mid) ?? null;
				if (!el) {
					console.warn("[MiniAgent.UI] update 跳过：找不到气泡", {
						mid,
						role,
						textLen: text?.length
					});
					return;
				}
				if (!el.isConnected) {
					console.warn("[MiniAgent.UI] update 跳过：气泡已脱离 DOM", {
						mid,
						role
					});
					return;
				}
				if (role === "assistant") {
					const c = el.querySelector(".ma-md-content");
					if (c) c.textContent = text;
					if (reasoning != null) {
						const think = el.querySelector(".ma-think");
						if (think) {
							think.style.display = "";
							const tb = el.querySelector(".ma-think-body");
							if (tb) tb.textContent = reasoning;
						}
					}
				} else el.textContent = text;
				bubbles.scrollTop = bubbles.scrollHeight;
			},
			setToolHTML(mid, html) {
				const el = bubblesById.get(mid) ?? null;
				if (!el) return;
				if (typeof DOMPurify !== "undefined" && typeof DOMPurify.sanitize === "function") setHTML(el, DOMPurify.sanitize(html));
				else el.textContent = html;
				bubbles.scrollTop = bubbles.scrollHeight;
			},
			finalize(mid, role, text, reasoning) {
				const el = bubblesById.get(mid) ?? null;
				if (!el) {
					console.warn("[MiniAgent.UI] finalize 跳过：找不到气泡", {
						mid,
						role,
						textLen: text?.length,
						reasoningLen: reasoning?.length
					});
					return;
				}
				if (!el.isConnected) {
					console.warn("[MiniAgent.UI] finalize 跳过：气泡已脱离 DOM", { mid });
					return;
				}
				const c = el.querySelector(".ma-md-content");
				if (c) if (!text || !text.trim()) c.textContent = reasoning ? "(模型已思考，本轮未返回正文)" : "(空响应)";
				else try {
					setHTML(c, renderMarkdownLocal(text));
				} catch (e) {
					console.error("[MiniAgent.UI] renderMarkdown 异常:", e);
					c.textContent = text;
				}
				const think = el.querySelector(".ma-think");
				if (think) if (reasoning) {
					const tb = el.querySelector(".ma-think-body");
					if (tb) setHTML(tb, renderMarkdownLocal(reasoning));
				} else think.remove();
			},
			setRunning(running, onStop) {
				sendBtn.style.display = running ? "none" : "";
				stopBtn.style.display = running ? "" : "none";
				input.disabled = running;
				if (running && onStop) stopBtn.onclick = onStop;
			},
			send() {
				const text = input?.value.trim();
				if (!text || !onSendRef) return;
				if (input) input.value = "";
				if (acEl) acEl.style.display = "none";
				onSendRef(text);
			},
			setInput(text) {
				if (!input) return;
				input.value = text;
				updateAc();
			},
			refreshAutocomplete() {
				updateAc();
			},
			acceptAutocomplete(insert) {
				acceptAc(insert);
			}
		},
		panel: {
			toggle() {
				if (!root || !toggleBtnEl) return;
				const collapsed = root.classList.toggle("ma-collapsed");
				toggleBtnEl.textContent = collapsed ? "▴" : "▾";
				if (!collapsed && toolsPanelEl && toolsPanelEl.style.display === "") renderToolsPanel(toolsPanelEl);
			},
			setCollapsed(c) {
				if (!root || !toggleBtnEl) return;
				if (root.classList.contains("ma-collapsed") === c) return;
				root.classList.toggle("ma-collapsed", c);
				toggleBtnEl.textContent = c ? "▴" : "▾";
				if (!c && toolsPanelEl && toolsPanelEl.style.display === "") renderToolsPanel(toolsPanelEl);
			},
			isCollapsed() {
				return !!root && root.classList.contains("ma-collapsed");
			}
		},
		tools: {
			toggle() {
				if (!toolsPanelEl) return;
				if (toolsPanelEl.style.display === "none") {
					renderToolsPanel(toolsPanelEl);
					toolsPanelEl.style.display = "";
				} else toolsPanelEl.style.display = "none";
			},
			open() {
				if (!toolsPanelEl) return;
				renderToolsPanel(toolsPanelEl);
				toolsPanelEl.style.display = "";
			},
			close() {
				if (toolsPanelEl) toolsPanelEl.style.display = "none";
			},
			refresh() {
				if (toolsPanelEl && toolsPanelEl.style.display !== "none") renderToolsPanel(toolsPanelEl);
			}
		},
		requestApproval: async (call) => new Promise((resolve) => {
			const el = document.createElement("div");
			el.className = "ma-bubble tool";
			const risk = call.riskLevel ? ` <span class="ma-risk">[${call.riskLevel}]</span>` : "";
			setHTML(el, `
        <div>工具请求执行（${call.name}）${risk}，是否允许？</div>
        ${call.code ? "<pre class=\"ma-code\"></pre>" : ""}
        <div class="ma-approve"><button class="ok" type="button">允许</button><button class="no" type="button">拒绝</button></div>`);
			if (call.code) el.querySelector(".ma-code").textContent = call.code;
			const finish = (ok) => {
				el.remove();
				resolve(ok);
			};
			el.querySelector(".ok").onclick = () => finish(true);
			el.querySelector(".no").onclick = () => finish(false);
			bubbles.append(el);
			bubbles.scrollTop = bubbles.scrollHeight;
		})
	};
	var headlessSink = {
		append: () => "",
		update() {},
		finalize() {},
		setToolHTML() {},
		setRunning() {}
	};
	var CONFIG_HINT = "⚠️ 未配置 API Key。两种设置方式：\n① 打开 Tampermonkey 仪表盘 → 本脚本 → 数值，直接编辑 `config` 键（JSON：{\"apiKey\":\"你的Key\",\"baseURL\":\"https://openrouter.ai/api/v1\",\"model\":\"openrouter/free\"}）；\n② 或运行命令：/gm_storage /action set /ns \"\" /key config /update true /value {\"apiKey\":\"你的Key\",\"baseURL\":\"https://openrouter.ai/api/v1\",\"model\":\"openrouter/free\"}";
	function whenDomReady() {
		return new Promise((resolve) => {
			if (document.readyState !== "loading") return resolve();
			document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
		});
	}
	var launcherEl = null;
	function ensureLauncher() {
		if (launcherEl) return launcherEl;
		const css = "#miniagent-launcher{position:fixed;right:14px;bottom:14px;z-index:2147483646}#miniagent-launcher button{padding:6px 12px;border:1px solid rgba(55,141,221,.6);border-radius:8px;background:rgba(55,141,221,.92);color:#fff;cursor:pointer;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3)}";
		const style = document.createElement("style");
		style.textContent = css;
		(document.head ?? document.documentElement).append(style);
		const el = document.createElement("div");
		el.id = "miniagent-launcher";
		el.innerHTML = "<button type=\"button\" title=\"启用 MiniAgent 界面\">💬 启用界面</button>";
		el.querySelector("button").onclick = () => {
			MiniAgent.toolManager.setEnabled("ui", true);
		};
		if (document.body) document.body.append(el);
		else document.addEventListener("DOMContentLoaded", () => document.body.append(el), { once: true });
		launcherEl = el;
		return el;
	}
	function showLauncher() {
		ensureLauncher().style.display = "";
	}
	function hideLauncher() {
		ensureLauncher().style.display = "none";
	}
	function createLauncher() {
		const el = ensureLauncher();
		const uiUp = agent$2.tools.has("ui");
		el.style.display = uiUp ? "none" : "";
	}
	var { agent: agent$2, handleToolCommand } = MiniAgent;
	var uiTool = {
		name: "ui",
		author: "sys",
		deps: [{
			name: "gm_storage",
			author: "sys"
		}],
		description: "界面工具：注册后挂载聊天界面并接管输出/渲染/确认闸；在工具清单禁用即\"关闭界面\"（经确认闸、可逆），核心仍 headless 运行。启用即重新挂载。",
		parameters: {},
		register: async (_ctx) => {
			agent$2.output = ui.chat;
			agent$2.extensions.set("ui", ui.chat);
			agent$2.extensions.set("approval", ui.requestApproval);
			await whenDomReady();
			ui.chat.mount((text) => {
				const run = (fn) => {
					ui.chat.setRunning(true, () => agent$2.chatStop());
					fn().finally(() => ui.chat.setRunning(false));
				};
				if (text.startsWith("/")) {
					agent$2.output.append("user", text);
					run(() => handleToolCommand(text));
					return;
				}
				if (!agent$2.config.apiKey) {
					agent$2.output.append("user", text);
					agent$2.output.append("tool", CONFIG_HINT);
					return;
				}
				run(() => agent$2.sendMessage(text));
			});
			hideLauncher();
		},
		unregister: (_ctx) => {
			ui.chat.unmount();
			agent$2.output = headlessSink;
			agent$2.extensions.delete("ui");
			agent$2.extensions.delete("approval");
			showLauncher();
		}
	};
	createLauncher();
	var { agent: agent$1 } = MiniAgent;
	var hooks;
	var NS_MEM = "memory";
	var OVERVIEW_NS = [
		"session",
		"tools",
		"code",
		"memory"
	];
	function resolveSet(nsOrKey, keyOrValue, value) {
		if (value === void 0) return {
			key: nsOrKey,
			val: keyOrValue
		};
		const ns = String(nsOrKey);
		const key = String(keyOrValue);
		return {
			key: ns ? `${ns}:${key}` : key,
			val: value
		};
	}
	function resolveDel(nsOrKey, key) {
		return key === void 0 ? nsOrKey : `${nsOrKey}:${key}`;
	}
	var mirrored = false;
	var gmStorageTool = {
		name: "gm_storage",
		author: "sys",
		deps: [{
			name: "hooks",
			author: "sys"
		}],
		description: "统一的持久存储管理（默认 memory 命名空间，可指定其它 ns）。action 取值：get=读取键；set=写入键（update=true 时合并已有对象）；list=列出键（给定 ns 列该分区子键，不给 ns 按 session/tools/code/memory 分区概览）；del=删除键（不可恢复，删除前会请求确认）。用于记忆、配置、状态管理。底层 storage 为内存 Map，本工具经 before 钩子透明落盘到 GM_*，其它工具无需关心环境。",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"get",
						"set",
						"list",
						"del"
					],
					description: "操作类型：get=读取某个键的值；set=写入/更新某个键；list=列出命名空间下的键（不给 ns 则按 session/tools/code/memory 分区概览）；del=删除某个键（不可恢复，删除前会请求用户确认）。"
				},
				key: {
					type: "string",
					description: "键名。get/set/del 必需；list 不需要。"
				},
				value: {
					type: "string",
					description: "要保存的值（set 必需）。会原样写入存储；get 时以 JSON 字符串形式返回，因此对象/数组等复杂值建议先 JSON 序列化后传入。"
				},
				ns: {
					type: "string",
					description: "可选命名空间（分区）。默认 memory；也可用 session/tools/code 等已有分区，或自定义新分区。"
				},
				update: {
					type: "boolean",
					description: "仅 set 生效。为 true 时进入合并模式：先读取已有值，再把传入的值（对象）浅合并进去，而非整条覆盖。"
				}
			},
			required: [
				"action",
				"key",
				"value",
				"ns",
				"update"
			]
		},
		register(ctx) {
			if (!mirrored) {
				for (const k of _GM_listValues()) {
					const raw = _GM_getValue(k, void 0);
					if (raw === void 0 || raw === null) continue;
					try {
						agent$1.storage.set("", k, JSON.parse(raw));
					} catch {
						agent$1.storage.set("", k, raw);
					}
				}
				mirrored = true;
			}
			hooks = agent$1.tools.get("hooks");
			hooks.installHook("storageSet", "before", (opts) => {
				const { key, val } = resolveSet(opts.args[0], opts.args[1], opts.args[2]);
				_GM_setValue(key, typeof val === "string" ? val : JSON.stringify(val));
			}, {
				id: "sys-gm-persist-set",
				name: "GM 落盘(set)",
				toolName: "gm_storage",
				core: true,
				agentRef: ctx.agent,
				execRef: ctx.executor
			});
			hooks.installHook("storageDelete", "before", (opts) => {
				_GM_deleteValue(resolveDel(opts.args[0], opts.args[1]));
			}, {
				id: "sys-gm-persist-del",
				name: "GM 落盘(del)",
				toolName: "gm_storage",
				core: true,
				agentRef: ctx.agent,
				execRef: ctx.executor
			});
			console.log("[MiniAgent] gm_storage 已挂载落盘钩子（storageSet/storageDelete → GM_*）");
		},
		unregister(_ctx) {
			hooks?.uninstallToolHooks("gm_storage");
			console.log("[MiniAgent] gm_storage 已卸载，落盘钩子已摘除");
		},
		call: async (args, ctx) => {
			const action = String(args.action ?? "");
			const ns = String(args.ns ?? NS_MEM);
			switch (action) {
				case "get": {
					const key = String(args.key ?? "");
					if (!key) return "参数 key 缺失";
					const v = ctx.storage.get(ns, key);
					return v === void 0 ? "(无此键)" : JSON.stringify(v);
				}
				case "set": {
					const key = String(args.key ?? "");
					if (!key) return "参数 key 缺失";
					if (args.value === void 0) return "参数 value 缺失";
					if (args.update) {
						const existing = ctx.storage.get(ns, key) ?? {};
						const incoming = args.value;
						const merged = typeof existing === "object" && existing && typeof incoming === "object" && incoming ? {
							...existing,
							...incoming
						} : incoming;
						ctx.storage.set(ns, key, merged);
						return `已合并保存 ${ns ? ns + ":" : ""}${key}`;
					}
					ctx.storage.set(ns, key, args.value);
					return `已保存 ${ns ? ns + ":" : ""}${key}`;
				}
				case "list": {
					if (args.ns) {
						const keys = agent$1.storage.keys(ns).sort((a, b) => a.localeCompare(b));
						return JSON.stringify({
							ns,
							count: keys.length,
							keys
						});
					}
					const overview = {};
					for (const n of OVERVIEW_NS) overview[n] = agent$1.storage.keys(n).sort((a, b) => a.localeCompare(b));
					overview.flat = agent$1.storage.keys().filter((k) => !k.includes(":")).sort((a, b) => a.localeCompare(b));
					return JSON.stringify(overview);
				}
				case "del": {
					const key = String(args.key ?? "");
					if (!key) return "参数 key 缺失";
					if (!await ctx.executor.requestApproval({
						name: `gm_storage:del ${ns}:${key}`,
						riskLevel: "high"
					}, ctx.agent)) return "用户拒绝了执行";
					ctx.storage.del(ns, key);
					return `已删除 ${ns}:${key}`;
				}
				default: return `未知 action: ${action}（支持 get/set/list/del）`;
			}
		}
	};
	var { agent, toolManager, defaultTools } = MiniAgent;
	var hooksTool = defaultTools.find((t) => t.name === "hooks");
	toolManager.definePreset([gmStorageTool, hooksTool], [
		gmStorageTool,
		...defaultTools,
		uiTool
	]);
	toolManager.bootstrap();
	globalThis.agent = agent;
})();
