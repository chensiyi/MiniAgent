import { storage } from './storage';
import { llm } from './llm';
import { REQUIRE_CODE_APPROVAL, APPROVAL_RISK_LEVEL, riskAtLeast, getConfig, saveConfig, getSystemPrompt } from '../model/config';
import { withHooks, type HookedFunction } from './withHooks';

// 核心审批闸（带钩子，可被 orchestrate 钩子接管）：经通用能力注册表取 UI 提供的审批能力；
// 核心不硬引用 ui 模块——UI 作为可插拔组件挂载时注册 'approval' 能力，headless 未挂载则自动放行。
// 这样"人类确认"这一 UI 行为被解耦，核心可在无 UI 环境运行（自动化场景）。
export const requestApproval = withHooks(async function (
  call: { name: string; code?: string; riskLevel?: string },
  agentRef?: AgentLike,
): Promise<boolean> {
  const ext = agentRef && (agentRef as unknown as { extensions?: Map<string, unknown> }).extensions;
  const fn = ext && typeof ext.get === 'function' ? ext.get('approval') : null;
  if (typeof fn === 'function') return (fn as (c: { name: string; code?: string; riskLevel?: string }) => Promise<boolean>)(call);
  console.warn(`[MiniAgent] 无审批闸（UI 未挂载），自动放行：${call.name}`);
  return true;
});

// executor 的结构化视图（避免 typeof executor 前向引用）
export interface ExecutorLike {
  attachAgent(a: AgentLike): void;
  register(tool: ToolDef): boolean;
  unregister(name: string): void;
  registerAll(tools: ToolDef[]): { registered: string[]; rejected: string[] };
  list(includeAll?: boolean): ToolDef[];
  setEnabled(name: string, enabled: boolean): void;
  rehydrateHooks(agent: AgentLike): void;
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
  tools: Map<string, ToolDef>; // 按名挂载的权威表（文档 §5.2）
  sendMessage: ((text: string) => Promise<void>) & HookedFunction;
  engine?: HookedFunction; // 队列循环（钩子目标之一）
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

// 系统作者默认标识：新工具未指定 author 时默认取此值（用户 2026-07-20："所有工具作者都叫sys"）。
// 工具面（tool_manager）的更新/编辑不再按 author 限制，统一以"用户确认"为闸门（用户 2026-07-20："所有工具均可经用户确认后更新"）。
const SYS_AUTHOR = 'sys';

// agent 上的保留属性名：挂载 agent[name] 时跳过，避免覆盖核心方法/状态
const RESERVED = new Set<string>([
  'messages', 'messageQueue', 'toolCallQueue', 'sessionId', 'storage', 'llm',
  'executor', '_engineActive', 'isRunning', 'chatStop', 'engine',
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

// ---- 安装期依赖库 fetch（工具自包含机制）----
// 设计：工具可在 register 时声明依赖的外部 JS 库（默认 jsDelivr 外国 CDN），
// 安装期 fetch 源码并"用内容替换自己"——把库源码内联进工具自身的 code（包成 IIFE 表达式），
// 自此该工具完全自包含、离线可用：不依赖运行时全局、不靠 @require 修改用户脚本头、不打包进产物。
// 解析规则（resolveLibUrl）：完整 URL 原样用；已知别名 marked/dompurify 展开为 jsDelivr 地址；
// 其余形如 marked@12/marked.min.js 的 spec 默认拼 https://cdn.jsdelivr.net/npm/<spec>。
const KNOWN_LIBS: Record<string, string> = {
  marked: 'https://cdn.jsdelivr.net/npm/marked@12/marked.min.js',
  dompurify: 'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js',
};
function resolveLibUrl(spec: string): string {
  const s = spec.trim();
  if (/^https?:\/\//i.test(s)) return s; // 完整 URL：原样使用（支持任意镜像）
  if (KNOWN_LIBS[s]) return KNOWN_LIBS[s]; // 已知别名
  return 'https://cdn.jsdelivr.net/npm/' + s; // 默认 jsDelivr
}
// 用 GM_xmlhttpRequest（脚本已授予）拉取库源码；失败 reject，由调用方中断安装并提示。
function fetchLibText(url: string): Promise<string> {
  const gmx = (globalThis as any).GM_xmlhttpRequest;
  if (typeof gmx !== 'function') return Promise.reject(new Error('GM_xmlhttpRequest 不可用（脚本未授予该权限）'));
  return new Promise<string>((resolve, reject) => {
    gmx({
      method: 'GET',
      url,
      onload: (r: any) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
      onerror: () => reject(new Error('网络错误（无法访问 CDN）')),
    });
  });
}

// 把多行 JSON 续行缩进到统一 pad，便于原样嵌进对象字面量（仅影响缩进，不改语义）。
function indentBlock(s: string, pad: string): string {
  return s.split('\n').map((l, i) => (i === 0 ? l : pad + l)).join('\n');
}

// 把一个工具定义/描述符导出为可直接注册的 JS 源码（控制台粘贴即用）。
// 修复（2026-07-21）：旧实现把 call/register/unregister 作为"源码字符串"直接塞进对象再调
//   executor.register，而 register 要求 call 是函数 → 重注册失败（字符串被当函数调用抛错、
//   list() 因 typeof call!=='function' 把工具排除、运行期报"无 call 入口"）。
// 新实现：导出一个自包含 IIFE 片段 —— 用 new Function 把持久化的源码串编译回函数
//   （call/register/unregister；含安装期内联的库 IIFE），再 executor.register + 持久化到 tools 命名空间，
//   使其重载后仍能自动重建。自编排工具（含内联库）因此真正"可独立重注册"。
export function exportToolToJs(desc: ToolDesc): string {
  const header = [
    `// MiniAgent 工具导出：${desc.name}`,
    '// 复制以下代码到浏览器控制台（agent 需在作用域，如 globalThis.agent）执行即可注册并持久化该工具。',
    '// 自编排工具含安装期内联依赖库（/libs），导出即自包含、可独立重注册；重载按描述符自动重建。',
  ].join('\n');
  const parts: string[] = [];
  parts.push('(function () {');
  parts.push('  const agent = globalThis.agent;');
  parts.push('  const executor = agent && agent.executor;');
  parts.push('  const storage = agent && agent.storage;');
  parts.push('  if (!executor) { console.error("[MiniAgent] 导出注册失败：agent.executor 不可用"); return; }');
  // 把持久化"源码串"编译回函数（call/register/unregister 皆为可重编译文本，含内联库 IIFE）
  parts.push("  const buildFn = (src) => src ? new Function('\"use strict\"; return (' + src + ');')() : undefined;");
  parts.push('  const desc = {');
  parts.push(`    name: ${JSON.stringify(desc.name)},`);
  parts.push(`    author: ${JSON.stringify(desc.author ?? SYS_AUTHOR)},`);
  parts.push(`    description: ${JSON.stringify(desc.description)},`);
  parts.push(`    inputSchema: ${indentBlock(JSON.stringify(desc.inputSchema ?? {}, null, 2), '    ')},`);
  if (desc.deps && desc.deps.length) parts.push(`    deps: ${indentBlock(JSON.stringify(desc.deps, null, 2), '    ')},`);
  if (desc.riskLevel) parts.push(`    riskLevel: ${JSON.stringify(desc.riskLevel)},`);
  parts.push(`    code: ${desc.code},`);
  if (desc.register) parts.push(`    register: ${desc.register},`);
  if (desc.unregister) parts.push(`    unregister: ${desc.unregister},`);
  parts.push(`    enabled: ${desc.enabled === false ? 'false' : 'true'},`);
  parts.push('  };');
  parts.push('  const tool = { ...desc, call: buildFn(desc.code), register: buildFn(desc.register), unregister: buildFn(desc.unregister) };');
  parts.push('  executor.register(tool);'); // 注册（含依赖校验/同名替换）
  parts.push('  if (storage) storage.set("tools", desc.name, desc);'); // 持久化（含内联库源码，重载自动重建）
  parts.push('  console.log("[MiniAgent] 已注册并持久化工具:", desc.name);');
  parts.push('})();');
  return header + '\n' + parts.join('\n');
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
  // 危险工具确认闸在 base 内（code_run 或 riskLevel≥high/critical 时 await requestApproval(..., ctx.agent)）。
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
      const ok = await requestApproval({ name: call.name, code, riskLevel: tool.riskLevel }, agentArg ?? _agent!);
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

  // 重建用户钩子：读 hooks 命名空间全部描述符 → 编译 → 挂接到运行期钩子数组（镜像 rehydrateTools）。
  rehydrateHooks(agentRef: AgentLike): void {
    for (const id of storage.keys('hooks')) {
      const desc = storage.get<{ id: string; name: string; target: string; phase: string; code: string }>('hooks', id);
      if (!desc || !desc.code) continue;
      const target = resolveTarget(desc.target, agentRef);
      if (!target) {
        console.warn('[MiniAgent] 钩子 target 不存在，跳过:', desc.target);
        continue;
      }
      try {
        const wrapped = compileHook(desc.code, desc.name, agentRef);
        wrapped.__hookId = id;
        (target as any)[desc.phase + 'Exe'].push(wrapped);
        console.log('[MiniAgent] 重建钩子:', desc.name, '→', desc.target + '.' + desc.phase);
      } catch (e) {
        console.warn('[MiniAgent] 重建钩子失败:', desc.name, e);
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

// 1) 统一的持久存储管理（整合原 storage_get/set/list/del）
//    action 区分操作：get=读取 / set=写入 / list=列出 / del=删除。
//    删除为破坏性操作，仅 del 动作经 requestApproval 确认闸（其余动作无摩擦）。
const gmStorageTool: ToolDef = {
  name: 'gm_storage',
  author: 'sys',
  description: '统一的持久存储管理（默认 memory 命名空间，可指定其它 ns）。action 取值：get=读取键；set=写入键（update=true 时合并已有对象）；list=列出键（给定 ns 列该分区子键，不给 ns 按 default/config/sessions/tools/code/memory 分区概览）；del=删除键（不可恢复，删除前会请求确认）。用于记忆、配置、状态管理。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'list', 'del'],
        description: '操作类型：get=读取某个键的值；set=写入/更新某个键；list=列出命名空间下的键（不给 ns 则按 default/config/sessions/tools/code/memory 分区概览）；del=删除某个键（不可恢复，删除前会请求用户确认）。',
      },
      key: { type: 'string', description: '键名。get/set/del 必需；list 不需要。' },
      value: {
        type: 'string',
        description: '要保存的值（set 必需）。会原样写入存储；get 时以 JSON 字符串形式返回，因此对象/数组等复杂值建议先 JSON 序列化后传入。',
      },
      ns: {
        type: 'string',
        description: "可选命名空间（分区）。默认 memory；也可用 default/config/sessions/tools/code 等已有分区，或自定义新分区。",
      },
      update: {
        type: 'boolean',
        description: '仅 set 生效。为 true 时进入合并模式：先读取已有值，再把传入的值（对象）浅合并进去，而非整条覆盖。',
      },
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
        const ok = await requestApproval({ name: `gm_storage:del ${ns}:${key}`, riskLevel: 'high' }, ctx.agent);
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
  author: 'sys',
  riskLevel: 'high',
  description: '执行JS代码。危险操作，执行前会请求用户确认。',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '要执行的 JS 源码。会以 new Function(\'ctx\', ...) 方式运行：函数体内可通过参数 ctx 访问运行时上下文（ctx.storage 存储 / ctx.executor 注册器 / ctx.agent 单例 / ctx.console 沙箱打印）。return 的值将作为执行结果回显。执行前会请求用户确认。',
      },
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
  author: 'sys',
  description: '统一的工具自编排管理。action 取值：register=注册/创建新工具（持久化到 tools 命名空间，重载按依赖拓扑自动重建；code 为 call 源码，register 可选为安装源码；默认停用，enabled=true 立即启用）；remove=删除工具（移除持久化并注销）；list=枚举当前所有已注册工具（含无 call 的系统原语），供查看完整能力面；export=导出工具完整定义（含 call/register/unregister 源码）为 JS 代码。注：自编排工具导出的是可重注册的源码串；内置（sys）工具导出的 call 来自函数反编译，可能引用模块内部状态，仅作查看/参考，不保证可独立运行；list_disabled=列出所有已停用的自编排工具。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['register', 'remove', 'list', 'export', 'list_disabled'],
        description: '操作类型：register=创建/注册新工具（持久化到 tools 命名空间，重载按依赖拓扑自动重建；默认停用，enabled=true 立即启用）；remove=删除工具（注销并移除持久化）；list=枚举当前所有已注册工具（含无 call 的系统原语）；export=导出工具完整定义（含 call/register/unregister 源码）为 JS 代码。内置（sys）工具导出的 call 来自函数反编译，可能引用模块内部状态，仅作查看/参考；list_disabled=列出所有已停用（未启用）的自编排工具。',
      },
      name: { type: 'string', description: '工具名（register/remove/export 必需）。按 name 匹配（注册时与 author 组合成唯一标识）。' },
      author: { type: 'string', description: `可选作者名（默认 "${SYS_AUTHOR}"；与 name 组合唯一；覆盖既有工具即替换，需用户确认）。` },
      description: { type: 'string', description: '工具说明（register 必需），会展示给 LLM 作为该工具的能力描述。' },
      inputSchema: {
        type: 'object',
        description: '新工具的参数声明（JSON Schema，register 必需）。格式如 { type:"object", properties: { 参数名: { type, description, ... } }, required: ["参数名"] }，会直接传给 LLM 决定如何调用。',
      },
      deps: { type: 'array', description: '可选前置依赖，元素形如 { name, author?, version? }；按 name 匹配，author 不符仅警告、缺失则拒绝注册。' },
      riskLevel: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: '可选风险级别：low=无摩擦；medium=中等；high=执行/删除等破坏性操作前弹确认框；critical=最高风险。默认 low。',
      },
      code: { type: 'string', description: 'call 源码（register 必需），签名为 (args, ctx) => string，返回字符串作为工具观察结果回灌 LLM。' },
      register: { type: 'string', description: '可选：安装/重建源码 (ctx) => void（register 用），在工具注册时执行（如挂载钩子、注入编排），重载会自动重建。' },
      libs: { type: 'string', description: '可选：安装期要内联进工具自身的外部 JS 库，逗号分隔。形如 marked / dompurify（别名）/ marked@12/marked.min.js（jsDelivr 路径）/ 完整 URL。默认源 jsDelivr；每库在安装期 fetch 源码并内联进 code（工具自此自包含、离线可用）。任一库下载失败则中断安装。' },
      enabled: { type: 'boolean', description: '可选：注册后是否立即启用（进 LLM 工具清单、可被调用）。默认 false（注册后处于停用状态，可在聊天 ⚙ 工具面板或 setEnabled 开启）；传 true 则注册后立即启用。' },
    },
    required: ['action'],
  },
  call: async (args, ctx) => {
    const action = String(args.action ?? '');
    switch (action) {
      case 'register': {
        const name = String(args.name ?? '');
        if (!name) return '参数 name 缺失';
        const authorArg = args.author ? String(args.author) : SYS_AUTHOR;
        const enabled = args.enabled === true; // 默认停用（§3：关闭项留 ns、不注册）
        // 安装期依赖库 fetch + 内联（"用内容替换自己"）：默认 jsDelivr，失败则中断安装并提示
        const libsSpec = args.libs ? String(args.libs) : '';
        let code = String(args.code ?? '');
        if (libsSpec) {
          const specs = libsSpec.split(',').map((s) => s.trim()).filter(Boolean);
          const sources: string[] = [];
          for (const spec of specs) {
            const url = resolveLibUrl(spec);
            try {
              const src = await fetchLibText(url);
              sources.push('// === 内联依赖库: ' + spec + ' @ ' + url + ' ===\n' + src);
            } catch (e) {
              return `依赖库下载失败（${spec} → ${url}）：${e instanceof Error ? e.message : e}\n可改用完整 URL 或可用镜像（如 https://registry.npmmirror.com/...）。`;
            }
          }
          if (sources.length && code.trim()) {
            // 包成 IIFE 表达式：库源码在 IIFE 作用域内执行（UMD 走 globalThis 兜底挂载），返回真正的 call 箭头
            code = '(function(){\n' + sources.join('\n') + '\nreturn (' + code + ');\n})()';
          }
        }
        const desc: ToolDesc = {
          name,
          author: authorArg,
          description: String(args.description ?? ''),
          inputSchema: (args.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          deps: (args.deps as DepRef[]) ?? undefined,
          riskLevel: (args.riskLevel as ToolDesc['riskLevel']) ?? undefined,
          code, // 已内联依赖库源码（安装期 fetch 结果）
          register: args.register ? String(args.register) : undefined,
          enabled,
        };
        let tool: ToolDef;
        try {
          tool = buildToolFromDesc(desc);
        } catch (e) {
          return `工具代码编译失败: ${e instanceof Error ? e.message : String(e)}`;
        }
        // 经用户确认后更新（用户 2026-07-20："所有工具均可经用户确认后更新"）。
        // 闸门=用户确认，author 不再作为编辑限制；同名则先注销旧再注册新 → systool 可被用户替换。
        // 确认框展示用户原始 code（不含内联库源码，避免冗长）
        const confirmed = await requestApproval({ name: `tool_manager.register(${name})`, code: String(args.code ?? ''), riskLevel: 'high' }, ctx.agent);
        if (!confirmed) return '已取消';
        ctx.storage.set('tools', name, desc); // 持久化（真相源，含内联库）
        // 默认停用：仅持久化、不进运行期注册表（不进 LLM 清单、不可调用）；enabled=true 才注册（含依赖校验；同名则替换）
        if (!enabled) return `已创建工具 ${name}（依赖已内联，已持久化；当前为停用状态，可在 ⚙ 工具面板或 setEnabled 开启）`;
        const ok = ctx.executor.register(tool);
        return ok ? `已创建工具 ${name}（依赖已内联，已持久化 + 已启用）` : `工具 ${name} 已持久化，但注册被拒（依赖缺失或 author 冲突），仍处于停用状态`;
      }
      case 'remove': {
        const name = String(args.name ?? '');
        if (!name) return '参数 name 缺失';
        // 经用户确认后删除（任何工具均可，含 systool；闸门=用户确认，不再按 author 限制）
        const confirmed = await requestApproval({ name: `tool_manager.remove(${name})`, riskLevel: 'high' }, ctx.agent);
        if (!confirmed) return '已取消';
        ctx.storage.del('tools', name);
        ctx.executor.unregister(name);
        return `已移除工具 ${name}`;
      }
      case 'list': {
        const all = ctx.executor.list(true);
        return JSON.stringify(
          all.map((t) => ({
            name: t.name,
            author: t.author ?? SYS_AUTHOR,
            description: t.description,
            deps: t.deps ?? [],
            riskLevel: t.riskLevel ?? 'low',
            call: typeof t.call === 'function',
            register: typeof t.register === 'function',
          })),
        );
      }
      case 'list_disabled': {
        // 列出持久化（tools 命名空间）中处于停用状态的工具：register 默认停用（enabled=false），或经 setEnabled(false) 关闭。
        const disabled = ctx.storage.listToolDefs().filter((d) => d.enabled === false);
        if (disabled.length === 0) return '当前没有停用的工具';
        return JSON.stringify(
          disabled.map((d) => ({
            name: d.name,
            author: d.author ?? SYS_AUTHOR,
            description: d.description,
            deps: d.deps ?? [],
            riskLevel: d.riskLevel ?? 'low',
          })),
        );
      }
      case 'export': {
        const name = String(args.name ?? '');
        if (!name) return '参数 name 缺失';
        // 优先用持久化描述符（含内联依赖库源码），保证导出自包含、可独立重注册；
        // 运行期 ToolDef 经 toString 取源码会丢失内联库，仅作兜底。
        const desc: ToolDesc | undefined = ctx.storage.get<ToolDesc>('tools', name) ?? (() => {
          const live = registry.get(name);
          if (!live) return undefined;
          return {
            name: live.name,
            author: live.author,
            description: live.description,
            inputSchema: live.inputSchema,
            deps: live.deps,
            riskLevel: live.riskLevel,
            code: live.call ? live.call.toString() : '',
            register: live.register ? live.register.toString() : undefined,
            unregister: live.unregister ? live.unregister.toString() : undefined,
            enabled: true,
          } as ToolDesc;
        })();
        if (!desc || !desc.code) return `未找到可导出的工具: ${name}`;
        // 以 markdown 代码块包裹，便于在聊天里直接复制。
        return '```js\n' + exportToolToJs(desc) + '\n```';
      }
      default:
        return `未知 action: ${action}（支持 register/remove/list/export/list_disabled）`;
    }
  },
};

// 6) 系统编排管理：查看并热更新运行期"编排"（钩子 + 系统提示 + 工具面）。带 call → 进 LLM 清单，自我组织闭环。
//    钩子目标 = 被 withHooks 包、带 beforeExe/afterExe 数组的函数。存储独立于 config：每钩子存 hooks:<id>。
const HOOK_TARGETS = ['sendMessage', 'engine', 'run', 'streamChat', 'chat', 'requestApproval', 'storageSet'] as const;

// 把 target 名解析到真实的 withHooks 包装函数（运行期钩子数组所在处）。
function resolveTarget(name: string, agentRef: AgentLike): HookedFunction | null {
  const map: Record<string, HookedFunction | undefined> = {
    sendMessage: agentRef.sendMessage as unknown as HookedFunction,
    engine: (agentRef as unknown as { engine?: HookedFunction }).engine as HookedFunction,
    run: executor.run as unknown as HookedFunction,
    streamChat: llm.streamChat as unknown as HookedFunction,
    chat: llm.chat as unknown as HookedFunction,
    requestApproval: requestApproval as unknown as HookedFunction,
    storageSet: storage.set as unknown as HookedFunction,
  };
  return map[name] ?? null;
}

// 把钩子体编译成安全包装函数：用户 fn 抛错不会影响主循环；打 __userHook/__name 标记供 view 区分来源。
function compileHook(code: string, name: string, agentRef: AgentLike): ((opts: any) => void) & Record<string, unknown> {
  const userFn = new Function('opts', 'agent', 'storage', 'executor', 'console', code) as (
    opts: any,
    agent: any,
    storage: any,
    executor: any,
    console: Console,
  ) => void;
  const wrapped = ((hookOpts: any) => {
    try {
      userFn(hookOpts, agentRef, storage, executor, console);
    } catch (e) {
      console.error('[hook]', name, e);
    }
  }) as ((opts: any) => void) & Record<string, unknown>;
  wrapped.__userHook = true;
  wrapped.__name = name;
  return wrapped;
}

const orchestrateTool: ToolDef = {
  name: 'orchestrate',
  author: 'sys',
  description:
    '系统编排管理：查看并热更新当前智能体的"编排"（运行期钩子 + 系统提示 + 工具面）。action 取值 view（查看实时编排快照：系统提示 + 各钩子目标 sendMessage/engine/run/streamChat/chat/requestApproval/storageSet 的运行期钩子清单（含 name 与 id）+ 工具清单 + 引擎参数）/ update（改写系统提示并热生效，需传 systemPrompt）/ addHook（热挂接用户钩子，需传 name/target/phase/code；code 为钩子体，签名 (opts, agent, storage, executor, console)，可经 opts.args 改写请求/消息，如在 streamChat.before 里改 opts.args[0].messages 即可在请求发出前编辑内容）/ removeHook（移除用户钩子，需传 hookId 或 name；按 name 移除所有同名用户钩子）。update/addHook/removeHook 执行前均弹确认框。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'update', 'addHook', 'removeHook'],
        description: 'view=查看快照(默认)；update=改写系统提示；addHook=挂接用户钩子；removeHook=移除用户钩子',
      },
      systemPrompt: { type: 'string', description: 'update 时用的新系统提示全文' },
      name: { type: 'string', description: 'addHook 时钩子显示名；removeHook 时按名移除（移除所有同名用户钩子）。与 hookId 二选一' },
      target: {
        type: 'string',
        enum: ['sendMessage', 'engine', 'run', 'streamChat', 'chat', 'requestApproval', 'storageSet'],
        description: 'addHook 时挂接到哪个钩子目标',
      },
      phase: { type: 'string', enum: ['before', 'after'], description: 'addHook 时 before/after 阶段（默认 before）' },
      code: {
        type: 'string',
        description: 'addHook 时的钩子体源码。会被包成 (opts, agent, storage, executor, console) => void：可通过改写 opts.args 影响请求/消息（如在 streamChat.before 里改 opts.args[0].messages 即可在请求发出前编辑内容）；agent/storage/executor/console 为运行时上下文。示例："console.log(opts.args);"。',
      },
      hookId: { type: 'string', description: 'removeHook 时目标钩子 id（与 name 二选一）' },
    },
  },
  call: async (args, ctx) => {
    const action = String(args.action ?? 'view');
    if (action === 'view') {
      const hooksSnap: Record<string, { before: { name: string; id: string | null }[]; after: { name: string; id: string | null }[] }> = {};
      for (const t of HOOK_TARGETS) {
        const fn = resolveTarget(t, ctx.agent);
        if (!fn) {
          hooksSnap[t] = { before: [], after: [] };
          continue;
        }
        // 每个钩子带 name + id（user 钩子有 id，core 钩子 id 为 null）——便于编排查看与按名/按 id 回收
        const describe = (f: any): { name: string; id: string | null } =>
          f.__userHook
            ? { name: String(f.__name ?? 'userHook'), id: (f.__hookId as string) ?? null }
            : { name: '(core)', id: null };
        hooksSnap[t] = { before: fn.beforeExe.map(describe), after: fn.afterExe.map(describe) };
      }
      const cfg = getConfig();
      return JSON.stringify(
        {
          systemPrompt: getSystemPrompt(),
          hooks: hooksSnap,
          tools: executor.list(true).map((t) => ({ name: t.name, author: t.author, hasCall: typeof t.call === 'function' })),
          engine: { model: cfg.model, baseURL: cfg.baseURL },
        },
        null,
        2,
      );
    }
    if (action === 'update') {
      const ok = await requestApproval({ name: 'orchestrate.update', riskLevel: 'high', code: String(args.systemPrompt ?? '') }, ctx.agent);
      if (!ok) return '已取消';
      const sp = String(args.systemPrompt ?? '');
      if (!sp) return 'systemPrompt 不能为空';
      storage.set('config', 'systemPrompt', sp);
      // 热生效：替换 agent.messages 里 role=system 那条（有则改，无则 unshift），当下会话即应用
      const msgs = ctx.agent.messages;
      const i = msgs.findIndex((m: any) => m.role === 'system');
      if (i >= 0) msgs[i] = { ...msgs[i], content: sp };
      else msgs.unshift({ role: 'system', content: sp });
      return '已更新系统提示并热生效（当下会话即应用）';
    }
    if (action === 'addHook') {
      const codeStr = String(args.code ?? '');
      const ok = await requestApproval({ name: 'orchestrate.addHook', riskLevel: 'high', code: codeStr }, ctx.agent);
      if (!ok) return '已取消';
      const target = resolveTarget(String(args.target ?? ''), ctx.agent);
      if (!target) return `未知 target: ${args.target}（可选: ${HOOK_TARGETS.join('/')}）`;
      const phase = String(args.phase ?? 'before');
      if (phase !== 'before' && phase !== 'after') return 'phase 必须为 before/after';
      const name = String(args.name ?? 'userHook');
      const id = 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      let wrapped: ((opts: any) => void) & Record<string, unknown>;
      try {
        wrapped = compileHook(codeStr, name, ctx.agent);
      } catch (e) {
        return `钩子代码编译失败: ${e instanceof Error ? e.message : String(e)}`;
      }
      wrapped.__hookId = id;
      (target as any)[phase + 'Exe'].push(wrapped);
      storage.set('hooks', id, { id, name, target: String(args.target), phase, code: codeStr });
      return `已挂接用户钩子 ${name} → ${args.target}.${phase}（id=${id}），刷新不丢`;
    }
    if (action === 'removeHook') {
      const id = String(args.hookId ?? '');
      const name = String(args.name ?? '');
      if (!id && !name) return 'removeHook 需提供 hookId 或 name（按 name 移除所有同名用户钩子）';
      const ok = await requestApproval({ name: 'orchestrate.removeHook', riskLevel: 'high', code: id || name }, ctx.agent);
      if (!ok) return '已取消';
      // 回收：同时按 hookId / name 在所有钩子目标里移除匹配的用户钩子（core 钩子不可经此移除）
      let removed = 0;
      for (const t of HOOK_TARGETS) {
        const fn = resolveTarget(t, ctx.agent);
        if (!fn) continue;
        for (const phase of ['before', 'after'] as const) {
          const arr = (fn as any)[phase + 'Exe'] as any[];
          for (let i = arr.length - 1; i >= 0; i--) {
            const f = arr[i];
            const match = (id && f.__hookId === id) || (name && f.__userHook && f.__name === name);
            if (match) { arr.splice(i, 1); removed++; }
          }
        }
      }
      // 同步清理持久化（hooks 命名空间）
      if (id) storage.del('hooks', id);
      else if (name) {
        for (const hid of storage.keys('hooks')) {
          const d = storage.get<{ name?: string }>('hooks', hid);
          if (d && d.name === name) storage.del('hooks', hid);
        }
      }
      return removed ? `已移除 ${removed} 个钩子（id=${id || '-'} name=${name || '-'}）` : `未找到匹配钩子（id=${id || '-'} name=${name || '-'}）`;
    }
    return '未知 action: ' + action;
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
  author: 'sys',
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

// 默认工具清单（统一能力面）：领域工具 + 自开发工具 + 系统编排管理。
// 全部由 agent.init() 注册；orchestrate 带 call（进 LLM 日常载荷，供自我编排查看/热更新运行期钩子与系统提示）。
export const defaultTools: ToolDef[] = [
  gmStorageTool,
  codeRunTool,
  toolManagerTool,
  orchestrateTool,
  sessionTool,
];
