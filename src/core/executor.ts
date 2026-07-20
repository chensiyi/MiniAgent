import { storage } from './storage';
import { ui } from '../ui/ui';
import { REQUIRE_CODE_APPROVAL, APPROVAL_RISK_LEVEL, riskAtLeast, getConfig, saveConfig } from '../model/config';
import { withHooks, type HookedFunction } from './withHooks';

// executor 的结构化视图（避免 typeof executor 前向引用）
export interface ExecutorLike {
  attachAgent(a: AgentLike): void;
  register(tool: ToolDef): boolean;
  unregister(name: string): void;
  registerAll(tools: ToolDef[]): { registered: string[]; rejected: string[] };
  list(includeAll?: boolean): ToolDef[];
  setEnabled(name: string, enabled: boolean): void;
  allToolStates(): { name: string; author?: string; enabled: boolean; builtin: boolean; description?: string }[];
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
  tools: Map<string, ToolDef>; // 按名挂载的权威表（文档 §5.2）
  sendMessage: ((text: string) => Promise<void>) & HookedFunction;
}

// 工具运行时上下文：底层能力注入为 ctx，避免工具依赖未注入的全局变量。
export interface RunCtx {
  storage: typeof storage;
  executor: ExecutorLike;
  agent: AgentLike;
  this: AgentLike; // 注册器（Agent 自身）；工具可经 this.<name> 取其它已挂载工具
  console: Console; // 沙箱打印（ctx.console）
}

// 工具注册上下文：register/unregister 安装或还原编排，并注入 this(=Agent)（文档 §5.1）。
export interface RegisterCtx {
  storage: typeof storage;
  executor: ExecutorLike;
  agent: AgentLike;
  this: AgentLike;
}

// 依赖引用（文档 §5/§8）：唯一识别标识 = name + author
export interface DepRef {
  name: string;
  author?: string;
  version?: string;
}

// 可被 LLM 调用的工具定义（文档 §8 工具契约）
export interface ToolDef {
  name: string;
  author?: string; // 唯一标识组成（与 name 组合）
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema（文档称 inputSchema；校验 + 防注入）
  deps?: DepRef[]; // 前置依赖：按 name 匹配；author 不符→警告可继续（§5）
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'; // 高危走确定性确认（§6/§9；阶段2接线）
  call?: (args: Record<string, unknown>, ctx: RunCtx) => Promise<string> | string; // 执行入口；有 call 才进 LLM 清单（§7）
  register?: (ctx: RegisterCtx) => void | Promise<void>; // 安装 / 重建入口（文档 register(ctx)）
  unregister?: (ctx: RegisterCtx) => void | Promise<void>; // 卸载 / 还原入口
}

// 自编排工具的持久化描述符（可 JSON 序列化；tools 命名空间为真相源）
export interface ToolDesc {
  name: string;
  author?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deps?: DepRef[];
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  code: string; // call 源码：(args, ctx) => string
  register?: string; // 可选：安装源码 (ctx) => void
  unregister?: string; // 可选：卸载源码 (ctx) => void
  enabled?: boolean; // 启停状态（§3：关闭项留 ns、不注册）
}

// LLM 实际发出的调用（tool_calls 解析后的产物）
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// agent 上的保留属性名：挂载 agent[name] 时跳过，避免覆盖核心方法/状态
const RESERVED = new Set<string>([
  'messages', 'messageQueue', 'toolCallQueue', 'sessionId', 'storage', 'llm',
  'executor', 'bus', '_engineActive', 'isRunning', 'chatStop', 'engine',
  'sendMessage', 'chat', 'tools', 'orchestrateSystemPrompt',
]);

const registry = new Map<string, ToolDef>();
let _agent: AgentLike | null = null;

// 把源码串编译成函数（call / register / unregister 共用沙箱编译）。剥离末尾分号避免语法错误。
function compileFn(code: string): (...a: any[]) => any {
  const c = code.trim().replace(/;\s*$/, '');
  const fn = new Function('"use strict"; return (' + c + ');');
  return fn() as (...a: any[]) => any;
}

// 由持久化描述符构造最小 ToolDef：call 永远由 code 编译（重建即重编译）；register/unregister 可选。
export function buildToolFromDesc(desc: ToolDesc): ToolDef {
  const call = compileFn(desc.code) as (args: Record<string, unknown>, ctx: RunCtx) => string;
  const tool: ToolDef = {
    name: desc.name,
    author: desc.author,
    description: desc.description,
    inputSchema: desc.inputSchema,
    deps: desc.deps,
    riskLevel: desc.riskLevel,
    call,
  };
  if (desc.register) tool.register = compileFn(desc.register) as (ctx: RegisterCtx) => void;
  if (desc.unregister) tool.unregister = compileFn(desc.unregister) as (ctx: RegisterCtx) => void;
  return tool;
}

// 依赖校验（按 name 匹配；缺失→拒绝；author 不符→收集警告但可继续，§5）
function checkDeps(tool: ToolDef): { ok: boolean; warns: string[] } {
  const warns: string[] = [];
  for (const dep of tool.deps ?? []) {
    const dt = registry.get(dep.name);
    if (!dt) return { ok: false, warns }; // 依赖未就绪 → 拒绝
    if (dep.author && dt.author && dt.author !== dep.author) {
      warns.push(`依赖 ${dep.name} 的 author 不符（期望 ${dep.author}，实际 ${dt.author}）`);
    }
  }
  return { ok: true, warns };
}

// 拓扑排序：在 batch ∪ 已注册 上建依赖图，解出"依赖在前"的顺序；环→拒绝（§5.2）
function topoSort(tools: ToolDef[]): { ordered: ToolDef[]; error?: string } {
  const byName = new Map<string, ToolDef>();
  for (const t of tools) byName.set(t.name, t);
  const color = new Map<string, 0 | 1 | 2>(); // 0 未访问, 1 在栈, 2 完成
  const order: ToolDef[] = [];
  let cycleErr: string | undefined;

  const visit = (t: ToolDef, stack: string[]): void => {
    if (cycleErr) return;
    const c = color.get(t.name) ?? 0;
    if (c === 2) return;
    if (c === 1) {
      cycleErr = `循环依赖: ${[...stack, t.name].join(' → ')}`;
      return;
    }
    color.set(t.name, 1);
    for (const dep of t.deps ?? []) {
      const dt = byName.get(dep.name);
      if (dt) visit(dt, [...stack, t.name]); // 仅 batch 内依赖参与排序；已注册的视为就绪
    }
    color.set(t.name, 2);
    order.push(t);
  };

  for (const t of tools) visit(t, []);
  if (cycleErr) return { ordered: [], error: cycleErr };
  return { ordered: order };
}

export const executor = {
  // 绑定 agent 引用（init 时调用一次），供 register/unregister 构建 ctx 与按名挂载。
  attachAgent(a: AgentLike): void {
    _agent = a;
  },

  // 注册单个工具：author 冲突→警告不覆盖；依赖缺失→拒绝；依赖 author 不符→警告可继续。
  // 先挂载（agent.tools + agent[name]）再 install，保证 tool.register 内能经 this.<dep> 取到依赖。
  // 返回 true=已注册 / false=被拒。
  register(tool: ToolDef): boolean {
    const name = tool.name;
    const existing = registry.get(name);
    // author 冲突：同名不同 author → 警告 + 不覆盖（§5：不静默覆盖）
    if (existing && tool.author && existing.author && existing.author !== tool.author) {
      console.warn(`[MiniAgent] 工具名冲突（author 不符，跳过覆盖）: ${name}（已有 ${existing.author}，新 ${tool.author}）`);
      return false;
    }
    // 依赖校验
    const { ok, warns } = checkDeps(tool);
    for (const w of warns) console.warn('[MiniAgent]', w);
    if (!ok) {
      console.warn(`[MiniAgent] 工具注册被拒绝（依赖缺失）: ${name}`, tool.deps);
      return false;
    }
    // 同名重注册：先卸载旧的（触发其 unregister 还原编排）
    if (existing && existing.unregister && _agent) {
      try {
        existing.unregister({ storage, executor, agent: _agent, this: _agent });
      } catch (e) {
        console.warn('[MiniAgent] unregister 失败:', name, e);
      }
    }
    // 挂载（先于 install）
    registry.set(name, tool);
    if (_agent) {
      _agent.tools.set(name, tool);
      if (!RESERVED.has(name)) (_agent as unknown as Record<string, unknown>)[name] = tool;
    }
    // 安装（register(ctx)）
    if (tool.register && _agent) {
      try {
        tool.register({ storage, executor, agent: _agent, this: _agent });
      } catch (e) {
        console.warn('[MiniAgent] register 失败:', name, e);
      }
    }
    return true;
  },

  // 注销：unregister（还原编排）→ 删表 + 取消挂载
  unregister(name: string): void {
    const tool = registry.get(name);
    if (!tool) return;
    if (tool.unregister && _agent) {
      try {
        tool.unregister({ storage, executor, agent: _agent, this: _agent });
      } catch (e) {
        console.warn('[MiniAgent] unregister 失败:', name, e);
      }
    }
    registry.delete(name);
    if (_agent) {
      _agent.tools.delete(name);
      const mounted = (_agent as unknown as Record<string, unknown>)[name];
      if (!RESERVED.has(name) && mounted === tool) delete (_agent as unknown as Record<string, unknown>)[name];
    }
  },

  // 批量注册：先拓扑排序（依赖在前）再按序注册（§5.2：先排序再注册）；环→整体拒绝。
  registerAll(tools: ToolDef[]): { registered: string[]; rejected: string[] } {
    const { ordered, error } = topoSort(tools);
    if (error) {
      console.warn('[MiniAgent] 依赖拓扑排序失败，全部拒绝:', error);
      return { registered: [], rejected: tools.map((t) => t.name) };
    }
    const registered: string[] = [];
    const rejected: string[] = [];
    for (const t of ordered) {
      if (executor.register(t)) registered.push(t.name);
      else rejected.push(t.name);
    }
    return { registered, rejected };
  },

  // 列举：默认只返回有 call 的工具（进 LLM tool_call 清单，§7）；includeAll=true 返回全量（tool_manager / 系统提示用）。
  // 统一按 name 字母序排序，保证 tool_manager / LLM 载荷 / 任何枚举出口的可读性与确定性一致。
  list(includeAll = false): ToolDef[] {
    const all = [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
    return includeAll ? all : all.filter((t) => typeof t.call === 'function');
  },

  // 启停：自编排工具改 tools:<name>.enabled 并持久化；内置工具改 config.disabledTools 黑名单并持久化；均即时 register/unregister。
  setEnabled(name: string, enabled: boolean): void {
    const desc = storage.get<ToolDesc>('tools', name);
    if (desc) {
      desc.enabled = enabled;
      storage.set('tools', name, desc);
    } else {
      const cfg = getConfig();
      const set = new Set(cfg.disabledTools ?? []);
      if (enabled) set.delete(name);
      else set.add(name);
      saveConfig({ disabledTools: [...set] });
    }
    if (enabled) {
      if (desc) {
        try {
          executor.register(buildToolFromDesc(desc));
        } catch (e) {
          console.warn('[MiniAgent] 重注册失败:', name, e);
        }
      } else {
        const bt = defaultTools.find((t) => t.name === name);
        if (bt) executor.register(bt);
      }
    } else {
      executor.unregister(name);
    }
  },

  // 全量工具状态（含启用态），供 chat_ui 启停面板渲染（文档 §3 三视图）。按 name 字母序排序。
  allToolStates(): { name: string; author?: string; enabled: boolean; builtin: boolean; description?: string }[] {
    const registered = new Set(registry.keys());
    const states: { name: string; author?: string; enabled: boolean; builtin: boolean; description?: string }[] = [];
    for (const t of defaultTools) {
      states.push({ name: t.name, author: t.author, enabled: registered.has(t.name), builtin: true, description: t.description });
    }
    for (const desc of storage.listToolDefs()) {
      if (states.some((s) => s.name === desc.name)) continue;
      states.push({ name: desc.name, author: desc.author, enabled: desc.enabled !== false, builtin: false, description: desc.description });
    }
    return states.sort((a, b) => a.name.localeCompare(b.name));
  },

  // 执行一个工具调用，返回"观察结果"文本，回灌给 LLM 作为 tool 消息。
  // 危险工具确认闸在 base 内（code_run 或 riskLevel≥high/critical 时 await ui.requestApproval）。
  // ctx.agent / ctx.this 由调用方（engine）注入，避免 executor 依赖 agent。
  run: withHooks(async (call: ToolCall, agentArg?: AgentLike): Promise<string> => {
    const tool = registry.get(call.name);
    if (!tool) return `未知工具: ${call.name}`;
    if (typeof tool.call !== 'function') return `工具 ${call.name} 无 call 入口（不可直接调用）`;

    // 确定性确认闸（高危 = 不由模型判断风险；阈值可配，文档 §6/§9）
    const needApproval =
      REQUIRE_CODE_APPROVAL && (call.name === 'code_run' || riskAtLeast(tool.riskLevel, APPROVAL_RISK_LEVEL));
    if (needApproval) {
      const code = call.args.code;
      const ok = await ui.requestApproval({ name: call.name, code, riskLevel: tool.riskLevel });
      if (!ok) return '用户拒绝了执行';
    }
    const ctx: RunCtx = { storage, executor, agent: agentArg ?? _agent!, this: agentArg ?? _agent!, console };
    try {
      const result = await tool.call(call.args ?? {}, ctx);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e) {
      return `工具执行错误: ${e instanceof Error ? e.message : String(e)}`;
    }
  }),

  // 重建自编排工具：读 tools 命名空间全部描述符 → 过滤启用项 → 构造 ToolDef → registerAll（拓扑序）。
  // 没有独立的 rehydrate 例程：重建逻辑天然写在各工具的 register 里，注册即重建。
  rehydrateTools(): void {
    const descs = storage.listToolDefs();
    const tools: ToolDef[] = [];
    for (const desc of descs) {
      if (desc.enabled === false) continue; // §3：关闭项不进 boot
      try {
        tools.push(buildToolFromDesc(desc));
      } catch (e) {
        console.warn('[MiniAgent] 重建工具失败:', desc.name, e);
      }
    }
    const { registered, rejected } = executor.registerAll(tools);
    if (rejected.length) console.warn('[MiniAgent] 部分工具未注册（依赖缺失/循环）:', rejected);
    else console.log('[MiniAgent] 重建工具:', registered);
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

// 1) 统一的持久存储管理（整合原 storage_get/set/list/del）
//    action 区分操作：get=读取 / set=写入 / list=列出 / del=删除。
//    删除为破坏性操作，仅 del 动作经 ui.requestApproval 确认闸（其余动作无摩擦）。
const gmStorageTool: ToolDef = {
  name: 'gm_storage',
  author: 'core',
  description: '统一的持久存储管理（默认 memory 命名空间，可指定其它 ns）。action 取值：get=读取键；set=写入键（update=true 时合并已有对象）；list=列出键（给定 ns 列该分区子键，不给 ns 按 default/config/sessions/tools/code/memory 分区概览）；del=删除键（不可恢复，删除前会请求确认）。用于记忆、配置、状态管理。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'list', 'del'], description: '操作类型' },
      key: { type: 'string', description: '键名（get/set/del 必需）' },
      value: { type: 'string', description: '要保存的值（set 必需，建议 JSON 字符串）' },
      ns: { type: 'string', description: '可选命名空间，默认 memory' },
      update: { type: 'boolean', description: 'set 专用：合并模式，读取已有值并合并对象' },
    },
    required: ['action'],
  },
  call: async (args, ctx) => {
    const action = String(args.action ?? '');
    const ns = String(args.ns ?? 'memory');
    switch (action) {
      case 'get': {
        const key = String(args.key ?? '');
        if (!key) return '参数 key 缺失';
        const v = ctx.storage.get(ns, key);
        return v === undefined ? '(无此键)' : JSON.stringify(v);
      }
      case 'set': {
        const key = String(args.key ?? '');
        if (!key) return '参数 key 缺失';
        if (args.value === undefined) return '参数 value 缺失';
        if (args.update) {
          const existing = ctx.storage.get(ns, key) ?? {};
          const incoming = args.value;
          const merged = typeof existing === 'object' && existing && typeof incoming === 'object' && incoming
            ? { ...(existing as Record<string, unknown>), ...(incoming as Record<string, unknown>) }
            : incoming;
          ctx.storage.set(ns, key, merged);
          return `已合并保存 ${ns}:${key}`;
        }
        ctx.storage.set(ns, key, args.value);
        return `已保存 ${ns}:${key}`;
      }
      case 'list': {
        if (args.ns) {
          const keys = storage.keys(ns).sort((a, b) => a.localeCompare(b));
          return JSON.stringify({ ns, count: keys.length, keys });
        }
        const NS = ['default', 'config', 'sessions', 'tools', 'code', 'memory'];
        const overview: Record<string, string[]> = {};
        for (const n of NS) overview[n] = storage.keys(n).sort((a, b) => a.localeCompare(b));
        return JSON.stringify(overview);
      }
      case 'del': {
        const key = String(args.key ?? '');
        if (!key) return '参数 key 缺失';
        const ok = await ui.requestApproval({ name: `gm_storage:del ${ns}:${key}`, riskLevel: 'high' });
        if (!ok) return '用户拒绝了执行';
        ctx.storage.del(ns, key);
        return `已删除 ${ns}:${key}`;
      }
      default:
        return `未知 action: ${action}（支持 get/set/list/del）`;
    }
  },
};

// 4) 运行代码：自我开发执行入口，经人工确认闸（executor.run base 内）
const codeRunTool: ToolDef = {
  name: 'code_run',
  author: 'core',
  riskLevel: 'high',
  description: '执行JS代码。危险操作，执行前会请求用户确认。',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '直接传入要执行的 JS 源码' },
    },
  },
  call: (args, ctx) => {
    const code = args.code as string;
    if (!code|| code.length === 0) return '没有可执行的代码';
    try {
      const fn = new Function('ctx', `"use strict";\n${code}`);
      const result = fn(ctx);
      return `执行成功 → ${result === undefined ? '(无返回值)' : JSON.stringify(result)}`;
    } catch (e) {
      return `执行异常: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

// 5) 统一的工具自编排管理（整合原 tool_register/tool_remove/tool_list）
//    action 区分操作：register=注册/创建 / remove=删除 / list=枚举。
const toolManagerTool: ToolDef = {
  name: 'tool_manager',
  author: 'core',
  description: '统一的工具自编排管理。action 取值：register=注册/创建新工具（持久化到 tools 命名空间，重载按依赖拓扑自动重建；code 为 call 源码，register 可选为安装源码）；remove=删除一个自编排工具（移除持久化并注销）；list=枚举当前所有已注册工具（含无 call 的系统原语），供查看完整能力面。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['register', 'remove', 'list'], description: '操作类型' },
      name: { type: 'string', description: '工具名（register/remove 必需；与 author 组合唯一）' },
      author: { type: 'string', description: '可选作者，默认 core' },
      description: { type: 'string', description: '工具说明（register 必需）' },
      inputSchema: { type: 'object', description: 'JSON Schema 参数声明（register 必需）' },
      deps: { type: 'array', description: '可选前置依赖 [{name, author?, version?}]' },
      riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: '可选风险级别' },
      code: { type: 'string', description: 'call 源码：(args, ctx) => string（register 必需）' },
      register: { type: 'string', description: '可选：安装/重建源码 (ctx) => void（register 用）' },
    },
    required: ['action'],
  },
  call: (args, ctx) => {
    const action = String(args.action ?? '');
    switch (action) {
      case 'register': {
        const name = String(args.name ?? '');
        if (!name) return '参数 name 缺失';
        const desc: ToolDesc = {
          name,
          author: args.author ? String(args.author) : 'core',
          description: String(args.description ?? ''),
          inputSchema: (args.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          deps: (args.deps as DepRef[]) ?? undefined,
          riskLevel: (args.riskLevel as ToolDesc['riskLevel']) ?? undefined,
          code: String(args.code ?? ''),
          register: args.register ? String(args.register) : undefined,
          enabled: true,
        };
        let tool: ToolDef;
        try {
          tool = buildToolFromDesc(desc);
        } catch (e) {
          return `工具代码编译失败: ${e instanceof Error ? e.message : String(e)}`;
        }
        ctx.storage.set('tools', name, desc); // 持久化（真相源）
        const ok = ctx.executor.register(tool); // 注册（含依赖校验）
        return ok ? `已创建工具 ${name}（已持久化 + 注册）` : `工具 ${name} 注册被拒（依赖缺失或 author 冲突）`;
      }
      case 'remove': {
        const name = String(args.name ?? '');
        if (!name) return '参数 name 缺失';
        ctx.storage.del('tools', name);
        ctx.executor.unregister(name);
        return `已移除工具 ${name}`;
      }
      case 'list': {
        const all = ctx.executor.list(true);
        return JSON.stringify(
          all.map((t) => ({
            name: t.name,
            author: t.author ?? 'core',
            description: t.description,
            deps: t.deps ?? [],
            riskLevel: t.riskLevel ?? 'low',
            call: typeof t.call === 'function',
            register: typeof t.register === 'function',
          })),
        );
      }
      default:
        return `未知 action: ${action}（支持 register/remove/list）`;
    }
  },
};

// 6) 系统编排发送原语（无 call → 不进 LLM tool_call 清单，文档 §7；仍注册挂载，供 tool_manager 揭示完整能力面）
const orchestrateSendTool: ToolDef = {
  name: 'orchestrate_send',
  author: 'core',
  description:
    '系统编排发送原语：把文本作为用户消息送入工作循环并触发推理。正常对话无需调用；研究自我组织时它代表"驱动循环"这一系统原语。',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '要送入循环的用户文本' } },
    required: ['text'],
  },
  register: (ctx) => {
    // 安装：把 sendMessage 暴露为可经 this.orchestrateSend 调用的系统方法（便于其它工具驱动循环）
    (ctx.this as unknown as Record<string, unknown>).orchestrateSend = (text: string) => ctx.agent.sendMessage(text);
  },
};

// 9) 会话管理：注册后自动把对话消息落盘到 session 命名空间（session:<id>），并在 default:sessions 建索引。
//    register = 安装/重建入口：生成 sessionId、向 agent.sendMessage 挂载 afterExe 钩子。
//    注意【惰性创建】：注册时不再立即写空记录，而是首次真实对话（afterExe 触发）才创建
//    session:<id> 记录并写入 default:sessions 索引——避免每次页面刷新都产生空会话污染存储。
//    幂等：避免重复注册累积 afterExe 钩子；unregister 时移除该钩子（防泄漏）。
//    支持 action：info / save / list / create / switch / remove（详见 inputSchema）。
//    模块级状态：钩子引用 + 当前 sessionId（重注册时更新，避免 stale-id 持续写盘）。
let sessionPersistHook: (() => void) | null = null;
let currentSessionId = '';

// 把当前 running 会话的消息落盘（惰性建记录 + 写索引）。register 钩子与 call 多处复用。
function flushSession(agent: AgentLike, st: typeof storage): void {
  const id = currentSessionId;
  if (!id) return;
  const cur = st.get('session', id);
  if (!cur) {
    const idx = st.get<string[]>('default', 'sessions') ?? [];
    if (!idx.includes(id)) { idx.push(id); st.set('default', 'sessions', idx); }
    st.set('session', id, { id, createdAt: Date.now(), messages: [...agent.messages] });
  } else {
    st.set('session', id, { ...cur, messages: [...agent.messages] });
  }
}

const sessionTool: ToolDef = {
  name: 'session',
  author: 'core',
  description:
    '会话管理：注册后自动把对话消息落盘到 session 命名空间（session:<id>），并在 default:sessions 建索引。' +
    'action：info=查看当前会话(默认)；save=立即落盘；list=列出全部会话；create=开新会话并清空上下文；' +
    'switch=切换到指定会话(id必填)；remove=删除指定会话(id必填，删当前则自动开新会话)。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['info', 'save', 'list', 'create', 'switch', 'remove'],
        description: 'info=当前会话信息(默认); save=立即落盘; list=列出全部会话; create=开新会话; switch=切换会话(id必填); remove=删除会话(id必填)',
      },
      id: { type: 'string', description: 'switch / remove 的目标会话 id' },
    },
  },
  register: (ctx) => {
    currentSessionId = genSessionId();
    ctx.agent.sessionId = currentSessionId;
    // 注册时【不】立即落盘空记录：改为首次真实对话时惰性创建（见下方 persist 钩子），
    // 避免每次页面刷新都无条件新建一条空会话、污染 session 命名空间与 default:sessions 索引。
    // 安装自动落盘（幂等：仅首次挂钩子，重注册复用同一引用；id 走模块级，避免累积/泄漏）
    if (!sessionPersistHook) {
      sessionPersistHook = () => {
        const id = currentSessionId;
        if (!id) return;
        const cur = ctx.storage.get('session', id);
        if (!cur) {
          // 惰性初始化：首次落盘才创建记录并写入会话索引（仅在确有对话时）
          const idx = ctx.storage.get<string[]>('default', 'sessions') ?? [];
          if (!idx.includes(id)) { idx.push(id); ctx.storage.set('default', 'sessions', idx); }
          ctx.storage.set('session', id, { id, createdAt: Date.now(), messages: [...ctx.agent.messages] });
          return;
        }
        ctx.storage.set('session', id, { ...cur, messages: [...ctx.agent.messages] });
      };
      ctx.agent.sendMessage.afterExe.push(sessionPersistHook);
    }
  },
  unregister: (ctx) => {
    if (sessionPersistHook) {
      const arr = ctx.agent.sendMessage.afterExe;
      const i = arr.indexOf(sessionPersistHook);
      if (i >= 0) arr.splice(i, 1);
      sessionPersistHook = null;
      currentSessionId = '';
    }
  },
  call: (args, ctx) => {
    const action = String(args.action ?? 'info');

    // list：列出全部会话（标注 current）
    if (action === 'list') {
      const idx = ctx.storage.get<string[]>('default', 'sessions') ?? [];
      const list = idx.map((sid) => {
        const rec = ctx.storage.get<{ createdAt?: number; messages?: unknown[] }>('session', sid);
        return { id: sid, current: sid === currentSessionId, createdAt: rec?.createdAt ?? null, messageCount: rec?.messages?.length ?? 0 };
      });
      return JSON.stringify(list);
    }

    // create：先保存当前会话，再开新会话并清空上下文
    if (action === 'create') {
      flushSession(ctx.agent, ctx.storage);
      const newId = genSessionId();
      currentSessionId = newId;
      ctx.agent.sessionId = newId;
      ctx.agent.messages = [];
      const idx = ctx.storage.get<string[]>('default', 'sessions') ?? [];
      if (!idx.includes(newId)) { idx.push(newId); ctx.storage.set('default', 'sessions', idx); }
      ctx.storage.set('session', newId, { id: newId, createdAt: Date.now(), messages: [] });
      return `已创建新会话 ${newId}（上下文已清空，旧会话已保存）`;
    }

    // switch：先保存当前，再加载目标会话消息到运行上下文
    if (action === 'switch') {
      const target = String(args.id ?? '');
      if (!target) return '参数 id 缺失（要切换到的会话 id）';
      const rec = ctx.storage.get<{ messages?: unknown[] }>('session', target);
      if (!rec) return `会话不存在: ${target}`;
      flushSession(ctx.agent, ctx.storage);
      currentSessionId = target;
      ctx.agent.sessionId = target;
      ctx.agent.messages = (rec.messages ?? []) as any[];
      return `已切换到会话 ${target}（${rec.messages?.length ?? 0} 条消息）`;
    }

    // remove：删除目标会话；若删的是当前会话则自动开新会话
    if (action === 'remove') {
      const target = String(args.id ?? '');
      if (!target) return '参数 id 缺失（要删除的会话 id）';
      const rec = ctx.storage.get('session', target);
      if (!rec) return `会话不存在: ${target}`;
      ctx.storage.del('session', target);
      const idx = ctx.storage.get<string[]>('default', 'sessions') ?? [];
      const ni = idx.filter((x) => x !== target);
      if (ni.length !== idx.length) ctx.storage.set('default', 'sessions', ni);
      if (target === currentSessionId) {
        const newId = genSessionId();
        currentSessionId = newId;
        ctx.agent.sessionId = newId;
        ctx.agent.messages = [];
        const ni2 = ctx.storage.get<string[]>('default', 'sessions') ?? [];
        if (!ni2.includes(newId)) { ni2.push(newId); ctx.storage.set('default', 'sessions', ni2); }
        ctx.storage.set('session', newId, { id: newId, createdAt: Date.now(), messages: [] });
        return `已删除当前会话 ${target}，并开启新会话 ${newId}`;
      }
      return `已删除会话 ${target}`;
    }

    // info / save 需要当前会话
    const id = ctx.agent.sessionId;
    if (!id) return '会话未初始化';
    if (action === 'save') {
      flushSession(ctx.agent, ctx.storage);
      return `已落盘会话 ${id}（${ctx.agent.messages.length} 条消息）`;
    }
    // 默认 info
    const stored = ctx.storage.get('session', id);
    return JSON.stringify({ id, messageCount: ctx.agent.messages.length, persisted: !!stored });
  },
};

// 默认工具清单（统一能力面）：领域工具 + 自开发工具 + 系统编排原语。
// 全部由 agent.init() 注册；orchestrate_send 无 call（不进 LLM 日常载荷，但 tool_manager 可见）。
export const defaultTools: ToolDef[] = [
  gmStorageTool,
  codeRunTool,
  toolManagerTool,
  orchestrateSendTool,
  sessionTool,
];
