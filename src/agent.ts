import { llm, type ChatMessage, type ToolCallLite } from './core/llm';
import { executor, defaultTools, type ToolCall, type ToolDef } from './core/executor';
import { storage } from './core/storage';
import { bus } from './core/bus';
import { ui } from './ui/ui';
import { withHooks } from './core/withHooks';
import { getSystemPrompt, getConfig } from './model/config';

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

export const agent = {
  messages: [] as ChatMessage[], // 已提交给 LLM 的全量上下文
  messageQueue: [] as ChatMessage[], // 待提交的用户/推理轮
  toolCallQueue: [] as ToolCall[], // 待执行的工具调用
  sessionId: '', // 当前会话 id（由 session 工具的 onRegister 生成）
  storage, // 逻辑存储层（命名空间分区），供运行时 / LLM 动态读写与编辑
  llm, executor, bus, // 暴露给 LLM 做自编排：动态注册工具 / 直接推理 / 事件订阅
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
            ui.chat.append('tool', `⚙ ${call.name}: 执行中…`);
            const obs = await executor.run(call, agent);
            agent.messages.push({
              role: 'tool',
              content: obs,
              tool_call_id: call.id,
              name: call.name,
            } as ChatMessage);
            ui.chat.updateLast('tool', `⚙ ${call.name}: ${obs}`);
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
          ui.chat.append('assistant', '');

          // 流式累积（文本逐字更新、工具调用按 index 合并）
          let content = '';
          const acc: Record<number, { id: string; name: string; args: string }> = {};
          for await (const chunk of llm.streamChat({
            messages: agent.messages,
            tools: executor.list(), // 仅非 hidden 工具进 LLM 载荷
          })) {
            if (chunk.delta) {
              content += chunk.delta;
              ui.chat.updateLast('assistant', content);
            }
            if (chunk.toolCall) {
              const i = chunk.toolCall.index ?? 0;
              acc[i] ??= { id: '', name: '', args: '' };
              if (chunk.toolCall.id) acc[i].id = chunk.toolCall.id;
              if (chunk.toolCall.name) acc[i].name = chunk.toolCall.name;
              if (chunk.toolCall.arguments) acc[i].args += chunk.toolCall.arguments;
            }
          }

          const toolCalls: ToolCallLite[] = Object.values(acc).map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: t.args },
          }));

          agent.messages.push({
            role: 'assistant',
            content,
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
      ui.chat.setRunning(false);
    }
  }),

  // 发送用户消息：入队 + 若引擎未跑则启动
  sendMessage: withHooks(async function (text: string) {
    agent.messageQueue.push({ role: 'user', content: text } as ChatMessage);
    ui.chat.append('user', text);
    if (!agent._engineActive) {
      agent._engineActive = true;
      try {
        await agent.engine();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ui.chat.append('tool', `⚠️ ${msg}`);
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

// Agent 类型（供 executor 的 RunCtx/RegisterCtx 使用，类型引用避免运行时循环依赖）
export type Agent = typeof agent;

// 系统提示编排：独立 before 钩子注入（不写死在模块体），保持编排可插拔/可替换
function orchestrateSystemPrompt(): void {
  if (agent.messages.some((m) => m.role === 'system')) return; // 幂等：仅首次注入
  const sys = getSystemPrompt();
  if (sys) agent.messages.unshift({ role: 'system', content: sys } as ChatMessage);
}
agent.sendMessage.beforeExe.push(orchestrateSystemPrompt);

// 运行态钩子：消息处理开始（点击发送那一刻）→ 发送按钮变身停止按钮（用户要求"通过 hook"）
agent.sendMessage.beforeExe.push(() => ui.chat.setRunning(true, agent.chatStop));

// 基本初始化（进工作循环前的一次性 bootstrap，属架构铁律允许的顶层副作用）：
// ① 旧扁平 config → default:config 迁移；② 种子默认配置（无内容也落盘）；
// ③ 绑定 agent 引用；④ 注册默认工具（→ 各 onRegister，含 session 落盘安装）；
// ⑤ 重建持久化的自编排工具（→ onRegister 重建）。
function init(): void {
  storage.migrateFlatToNs('config', 'default', 'config');
  const cfg = getConfig(); // 先取 config（含工具黑名单 disabledTools）
  if (!storage.get('default', 'config')) storage.set('default', 'config', cfg);
  executor.attachAgent(agent);
  const disabled = new Set(cfg.disabledTools ?? []);
  const bootList = defaultTools.filter((t) => !disabled.has(t.name)); // 黑名单直接移出名单（文档 §3/§5.2）
  executor.registerAll(bootList); // 拓扑序注册默认工具（已剔除黑名单）
  executor.rehydrateTools(); // 重建启用的自编排工具（拓扑序）
}
init();

// 挂载 UI（用户消息 → agent.sendMessage）
function mount(): void {
  ui.chat.mount((text) => {
    void agent.sendMessage(text);
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}

// 暴露全局单例：便于运行时 / LLM 动态编辑（呼应"全局单例 + 弱类型动态编辑"）
(globalThis as unknown as { agent: typeof agent }).agent = agent;

// 暴露到页面主世界，使 DevTools 控制台可直接访问（补偿 userscript 沙箱隔离）
const uw = (globalThis as unknown as { unsafeWindow?: typeof globalThis }).unsafeWindow;
if (uw) (uw as Record<string, unknown>).agent = agent;
