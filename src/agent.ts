import { llm, ReActLoop, genMsgId, type ChatMessage, type ToolCallLite, type ChatResult } from './core/react_loop';
import { executor, defaultTools, extraBuiltinTools, type ToolCall, type ToolDef, b64Decode } from './core/executor';
import { storage } from './core/storage';
import { LEGACY } from './core/storage';
import { ui } from './ui/ui';
import { DEFAULT_CONFIG, SYSTEM_PROMPT, normalizeConfig, type AppConfig } from './model/config';
import { rehydrateHooks, hooksTool } from './tools/hooks';
import { gmStorageTool } from './tools/gm_storage';

// 把流式累积的 ToolCallLite 转成 executor 的 ToolCall（参数 JSON.parse）。
// type 显式置 'function'，与 OpenAI tool call 格式对齐。
function toToolCall(t: ToolCallLite): ToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = t.function.arguments ? JSON.parse(t.function.arguments) : {};
  } catch {
    args = { raw: t.function.arguments };
  }
  return { id: t.id, type: 'function', name: t.function.name, args };
}

// strict 模式合规归一（仅在请求边界做，非 tool 内部校验）：
// 确保 object schema 带 additionalProperties:false，且 required 含全部属性键（OpenAI structured outputs 硬要求）。
// 让内置与自编排（tool_manager 创建）工具的 schema 都能安全进入 strict:true，不依赖作者手写合规。
function ensureStrictSchema(s: unknown): Record<string, unknown> {
  if (!s || typeof s !== 'object') return s as Record<string, unknown>;
  const obj = s as Record<string, unknown>;
  if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
    const props = obj.properties as Record<string, unknown>;
    const keys = Object.keys(props);
    // 仅保证 additionalProperties:false（防模型把未知字段塞进 args）；
    // required 尊重工具自身声明——不强制补全为全部属性（action 类工具只列通用必填，
    // 其余参数按 action 由 tool.call 内部自查；详见 docs/ARCHITECTURE.md §8）。
    // strict 是否启用由调用方依"required 是否覆盖全部 properties"动态判定。
    const out: Record<string, unknown> = {
      ...obj,
      additionalProperties: false,
      properties: Object.fromEntries(keys.map((k) => [k, ensureStrictSchema(props[k])])),
    };
    if (!Array.isArray(obj.required)) out.required = [];
    return out;
  }
  return obj;
}

// strict 模式（OpenAI structured outputs）要求 required 覆盖全部 properties。
// 故：仅当工具的 required 已列全属性时才发 strict:true；否则发 strict:false（允许可选参数，
// 由 tool.call 内部按 action 自查）。additionalProperties:false 始终经 ensureStrictSchema 保证。
function isFullyRequired(schema: Record<string, unknown>): boolean {
  const props = schema.properties as Record<string, unknown> | undefined;
  const keys = props ? Object.keys(props) : [];
  const req = (schema.required as string[] | undefined) ?? [];
  return keys.length > 0 && keys.every((k) => req.includes(k));
}

// 输出槽（核心契约）：引擎只写这个槽，绝不直连 UI 模块。默认 headless 空实现——
// 核心可在无 DOM / 无 UI 环境运行；UI 挂载时把 agent.output 替换为 DOM 实现（ui.chat）。
// append 返回气泡稳定 id（mid）；update/finalize/setToolHTML 均按 mid 寻址，不依赖可变 last 引用。
interface OutputSink {
  append(role: string, text: string, id?: string): string;
  update(mid: string, role: string, text: string, reasoning?: string): void;
  finalize(mid: string, role: string, text: string, reasoning?: string): void;
  setToolHTML(mid: string, html: string): void;
  setRunning(running: boolean, onStop?: () => void): void;
}
const headlessSink: OutputSink = {
  append: () => '', update() {}, finalize() {}, setToolHTML() {}, setRunning() {},
};

export const agent = {
  // 配置：作为 storage 内的一个值（key='config'）暴露，读写均经 storage（落盘由 gm_storage hook 透明完成）。
  // 因此 config 不再有独立持久化路径——config.ts 只保留纯数据定义（类型 / 种子值 / 辅助函数），存取统一走 storage。
  get config(): AppConfig {
    return (agent.storage.get('config') as AppConfig) ?? ({ ...DEFAULT_CONFIG } as AppConfig);
  },
  set config(v: AppConfig) {
    agent.storage.set('config', v);
  },
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

  // 引擎：消息队列驱动（由 hooks 工具在注册时经 wrapHook 包裹，before 钩子管运行态）。
  // ReAct 循环已收口到 react_loop.ReActLoop：agent 只在 onChunk 做流式 UI、在 executeTool 做工具执行（侵入式改造），
  // 不再手写 SSE 解析与"chat→工具→再chat"循环。
  engine: async function () {
    try {
      while (agent.messageQueue.length) {
        // 推进一条消息：入历史，弹出队首（user 气泡已由 sendMessage 渲染，不重复 append）
        const msg = agent.messageQueue[0];
        if (!msg.id) msg.id = genMsgId(); // 用户消息也带稳定 id，与助手/工具消息一致
        agent.messages.push(msg);
        agent.messageQueue.shift();

        // 可用工具（仅非 hidden 工具进 LLM 载荷）；映射为 API 的 ApiTool 形态（严格对齐 OpenAI 工具标准）
        const tools = executor.list().map((t) => {
          const schema = ensureStrictSchema(t.parameters);
          const strict = isFullyRequired(schema);
          return {
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              strict,
              parameters: schema,
            },
          };
        });
        const cfg = agent.config;

        // 按 ReAct 轮次（turn）分轮建气泡：工具调用轮与最终回答轮各占一条，
        // DOM 顺序天然正确（A 轮 → 工具气泡 → B 轮），且各轮内容独立缓冲、互不覆盖
        // （此前共享 lastContent 单一缓冲导致首轮被覆盖 + 顺序错乱）。
        // 轮次切换时定稿上一轮气泡、新开本轮；气泡 id 用 ReActLoop 下发的 c.mid，与助手消息 id 对齐（每消息一个 id）。
        let lastTurn = -1;
        let turnMid: string | null = null;
        let turnContent = '', turnReasoning = '';
        const seenToolCalls: ToolCallLite[] = [];

        // ReActLoop 收口"chat → 执行工具 → 再 chat"循环；agent 仅在 onChunk 做 UI、在 executeTool 做工具执行。
        const it = ReActLoop({
          messages: agent.messages,
          tools,
          systemPrompt: cfg.systemPrompt ?? '',
          model: cfg.model,
          deps: { apiKey: cfg.apiKey, baseURL: cfg.baseURL },
          // 思考强度：仅当配置时以 OpenAI 标准字段名 reasoning_effort 注入请求体（非推理模型不支持，故默认不注入）
          extraBody: cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : undefined,
          onChunk: (c) => {
            if (c.turn == null) return; // done 等无轮次元数据的分片忽略
            // 轮次切换：定稿上一轮气泡（若已建），为本轮开新气泡
            if (c.turn !== lastTurn) {
              if (turnMid != null) {
                // 极端兜底：定稿抛错则新建一条气泡保证可见（绝不静默丢失）
                try { agent.output.finalize(turnMid, 'assistant', turnContent, turnReasoning || undefined); }
                catch (e) { console.warn('[MiniAgent.Agent] finalize 异常，尝试 fallback 渲染:', e); agent.output.append('assistant', turnContent || '(渲染异常)'); }
              }
              // 始终经 append 创建本轮气泡（c.mid 作为显式 id，与助手消息 id 对齐）。
              // 之前误用 c.mid ?? append() 导致：有 mid 时跳过 append→bubblesById 无此 key→后续 update 全部找不到气泡。
              turnMid = agent.output.append('assistant', '', c.mid);
              turnContent = '';
              turnReasoning = '';
              lastTurn = c.turn;
            }
            if (c.toolCall) seenToolCalls.push({ id: c.toolCall.id ?? '', type: 'function', function: { name: c.toolCall.name ?? '', arguments: c.toolCall.arguments ?? '' } });
            const m = turnMid; // 收窄：轮次切换时已确保非 null
            if (m && c.delta) { turnContent += c.delta; agent.output.update(m, 'assistant', turnContent, turnReasoning); }
            if (m && c.reasoning) { turnReasoning += c.reasoning; agent.output.update(m, 'assistant', turnContent, turnReasoning); }
          },
          executeTool: async (calls) => {
            const msgs: ChatMessage[] = [];
            for (const call of calls) {
              const tc = toToolCall(call);
              const tmid = agent.output.append('tool', `⚙ ${tc.name}: 执行中…`);
              const obs = await executor.run(tc, agent);
              msgs.push({ role: 'tool', content: obs, tool_call_id: tc.id, name: tc.name } as ChatMessage);
              agent.output.update(tmid, 'tool', `⚙ ${tc.name}: ${obs}`);
            }
            return msgs;
          },
        });
        // 手动驱动：分片已在 onChunk 处理，这里只捕获 return 的 ChatResult
        let r = await it.next();
        while (!r.done) r = await it.next();
        const final = (r.value ?? { content: '', toolCalls: [] }) as ChatResult;

        // 定稿最后一轮气泡（找不到/脱离 DOM 仅告警，不静默指向错误气泡）；极端兜底保证可见。
        if (turnMid != null) {
          try { agent.output.finalize(turnMid, 'assistant', turnContent, turnReasoning || undefined); }
          catch (e) { console.warn('[MiniAgent.Agent] finalize 异常，尝试 fallback 渲染:', e); agent.output.append('assistant', turnContent || '(渲染异常)'); }
        }

        // 日志：LLM 返回摘要（与 react_loop.ts 的"完成"日志呼应，便于交叉对照）
        console.log('[MiniAgent.Agent] 📬 LLM 返回', {
          turns: lastTurn + 1,
          contentLen: final.content.length,
          seenToolCalls: seenToolCalls.length,
        });
        if (seenToolCalls.length) {
          console.log('[MiniAgent.Agent] 🔧 工具调用', seenToolCalls.map((t) => ({ name: t.function.name, args: t.function.arguments })));
        }
      }
    } finally {
      // 覆盖成功/异常/取消：复位运行态
      agent.output.setRunning(false);
    }
  },

  // 发送用户消息：入队 + 若引擎未跑则启动
  sendMessage: async function (text: string) {
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
  },
  // 验收别名：控制台可经 agent.chat.sendMessage('...') 直接发消息并看到工具调用结果
  get chat() {
    return { sendMessage: (text: string) => agent.sendMessage(text) };
  },
};

// 迟绑 thisArg（engine / sendMessage 体内 this 指向 agent）已移至 hooks 工具的 register 统一处理。

// Agent 类型（供 executor 的 RunCtx/RegisterCtx 使用，类型引用避免运行时循环依赖）
export type Agent = typeof agent;

// === 钩子安装现已统一收口到各工具的 register 环节（钩子功能独立，见 src/tools/hooks.ts）===
//  - 系统提示注入：不再经钩子——engine 构建 chat 请求体时直接把 config.systemPrompt 预置为 messages[0]
//    （单一真相源=config，改 config 即下次请求生效）。
//  - 运行态切换（发送按钮→停止按钮）：暂注释，待 UI 独立为 tool 后由其 register 安装（见下方 TODO）。
// 核心不再在模块体里裸 push 钩子（呼应"核心不 import UI"铁律，运行态行为由 UI 工具自挂载）。

// TODO（UI 独立后）：把运行态切换钩子改为 ui 工具的 register 安装，示例：
//   const setRunningHook = () => agent.output.setRunning(true, agent.chatStop);
//   installHook('sendMessage', 'before', setRunningHook, { id: 'sys-running-toggle', name: '运行态切换', toolName: 'ui', core: true });
// （当前注释掉：避免核心直接引用 UI 形状；UI 作为 tool 挂载时自行接管运行态反馈）

// 基本初始化（进工作循环前的一次性 bootstrap，属架构铁律允许的顶层副作用）：
// ① 读取扁平 config（缺失则迁回旧 default:config）并种子默认配置（落盘为扁平 config）；
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
  parameters: {},
  register: async (_ctx) => {
    agent.output = ui.chat; // 输出槽接管（agent.output 默认 headless 空实现）
    agent.extensions.set('ui', ui.chat); // UI 渲染能力（ui.chat.finalize 直接用 renderMarkdown；marked 已成为独立工具，不经此接管）
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
      if (!agent.config.apiKey) {
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
  executor.attachAgent(agent);
  storage.load(); // 启动期把 GM_* 镜像进内存（幂等；须在任意 storage 读写前）
  // 先注册核心基础设施：hooks（捕获宿主引用）+ gm_storage（安装落盘钩子 storageSet/storageDelete）。
  // 二者为持久化与引擎钩子的根基，不受黑名单约束——须先于下方写 config，确保落盘机制就绪。
  executor.registerAll([hooksTool, gmStorageTool]);
  // 读取扁平 config（优先）；缺失则惰性迁回旧 default:config（兼容历史数据）
  let raw = storage.get<Partial<AppConfig>>('config');
  if (!raw) {
    const legacyCfg = storage.get<Partial<AppConfig>>(LEGACY.CONFIG.ns, LEGACY.CONFIG.key);
    if (legacyCfg) { raw = legacyCfg; storage.del(LEGACY.CONFIG.ns, LEGACY.CONFIG.key); }
  }
  const cfg = normalizeConfig(raw);
  // 系统提示种子：首次运行 / 历史存档无 systemPrompt → 用源码种子 SYSTEM_PROMPT
  if (cfg.systemPrompt === undefined) cfg.systemPrompt = SYSTEM_PROMPT;
  agent.config = cfg; // 经 gm_storage 落盘钩子写 GM（无需显式 storage.set）
  // 一次性迁移：旧 default 命名空间下其余键（sessions）迁回扁平键
  for (const legacy of Object.values(LEGACY)) {
    if (legacy.key === LEGACY.CONFIG.key) continue; // config 已在上合并
    const v = storage.get(legacy.ns, legacy.key);
    if (v !== undefined) { storage.set(legacy.key, v); storage.del(legacy.ns, legacy.key); }
  }
  const disabled = new Set(cfg.disabledTools ?? []);
  extraBuiltinTools.push(uiTool); // UI 以 tool 形态加入内置清单（register/unregister 接管挂载/卸载）
  // 注册其余默认工具（排除已注册的核心工具），剔除黑名单（文档 §3/§5.2）
  const restTools = [...defaultTools, ...extraBuiltinTools].filter(
    (t) => !disabled.has(t.name) && t.name !== 'hooks' && t.name !== 'gm_storage',
  );
  executor.registerAll(restTools); // 拓扑序注册默认工具（已剔除黑名单）
  executor.rehydrateTools(); // 重建启用的自编排工具（拓扑序）
  rehydrateHooks(agent); // 重建用户钩子（热插拔，刷新不丢）
}
init();

// ---- 用户直接调用工具：/tool_name /param value /flag ----

// 解析 /tool_name /param1 value1 /param2 value2 /flag 语法 → { name, args }
// 值支持引号包裹、JSON 对象/数组、布尔、数字；/flag 无值时视为 true；
// /code 支持 b64: 前缀（经 b64Decode 解码），用于含任意字符的安全传输，彻底解耦"读到行尾"脆弱约定。
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
    // 13) /code 经 base64 编码（b64: 前缀）导出：优先识别并解码，彻底解耦"读到行尾"脆弱约定；
    // 无前缀（手动输入）则回退到下方原逻辑读到行尾，向后兼容。
    if (key === 'code' && val.startsWith('b64:')) {
      try { args[key] = b64Decode(val.slice(4)); continue; } catch { /* 解码失败则保留原始值 */ }
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
  const tmid = agent.output.append('tool', `⚙ ${parsed.name}: 执行中…`);
  const obs = await executor.run(
    { id: 'cmd-' + Date.now().toString(36), type: 'function', name: parsed.name, args: parsed.args },
    agent,
  );
  // marked 工具返回 HTML，直接渲染；其它工具结果用 textContent 显示原始文本
  if (parsed.name === 'marked') {
    agent.output.setToolHTML(tmid, `⚙ ${parsed.name}: ${String(obs)}`);
  } else {
    agent.output.update(tmid, 'tool', `⚙ ${parsed.name}: ${obs}`);
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
