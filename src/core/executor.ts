import { storage } from './storage';
import { ui } from '../ui/ui';
import { REQUIRE_CODE_APPROVAL } from '../model/config';
import { withHooks, type HookedFunction } from './withHooks';

// executor 的结构化视图（避免 typeof executor 前向引用）
export interface ExecutorLike {
  attachAgent(a: AgentLike): void;
  register(tool: ToolDef): void;
  unregister(name: string): void;
  list(includeHidden?: boolean): ToolDef[];
  run(call: ToolCall, agentArg?: AgentLike): Promise<string>;
}

// agent 的结构化视图：executor 仅依赖这个最小接口（不 import agent 模块，消除循环依赖）。
// 实际传入的是全局 agent 单例（Agent = typeof agent），结构超集，可赋值。
export interface AgentLike {
  messages: any[];
  sessionId: string;
  storage: typeof storage;
  llm: any;
  executor: ExecutorLike;
  bus: any;
  sendMessage: ((text: string) => Promise<void>) & HookedFunction;
}

// 工具运行时上下文：底层能力注入为 ctx，避免工具依赖未注入的全局变量。
export interface RunCtx {
  storage: typeof storage;
  executor: ExecutorLike;
  agent: AgentLike;
  console: Console;
}

// 工具注册上下文：onRegister / onUnregister 安装或还原编排。
export interface RegisterCtx {
  storage: typeof storage;
  executor: ExecutorLike;
  agent: AgentLike;
}

// 可被 LLM 调用的工具定义（OpenAI tool schema 子集）+ 编排钩子
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  hidden?: boolean; // 系统/内部原语：不进常规 tools 载荷，但常驻 list（经 tool_list 可见）
  run: (args: Record<string, unknown>, ctx: RunCtx) => Promise<string> | string;
  onRegister?: (ctx: RegisterCtx) => void | Promise<void>; // 安装 / 重建入口
  onUnregister?: (ctx: RegisterCtx) => void | Promise<void>; // 卸载 / 还原入口
}

// 自编排工具的持久化描述符（可 JSON 序列化）
export interface ToolDesc {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  code: string; // run 源码：(args, ctx) => string
  onRegister?: string; // 可选：安装源码 (ctx) => void
  hidden?: boolean;
}

// LLM 实际发出的调用（tool_calls 解析后的产物）
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

const registry = new Map<string, ToolDef>();
let _agent: AgentLike | null = null;

// 把源码串编译成函数（run / onRegister 共用沙箱编译）。剥离末尾分号避免语法错误。
function compileFn(code: string): (...a: any[]) => any {
  const c = code.trim().replace(/;\s*$/, '');
  const fn = new Function('"use strict"; return (' + c + ');');
  return fn() as (...a: any[]) => any;
}

// 由持久化描述符构造最小 ToolDef：run 永远由 code 编译（重建即重编译）；onRegister 可选。
export function buildToolFromDesc(desc: ToolDesc): ToolDef {
  const run = compileFn(desc.code) as (args: Record<string, unknown>, ctx: RunCtx) => string;
  const tool: ToolDef = {
    name: desc.name,
    description: desc.description,
    parameters: desc.parameters,
    hidden: !!desc.hidden,
    run,
  };
  if (desc.onRegister) {
    tool.onRegister = compileFn(desc.onRegister) as (ctx: RegisterCtx) => void;
  }
  return tool;
}

// 解析 code_run 要执行的代码：优先 code:<name>，否则直接用 args.code
function getCode(args: Record<string, unknown>, ctx: RunCtx): string {
  const name = String(args.name ?? '');
  const direct = String(args.code ?? '');
  if (name) return ctx.storage.get<string>('code', name) ?? '';
  return direct;
}

export const executor = {
  // 绑定 agent 引用（init 时调用一次），供 register/unregister 的 onRegister 构建 ctx。
  attachAgent(a: AgentLike): void {
    _agent = a;
  },

  // 注册：写表 → onRegister（注册即"安装/重建"）。同名注册先 onUnregister 旧的再 onRegister 新的。
  register(tool: ToolDef): void {
    const existing = registry.get(tool.name);
    if (existing?.onUnregister && _agent) {
      try {
        existing.onUnregister({ storage, executor, agent: _agent });
      } catch (e) {
        console.warn('[MiniAgent] onUnregister 失败:', tool.name, e);
      }
    }
    registry.set(tool.name, tool);
    if (tool.onRegister && _agent) {
      try {
        tool.onRegister({ storage, executor, agent: _agent });
      } catch (e) {
        console.warn('[MiniAgent] onRegister 失败:', tool.name, e);
      }
    }
  },

  // 注销：onUnregister（还原编排）→ 删表
  unregister(name: string): void {
    const tool = registry.get(name);
    if (!tool) return;
    if (tool.onUnregister && _agent) {
      try {
        tool.onUnregister({ storage, executor, agent: _agent });
      } catch (e) {
        console.warn('[MiniAgent] onUnregister 失败:', name, e);
      }
    }
    registry.delete(name);
  },

  // 列举：默认只返回非隐藏（喂给 LLM）；includeHidden=true 返回全量（tool_list / 系统提示用）
  list(includeHidden = false): ToolDef[] {
    const all = [...registry.values()];
    return includeHidden ? all : all.filter((t) => !t.hidden);
  },

  // 执行一个工具调用，返回"观察结果"文本，回灌给 LLM 作为 tool 消息。
  // code_run 确认闸在 base 内（自检 name → 需要时 await ui.requestApproval）。
  // ctx.agent 由调用方（engine）注入，避免 executor 依赖 agent。
  run: withHooks(async (call: ToolCall, agentArg?: AgentLike): Promise<string> => {
    const tool = registry.get(call.name);
    if (!tool) return `未知工具: ${call.name}`;

    // 危险工具确认闸（放 base，可热插拔把控流程）
    if (call.name === 'code_run') {
      const code = getCode(call.args, { storage, executor, agent: agentArg ?? _agent!, console });
      if (!code) return '没有可执行的代码';
      if (REQUIRE_CODE_APPROVAL) {
        const ok = await ui.requestApproval({ name: call.name, code });
        if (!ok) return '用户拒绝了代码执行';
      }
    }

    const ctx: RunCtx = { storage, executor, agent: agentArg ?? _agent!, console };
    try {
      const result = await tool.run(call.args ?? {}, ctx);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e) {
      return `工具执行错误: ${e instanceof Error ? e.message : String(e)}`;
    }
  }),

  // 批量执行（工具循环用）：依次 run，返回各观察结果
  runLoop: withHooks(async (calls: ToolCall[], agentArg?: AgentLike): Promise<string[]> => {
    const results: string[] = [];
    for (const call of calls) {
      results.push(await executor.run(call, agentArg));
    }
    return results;
  }),

  // 重建自编排工具：遍历 tools 命名空间下的描述符 → 构造 ToolDef → register（→ onRegister 重建）。
  // 没有独立的 rehydrate 例程：重建逻辑天然写在各工具的 onRegister 里，注册即重建。
  rehydrateTools(): void {
    for (const name of storage.keys('tools')) {
      const desc = storage.get<ToolDesc>('tools', name);
      if (!desc) continue;
      try {
        executor.register(buildToolFromDesc(desc));
      } catch (e) {
        console.warn('[MiniAgent] 重建工具失败:', name, e);
      }
    }
  },
};

// ---- 会话 id 生成（crypto.randomUUID 优先，退化到时间戳+随机）----
function genSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* secure context 不可用，走退化方案 */
  }
  return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---- 预置默认工具「定义」：由 agent.init() 统一注册（本模块不写死 register 副作用）----
// 设计约定：工具清单属于"业务编排"，由顶层 init 一次性注册，保持可插拔 / 可重建。

// 1) 读取存储（默认 memory 命名空间，可指定其它）
const storageGetTool: ToolDef = {
  name: 'storage_get',
  description: '读取持久存储中此前写入的键值（默认 memory 命名空间，可指定其它命名空间）。用于回忆记忆、配置、历史。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '键名' },
      ns: { type: 'string', description: '可选命名空间，默认 memory' },
    },
    required: ['key'],
  },
  run: (args, ctx) => {
    const key = String(args.key ?? '');
    if (!key) return '参数 key 缺失';
    const ns = String(args.ns ?? 'memory');
    const v = ctx.storage.get(ns, key);
    return v === undefined ? '(无此键)' : JSON.stringify(v);
  },
};

// 2) 写入存储（默认 memory 命名空间，可指定其它）
const storageSetTool: ToolDef = {
  name: 'storage_set',
  description: '写入一个键值到持久存储（默认 memory 命名空间）。可用于保存记忆、配置、偏好。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '键名' },
      value: { type: 'string', description: '要保存的值（建议 JSON 字符串）' },
      ns: { type: 'string', description: '可选命名空间，默认 memory' },
    },
    required: ['key', 'value'],
  },
  run: (args, ctx) => {
    const key = String(args.key ?? '');
    if (!key) return '参数 key 缺失';
    const ns = String(args.ns ?? 'memory');
    ctx.storage.set(ns, key, args.value);
    return `已保存 ${ns}:${key}`;
  },
};

// 3) 生成代码：存到 code 命名空间（不执行）
const codeGenTool: ToolDef = {
  name: 'code_gen',
  description: '把一段 JS 代码以给定名称保存到 code 命名空间，供后续 code_run 执行。不会立即运行。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '代码片段名称，存储键 code:<name>' },
      code: { type: 'string', description: 'JS 源码，可调用 ctx.storage / ctx.console 等沙箱对象' },
    },
    required: ['name', 'code'],
  },
  run: (args, ctx) => {
    const name = String(args.name ?? '');
    const code = String(args.code ?? '');
    if (!name) return '参数 name 缺失';
    ctx.storage.set('code', name, code);
    return `已生成代码 ${name}（未执行）`;
  },
};

// 4) 运行代码：自我开发执行入口，经人工确认闸（executor.run base 内）
const codeRunTool: ToolDef = {
  name: 'code_run',
  description: '执行先前 code_gen 保存（或直接传入）的 JS 代码。危险操作，执行前会请求用户确认。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '可选：执行 code:<name> 中保存的代码' },
      code: { type: 'string', description: '可选：直接传入要执行的 JS 源码' },
    },
  },
  run: (args, ctx) => {
    const code = getCode(args, ctx);
    if (!code) return '没有可执行的代码';
    try {
      const fn = new Function('ctx', `"use strict";\n${code}`);
      const result = fn(ctx);
      return `执行成功 → ${result === undefined ? '(无返回值)' : JSON.stringify(result)}`;
    } catch (e) {
      return `执行异常: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

// 5) 注册自编排工具（持久化 + 注册 → onRegister 重建）
const toolCreateTool: ToolDef = {
  name: 'tool_create',
  description:
    '注册一个新工具（自编排）：持久化到 tools 命名空间，重载后自动重建。参数 code 为 run 源码 (args, ctx) => string；onRegister 可选为安装源码 (ctx) => void。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '工具名（唯一）' },
      description: { type: 'string', description: '工具说明' },
      parameters: { type: 'object', description: 'JSON Schema 参数声明' },
      code: { type: 'string', description: 'run 源码：(args, ctx) => string' },
      onRegister: { type: 'string', description: '可选：安装/重建源码 (ctx) => void' },
      hidden: { type: 'boolean', description: '可选：是否隐藏（不进常规工具载荷）' },
    },
    required: ['name', 'description', 'parameters', 'code'],
  },
  run: (args, ctx) => {
    const name = String(args.name ?? '');
    if (!name) return '参数 name 缺失';
    const desc: ToolDesc = {
      name,
      description: String(args.description ?? ''),
      parameters: (args.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
      code: String(args.code ?? ''),
      onRegister: args.onRegister ? String(args.onRegister) : undefined,
      hidden: Boolean(args.hidden ?? false),
    };
    let tool: ToolDef;
    try {
      tool = buildToolFromDesc(desc);
    } catch (e) {
      return `工具代码编译失败: ${e instanceof Error ? e.message : String(e)}`;
    }
    ctx.storage.set('tools', name, desc); // 持久化
    ctx.executor.register(tool); // 注册 → onRegister 安装
    return `已创建工具 ${name}（已持久化 + 注册）`;
  },
};

// 6) 删除自编排工具（移除持久化 + 注销 → onUnregister 还原）
const toolRemoveTool: ToolDef = {
  name: 'tool_remove',
  description: '删除一个自编排工具：从 tools 命名空间移除并注销（触发其 onUnregister 还原编排）。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '要删除的工具名' } },
    required: ['name'],
  },
  run: (args, ctx) => {
    const name = String(args.name ?? '');
    if (!name) return '参数 name 缺失';
    ctx.storage.del('tools', name);
    ctx.executor.unregister(name);
    return `已移除工具 ${name}`;
  },
};

// 7) 系统编排发送原语（隐藏）：包装 agent.sendMessage
const orchestrateSendTool: ToolDef = {
  name: 'orchestrate_send',
  hidden: true,
  description:
    '系统编排发送原语：把文本作为用户消息送入工作循环并触发推理。正常对话无需调用；研究自我组织时它代表"驱动循环"这一系统原语。',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要送入循环的用户文本' } },
    required: ['text'],
  },
  run: (args, ctx) => {
    ctx.agent.sendMessage(String(args.text ?? ''));
    return '已送入编排循环';
  },
};

// 8) 枚举全量工具（含隐藏）供自组织研究
const toolListTool: ToolDef = {
  name: 'tool_list',
  description: '枚举当前所有已注册工具（含隐藏的系统原语），供研究自我组织时查看完整能力面。',
  parameters: { type: 'object', properties: {} },
  run: (_args, ctx) => {
    const all = ctx.executor.list(true);
    return JSON.stringify(all.map((t) => ({ name: t.name, description: t.description, hidden: !!t.hidden })));
  },
};

// 9) 会话管理：注册后自动把对话消息与工具调用落盘到 session 命名空间（session:<id>）
//    onRegister = 安装/重建入口：生成 sessionId、初始化会话记录、写 default:sessions 索引、
//    并向 agent.sendMessage 挂载 afterExe 钩子，每次对话轮结束后自动落盘。
//    切换会话 / 会话重建留待后续（用户明确"再说"）。
const sessionTool: ToolDef = {
  name: 'session',
  description:
    '会话管理：注册后自动把对话消息与工具调用落盘到 session 命名空间（session:<id>），并在 default:sessions 建索引。可查询当前会话信息。切换会话与重建留待后续。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['info', 'save'],
        description: 'info=查看当前会话信息（默认）；save=立即落盘一次',
      },
    },
  },
  onRegister: (ctx) => {
    const id = genSessionId();
    ctx.agent.sessionId = id;
    // 初始化会话记录并落盘（消息/工具调用均在 messages 数组内，一并持久化）
    const sess = { id, createdAt: Date.now(), messages: [...ctx.agent.messages] };
    ctx.storage.set('session', id, sess);
    // 写入会话索引 default:sessions
    const idx = ctx.storage.get<string[]>('default', 'sessions') ?? [];
    if (!idx.includes(id)) {
      idx.push(id);
      ctx.storage.set('default', 'sessions', idx);
    }
    // 安装自动落盘：每次 sendMessage 完成后把消息/工具调用写盘
    ctx.agent.sendMessage.afterExe.push(() => {
      const cur = ctx.storage.get('session', id) ?? { id, createdAt: Date.now(), messages: [] };
      ctx.storage.set('session', id, { ...cur, messages: [...ctx.agent.messages] });
    });
  },
  run: (args, ctx) => {
    const id = ctx.agent.sessionId;
    if (!id) return '会话未初始化';
    const action = String(args.action ?? 'info');
    if (action === 'save') {
      const cur = ctx.storage.get('session', id) ?? { id, createdAt: Date.now(), messages: [] };
      ctx.storage.set('session', id, { ...cur, messages: [...ctx.agent.messages] });
      return `已落盘会话 ${id}（${ctx.agent.messages.length} 条消息）`;
    }
    const stored = ctx.storage.get('session', id);
    return JSON.stringify({ id, messageCount: ctx.agent.messages.length, persisted: !!stored });
  },
};

// 默认工具清单（统一能力面）：领域工具 + 自开发工具 + 系统编排原语。
// 全部由 agent.init() 注册；orchestrate_send 标 hidden 不进 LLM 日常载荷。
export const defaultTools: ToolDef[] = [
  storageGetTool,
  storageSetTool,
  codeGenTool,
  codeRunTool,
  toolCreateTool,
  toolRemoveTool,
  orchestrateSendTool,
  toolListTool,
  sessionTool,
];
