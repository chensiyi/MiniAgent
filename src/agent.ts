import { llm, type ChatMessage, type ToolCallLite, type ChatRequestBody, type ChatResult, type ChatChunk } from './core/llm';
import { executor, defaultTools, extraBuiltinTools, type ToolCall, type ToolDef } from './core/executor';
import { storage } from './core/storage';
import { NS_FLAT, FLAT, LEGACY } from './core/keys';
import { ui } from './ui/ui';
import { withHooks } from './core/withHooks';
import { getSystemPrompt, getConfig, getBaseRequestBody, saveConfig, SYSTEM_PROMPT } from './model/config';

// 队列引擎的"继续推理"哨兵：工具跑完后压回 messageQueue 队首，引擎取出后只调 LLM、不提交新用户消息。
const SENTINEL = { _infer: true } as unknown as ChatMessage;
function isSentinel(m: ChatMessage): boolean {
  return (m as unknown as { _infer?: boolean })._infer === true;
}

// 把流式累积的 ToolCallLite 转成 executor 的 ToolCall（参数 JSON.parse）
function toToolCall(t: ToolCallLite): ToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = t.function.arguments ? JSON.parse(t.function.arguments) : {};
  } catch {
    args = { raw: t.function.arguments };
  }
  return { id: t.id, name: t.function.name, args };
}

// 输出槽（核心契约）：引擎只写这个槽，绝不直连 UI 模块。默认 headless 空实现——
// 核心可在无 DOM / 无 UI 环境运行；UI 挂载时把 agent.output 替换为 DOM 实现（ui.chat）。
interface OutputSink {
  append(role: string, text: string): void;
  updateLast(role: string, text: string, reasoning?: string): void;
  finalizeLast(role: string, text: string, reasoning?: string): void;
  setToolHTML(html: string): void;
  setRunning(running: boolean, onStop?: () => void): void;
}
const headlessSink: OutputSink = {
  append() {}, updateLast() {}, finalizeLast() {}, setToolHTML() {}, setRunning() {},
};

export const agent = {
  messages: [] as ChatMessage[], // 已提交给 LLM 的全量上下文
  messageQueue: [] as ChatMessage[], // 待提交的用户/推理轮
  toolCallQueue: [] as ToolCall[], // 待执行的工具调用
  sessionId: '', // 当前会话 id（由 session 工具的 onRegister 生成）
  storage, // 逻辑存储层（命名空间分区），供运行时 / LLM 动态读写与编辑
  llm, executor, // 暴露给 LLM 做自编排：动态注册工具 / 直接推理
  output: headlessSink, // 输出槽（核心契约）：引擎只写这里，不直连 UI；默认 headless 空实现，UI 挂载时替换为 DOM 实现
  extensions: new Map<string, unknown>(), // 通用能力注册表：UI 挂载时注册 'ui'/'approval'，工具与核心经此发现能力，不硬引用 UI 形状
  tools: new Map<string, ToolDef>(), // 按名挂载的权威表（文档 §5.2）
  _engineActive: false, // 引擎是否在跑（防止并发起多个引擎）

  // active 严格由两队列派生（peek 不弹 → 在途 LLM 期间队首仍在，派生正确，无需额外布尔）
  get isRunning(): boolean {
    return this.messageQueue.length > 0 || this.toolCallQueue.length > 0;
  },

  // 停止：中断在途请求（停止按钮调用）
  chatStop(): void {
    llm.cancel();
  },

  // 引擎：队列调度循环（withHooks，before 钩子管运行态）
  engine: withHooks(async function () {
    try {
      while (agent.messageQueue.length || agent.toolCallQueue.length) {
        // ① 工具队列优先
        if (agent.toolCallQueue.length) {
          const calls = agent.toolCallQueue.splice(0);
          for (const call of calls) {
            // 进度指示：执行前先亮"执行中"，避免聊天区在耗时/确认工具期间空白
            agent.output.append('tool', `⚙ ${call.name}: 执行中…`);
            const obs = await executor.run(call, agent);
            agent.messages.push({
              role: 'tool',
              content: obs,
              tool_call_id: call.id,
              name: call.name,
            } as ChatMessage);
            agent.output.updateLast('tool', `⚙ ${call.name}: ${obs}`);
          }
          // 工具跑完 → 压"继续推理"哨兵到队首
          agent.messageQueue.unshift(SENTINEL);
          continue;
        }

        // ② 推进消息 / 再推理（peek 不弹，保证在途期间队列非空=活动中）
        if (agent.messageQueue.length) {
          const msg = agent.messageQueue[0];
          const inf = isSentinel(msg);
          if (!inf) {
            agent.messages.push(msg); // user 气泡已由 sendMessage 渲染，这里不重复 append
          }

          // assistant 占位气泡：流式逐字更新依赖 lastAssistantEl，必须先建
          agent.output.append('assistant', '');

          // 构建请求体：baseRequestBody 模板（编排可热更新）+ config.model 兜底；
          // messages/stream/tools 经此请求体传入；before 钩子可编辑（streamChat.before 改 opts.args[0]）。
          const tools = executor.list(); // 仅非 hidden 工具进 LLM 载荷
          const body: ChatRequestBody = {
            ...getBaseRequestBody(),
            messages: agent.messages,
            stream: true,
          };
          if (typeof body.model !== 'string' || !body.model) body.model = getConfig().model; // model 兜底 config
          if (tools.length) {
            body.tools = tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, inputSchema: t.inputSchema },
            }));
            body.tool_choice = 'auto';
          }

          // 手动驱动迭代器：逐块更新 UI，结束(done)时 r.value 即 streamChat 的 return（完整 ChatResult）。
          // 以 return 的 toolCalls 为权威真相源，消除与引擎内累加器双重累积的漂移风险。
          const it = llm.streamChat(body);
          let r = await it.next();
          let content = '', reasoning = '';
          while (!r.done) {
            const chunk = r.value as ChatChunk;
            if (chunk.delta) {
              content += chunk.delta;
              agent.output.updateLast('assistant', content, reasoning);
            }
            if (chunk.reasoning) {
              reasoning += chunk.reasoning;
              agent.output.updateLast('assistant', content, reasoning);
            }
            r = await it.next();
          }
          const final = (r.value ?? { content: '', toolCalls: [] }) as ChatResult;
          const toolCalls: ToolCallLite[] = final.toolCalls;
          agent.output.finalizeLast('assistant', content, reasoning || undefined);

          agent.messages.push({
            role: 'assistant',
            content,
            reasoning_content: reasoning || undefined, // 写回思考链，供后续轮次（含工具循环）保留上下文
            tool_calls: toolCalls.length ? toolCalls : undefined,
          } as ChatMessage);

          agent.messageQueue.shift(); // 推理完成才弹出
          if (toolCalls.length) agent.toolCallQueue.push(...toolCalls.map(toToolCall));
          continue;
        }

        break; // 两队列空 → idle
      }
    } finally {
      // 覆盖成功/异常/取消：复位运行态
      agent.output.setRunning(false);
    }
  }),

  // 发送用户消息：入队 + 若引擎未跑则启动
  sendMessage: withHooks(async function (text: string) {
    agent.messageQueue.push({ role: 'user', content: text } as ChatMessage);
    agent.output.append('user', text);
    if (!agent._engineActive) {
      agent._engineActive = true;
      try {
        await agent.engine();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        agent.output.append('tool', `⚠️ ${msg}`);
        // 取消/异常：丢弃待处理轮，避免残留队首被重复提交
        agent.messageQueue = [];
        agent.toolCallQueue = [];
      } finally {
        agent._engineActive = false;
      }
    }
  }),
  // 验收别名：控制台可经 agent.chat.sendMessage('...') 直接发消息并看到工具调用结果
  get chat() {
    return { sendMessage: (text: string) => agent.sendMessage(text) };
  },
};

// 迟绑 thisArg：engine / sendMessage 体内 this 指向 agent（局部上下文），避免 TDZ。
(agent.engine as unknown as { __thisArg?: unknown }).__thisArg = agent;
(agent.sendMessage as unknown as { __thisArg?: unknown }).__thisArg = agent;

// Agent 类型（供 executor 的 RunCtx/RegisterCtx 使用，类型引用避免运行时循环依赖）
export type Agent = typeof agent;

// 系统提示编排：独立 before 钩子注入（不写死在模块体），保持编排可插拔/可替换
function orchestrateSystemPrompt(): void {
  if (agent.messages.some((m) => m.role === 'system')) return; // 幂等：仅首次注入
  const sys = getSystemPrompt();
  if (sys) agent.messages.unshift({ role: 'system', content: sys } as ChatMessage);
}
Object.assign(orchestrateSystemPrompt, { __coreHook: true, __name: '系统提示注入', __hookId: 'sys-prompt-inject' });
agent.sendMessage.beforeExe.push(orchestrateSystemPrompt);

// 运行态钩子：消息处理开始（点击发送那一刻）→ 发送按钮变身停止按钮（用户要求"通过 hook"）
const setRunningHook = () => agent.output.setRunning(true, agent.chatStop);
Object.assign(setRunningHook, { __coreHook: true, __name: '运行态切换', __hookId: 'sys-running-toggle' });
agent.sendMessage.beforeExe.push(setRunningHook);

// 基本初始化（进工作循环前的一次性 bootstrap，属架构铁律允许的顶层副作用）：
// ① 种子默认配置（落盘为扁平 config）；② 旧 default:config 由 getConfig 惰性迁回扁平 config（兼容历史数据）；
// ③ 绑定 agent 引用；④ 注册默认工具（→ 各 onRegister，含 session 落盘安装）；
// ⑤ 重建持久化的自编排工具（→ onRegister 重建）。
// ---- UI 作为 tool（§11：核心可无 UI 运行；UI 是工具清单里一个可禁用/启用的 tool）----
// register：挂载聊天界面 + 接管输出槽/渲染/确认闸；unregister：卸载 DOM + 还原 headless。
// 关闭界面 = 在 ⚙ 工具清单禁用 ui 工具（经确认闸、可逆），核心照常 headless 运行；
// 持久化走 config.disabledTools（init 已剔除黑名单）。重新启用 = register 重新挂载。
function whenDomReady(): Promise<void> {
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') return resolve();
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

// 持久化的最小启动器：UI 被禁用后的"重新启用"入口（独立于已被卸载的 UI 本身，保证可逆、humane）。
let launcherEl: HTMLElement | null = null;
function ensureLauncher(): HTMLElement {
  if (launcherEl) return launcherEl;
  const css =
    '#miniagent-launcher{position:fixed;right:14px;bottom:14px;z-index:2147483646}' +
    '#miniagent-launcher button{padding:6px 12px;border:1px solid rgba(55,141,221,.6);border-radius:8px;' +
    'background:rgba(55,141,221,.92);color:#fff;cursor:pointer;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3)}';
  const style = document.createElement('style'); style.textContent = css;
  (document.head ?? document.documentElement).append(style);
  const el = document.createElement('div'); el.id = 'miniagent-launcher';
  el.innerHTML = '<button type="button" title="启用 MiniAgent 界面">💬 启用界面</button>';
  (el.querySelector('button') as HTMLButtonElement).onclick = () => { void executor.setEnabled('ui', true); };
  if (document.body) document.body.append(el);
  else document.addEventListener('DOMContentLoaded', () => document.body.append(el), { once: true });
  launcherEl = el;
  return el;
}
function showLauncher(): void { ensureLauncher().style.display = ''; }
function hideLauncher(): void { ensureLauncher().style.display = 'none'; }
function createLauncher(): void {
  const el = ensureLauncher();
  const uiUp = executor.list(true).some((t) => t.name === 'ui');
  el.style.display = uiUp ? 'none' : '';
}

// 配置不完整时的提示文案
const CONFIG_HINT = '⚠️ 未配置 API Key。两种设置方式：\n① 打开 Tampermonkey 仪表盘 → 本脚本 → 数值，直接编辑 `config` 键（JSON：{"apiKey":"你的Key","baseURL":"https://openrouter.ai/api/v1","model":"openrouter/free"}）；\n② 或运行命令：/gm_storage /action set /ns "" /key config /update true /value {"apiKey":"你的Key","baseURL":"https://openrouter.ai/api/v1","model":"openrouter/free"}';

const uiTool: ToolDef = {
  name: 'ui',
  author: 'sys',
  description: '界面工具：注册后挂载聊天界面并接管输出/渲染/确认闸；在工具清单禁用即"关闭界面"（经确认闸、可逆），核心仍 headless 运行。启用即重新挂载。',
  inputSchema: {},
  register: async (_ctx) => {
    agent.output = ui.chat; // 输出槽接管（agent.output 默认 headless 空实现）
    agent.extensions.set('ui', ui.chat); // UI 渲染能力（ui.chat.finalizeLast 直接用 renderMarkdown；marked 已成为独立工具，不经此接管）
    agent.extensions.set('approval', ui.requestApproval); // 确认闸经此接入（核心 requestApproval 委托）
    await whenDomReady();
    ui.chat.mount((text) => {
      // 用户直接调用工具：/tool_name /param value
      if (text.startsWith('/')) {
        agent.output.append('user', text);
        void handleToolCommand(text);
        return;
      }
      // 配置检查：apiKey 未配置时提示用户通过工具命令设置
      if (!getConfig().apiKey) {
        agent.output.append('user', text);
        agent.output.append('tool', CONFIG_HINT);
        return;
      }
      void agent.sendMessage(text);
    });
    hideLauncher();
  },
  unregister: (_ctx) => {
    ui.chat.unmount();
    agent.output = headlessSink; // 还原 headless 空实现
    agent.extensions.delete('ui');
    agent.extensions.delete('approval');
    showLauncher(); // 露出重新启用入口，保证可逆
  },
};

function init(): void {
  const cfg = getConfig(); // 先取 config（含工具黑名单 disabledTools；旧 default:config 在此惰性迁回扁平 config）
  if (!storage.get(NS_FLAT, FLAT.CONFIG)) storage.set(NS_FLAT, FLAT.CONFIG, cfg);
  // 系统提示单一真相源 = config：若 config 尚无 systemPrompt（首次运行 / 历史存档），用源码种子 SYSTEM_PROMPT 写入 config，
  // 运行期不再读源码常量（orchestrate 等只认 config）。
  if (cfg.systemPrompt === undefined) saveConfig({ systemPrompt: SYSTEM_PROMPT });
  // 一次性迁移：旧 default 命名空间下的键（sessions / baseRequestBody）迁回扁平键（与 config 同策略，兼容历史数据）
  for (const legacy of Object.values(LEGACY)) {
    const v = storage.get(legacy.ns, legacy.key);
    if (v !== undefined) { storage.set(NS_FLAT, legacy.key, v); storage.del(legacy.ns, legacy.key); }
  }
  executor.attachAgent(agent);
  const disabled = new Set(cfg.disabledTools ?? []);
  extraBuiltinTools.push(uiTool); // UI 以 tool 形态加入内置清单（register/unregister 接管挂载/卸载）
  const bootList = [...defaultTools, ...extraBuiltinTools].filter((t) => !disabled.has(t.name)); // 黑名单直接移出名单（文档 §3/§5.2）
  executor.registerAll(bootList); // 拓扑序注册默认工具（已剔除黑名单）
  executor.rehydrateTools(); // 重建启用的自编排工具（拓扑序）
  executor.rehydrateHooks(agent); // 重建用户钩子（热插拔，刷新不丢）
}
init();

// ---- 用户直接调用工具：/tool_name /param value /flag ----

// 解析 /tool_name /param1 value1 /param2 value2 /flag 语法 → { name, args }
// 值支持引号包裹、JSON 对象/数组、布尔、数字；/flag 无值时视为 true
function parseToolCommand(text: string): { name: string; args: Record<string, unknown> } | null {
  const body = text.slice(1).trim();
  const sp = body.search(/\s/);
  const name = sp === -1 ? body : body.slice(0, sp);
  let rest = sp === -1 ? '' : body.slice(sp + 1);

  const args: Record<string, unknown> = {};
  while (rest.trim()) {
    rest = rest.trimStart();
    if (!rest.startsWith('/')) break;
    rest = rest.slice(1);
    const sp2 = rest.search(/\s/);
    if (sp2 === -1) { args[rest] = true; break; } // flag: /verbose → true
    const key = rest.slice(0, sp2);
    rest = rest.slice(sp2 + 1).trimStart();
    // 读值：引号包裹 → 到匹配引号；否则到下一个 /param（空格+/）
    let val: string;
    if (rest[0] === '"' || rest[0] === "'") {
      const q = rest[0];
      const close = rest.indexOf(q, 1);
      val = close === -1 ? rest.slice(1) : rest.slice(1, close);
      rest = close === -1 ? '' : rest.slice(close + 1);
    } else {
      const next = rest.search(/\s\/(?=\S)/);
      if (next === -1) { val = rest; rest = ''; }
      else { val = rest.slice(0, next); rest = rest.slice(next); }
    }
    // 尝试 JSON 解析（对象/数组）
    if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
      try { args[key] = JSON.parse(val); continue; } catch { /* 保持字符串 */ }
    }
    if (val === 'true') args[key] = true;
    else if (val === 'false') args[key] = false;
    else args[key] = val;
  }
  return { name, args };
}

// 执行工具命令（绕过 LLM）：解析 → executor.run → 显示结果
async function handleToolCommand(text: string): Promise<void> {
  const parsed = parseToolCommand(text);
  if (!parsed) { agent.output.append('tool', '⚠️ 无法解析命令'); return; }
  const exists = executor.list(true).some((t) => t.name === parsed.name);
  if (!exists) { agent.output.append('tool', `⚠️ 未找到工具：${parsed.name}`); return; }
  agent.output.append('tool', `⚙ ${parsed.name}: 执行中…`);
  const obs = await executor.run(
    { id: 'cmd-' + Date.now().toString(36), name: parsed.name, args: parsed.args },
    agent,
  );
  // marked 工具返回 HTML，直接渲染；其它工具结果用 textContent 显示原始文本
  if (parsed.name === 'marked') {
    agent.output.setToolHTML(`⚙ ${parsed.name}: ${String(obs)}`);
  } else {
    agent.output.updateLast('tool', `⚙ ${parsed.name}: ${obs}`);
  }
}

// UI 已作为 tool 由 agent.init() 注册（默认启用）：其 register 挂载界面、unregister 卸载并还原 headless。
// 此处仅启动持久化的最小启动器（UI 被禁用后的"重新启用"入口，保证可逆、humane）。
createLauncher();

// 暴露全局单例（标准用户脚本空间：沙箱内 globalThis，便于运行时 / LLM 动态编辑）
(globalThis as unknown as { agent: typeof agent }).agent = agent;

// 仅 dev 分支额外挂到 unsafeWindow，使 DevTools 控制台可直接访问（补偿 userscript 沙箱隔离）；
// 发布分支（main/master 等）一律不挂，避免与页面主世界互相影响。
declare const __BUILD_BRANCH__: string;
if (__BUILD_BRANCH__ === 'dev') {
  const uw = (globalThis as unknown as { unsafeWindow?: typeof globalThis }).unsafeWindow;
  if (uw) (uw as Record<string, unknown>).agent = agent;
}
