import { storage, NS } from './storage';
import { buildToolFromDesc } from './sandbox';
import { llm, type ChatMessage } from '../core/llm';
import { markedTool } from '../tools/marked';
import { REQUIRE_CODE_APPROVAL, APPROVAL_RISK_LEVEL, riskAtLeast, type AppConfig } from '../model/config';
import { hooksTool, uninstallToolHooks } from '../tools/hooks';
import { gmStorageTool } from '../tools/gm_storage';
import { runJsTool } from '../tools/run_js';
import { toolManagerTool } from '../tools/tool_manager';
import { sessionTool } from '../tools/session';

// 核心审批闸：定义见下方 executor 对象的 requestApproval 属性（已由 hooks 工具在注册时经 wrapHook 包裹，
// 可被用户钩子接管）。经通用能力注册表取 UI 提供的审批能力；核心不硬引用 ui 模块——
// UI 作为可插拔组件挂载时注册 'approval' 能力，headless 未挂载则自动放行。

// executor 的结构化视图（避免 typeof executor 前向引用）
export interface ExecutorLike {
  attachAgent(a: AgentLike): void;
  register(tool: ToolDef): boolean;
  unregister(name: string): void;
  registerAll(tools: ToolDef[]): { registered: string[]; rejected: string[] };
  list(includeAll?: boolean): ToolDef[];
  setEnabled(name: string, enabled: boolean): Promise<void>;
  allToolStates(): { name: string; author?: string; enabled: boolean; builtin: boolean; description?: string }[];
  run(call: ToolCall, agentArg?: AgentLike): Promise<string>;
  requestApproval(
    call: { name: string; code?: unknown; riskLevel?: string },
    agentRef?: AgentLike,
  ): Promise<boolean>;
}

// agent 的结构化视图：executor 仅依赖这个最小接口（不 import agent 模块，消除循环依赖）。
// 实际传入的是全局 agent 单例（Agent = typeof agent），结构超集，可赋值。
export interface AgentLike {
  config: AppConfig; // 运行期配置单一真相源（内存）；经 config setter 由 gm_storage 落盘钩子透明持久化
  messages: ChatMessage[];
  sessionId: string;
  storage: typeof storage;
  llm: typeof llm;
  executor: ExecutorLike;
  tools: Map<string, ToolDef>; // 按名挂载的权威表（文档 §5.2）
  // 注：sendMessage / engine 在定义时为普通函数，由 hooks 工具在 register 时经 wrapHook 包裹后才带 HookedFunction；
  // 此处类型仅声明其调用签名，运行期钩子数组由 hooks 工具注入（调用方经 as HookedFunction 挂钩）。
  sendMessage: (text: string) => Promise<void>;
  engine?: (...args: any[]) => Promise<void>; // 队列循环（钩子目标之一），运行期经 wrapHook 包裹
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
  parameters: Record<string, unknown>; // 发给模型的 JSON Schema（OpenAI 标准字段名 parameters）：strict 模式由模型强制约束结构（required 列全属性 + additionalProperties:false）；tool 自身不再运行时维护输入校验（见 §8/§12.3）
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
  parameters: Record<string, unknown>; // 同 ToolDef.parameters：发给模型的 JSON Schema（strict 模式，模型强制约束）
  deps?: DepRef[];
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  code: string; // call 源码：(args, ctx) => string
  register?: string; // 可选：安装源码 (ctx) => void
  unregister?: string; // 可选：卸载源码 (ctx) => void
  enabled?: boolean; // 启停状态（§3：关闭项留 ns、不注册）
}

// LLM 实际发出的调用（tool_calls 解析后的产物）；type 显式声明为 function，与 OpenAI tool call 格式对齐
export interface ToolCall {
  id: string;
  type: 'function';
  name: string;
  args: Record<string, unknown>;
}

// 系统作者默认标识：新工具未指定 author 时默认取此值（用户 2026-07-20："所有工具作者都叫sys"）。
// 工具面（tool_manager）的更新/编辑不再按 author 限制，统一以"用户确认"为闸门（用户 2026-07-20："所有工具均可经用户确认后更新"）。
export const SYS_AUTHOR = 'sys';

// agent 上的保留属性名：挂载 agent[name] 时跳过，避免覆盖核心方法/状态
const RESERVED = new Set<string>([
  'messages', 'messageQueue', 'toolCallQueue', 'sessionId', 'storage', 'llm',
  'executor', '_engineActive', 'isRunning', 'chatStop', 'engine',
  'sendMessage', 'chat', 'tools',
  'ui', 'output', 'extensions', // UI 作为 tool：禁止把工具挂成 agent.ui / 覆盖核心 output/extensions（解耦铁律）
]);

const registry = new Map<string, ToolDef>();
let _agent: AgentLike | null = null;

// 用户代码编译统一入口见 ./sandbox（createSandboxFn / compileFn / compileBody / buildToolFromDesc / compileHook）。

// ---- 安装期依赖库 fetch（工具自包含机制）----
// 设计：工具可在 register 时声明依赖的外部 JS 库（默认外国 CDN 链：jsDelivr / unpkg / cdnjs，用户要求"用国外的"），
// 安装期 fetch 源码并"用内容替换自己"——把库源码内联进工具自身的 code（包成 IIFE 表达式），
// 自此该工具完全自包含、离线可用：不依赖运行时全局、不靠 @require 修改用户脚本头、不打包进产物。
// 解析规则（resolveLibUrls）：完整 URL 原样返回单源；已知别名 marked/dompurify 展开为多源兜底链；
// 其余形如 marked@12/marked.min.js 的 spec 默认拼外国 CDN 链（jsDelivr / unpkg / cdnjs）。
const KNOWN_LIBS: Record<string, string[]> = {
  marked: [
    'https://cdn.jsdelivr.net/npm/marked@12/marked.min.js',
    'https://unpkg.com/marked@12/marked.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js',
  ],
  dompurify: [
    'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js',
    'https://unpkg.com/dompurify@3/dist/purify.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
  ],
};
export function resolveLibUrls(spec: string): string[] {
  const s = spec.trim();
  if (/^https?:\/\//i.test(s)) return [s]; // 完整 URL：原样使用（支持任意镜像）
  if (KNOWN_LIBS[s]) return KNOWN_LIBS[s]; // 已知别名 → 多源兜底链
  return [
    'https://cdn.jsdelivr.net/npm/' + s,
    'https://unpkg.com/' + s,
    'https://cdnjs.cloudflare.com/ajax/libs/' + s,
  ]; // 默认外国 CDN 链
}
// 单个 URL 加载：优先页面原生 fetch（jsDelivr 开启 CORS，跨域 GET 无需 @connect 授权，规避 GM_xmlhttpRequest 被拦），
// 失败再退回 GM_xmlhttpRequest。返回源码文本。
function loadLibText(url: string): Promise<string> {
  const g = globalThis as any;
  const viaXhr = () => new Promise<string>((resolve, reject) => {
    const gmx = g.GM_xmlhttpRequest;
    if (typeof gmx !== 'function') { reject(new Error('GM_xmlhttpRequest 不可用（脚本未授予该权限）')); return; }
    gmx({
      method: 'GET',
      url,
      onload: (r: any) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status))),
      onerror: () => reject(new Error('网络错误（无法访问 CDN）')),
    });
  });
  if (typeof g.fetch === 'function') {
    return g.fetch(url, { redirect: 'follow' })
      .then((res: any) => (res.ok ? res.text() : Promise.reject(new Error('HTTP ' + res.status))))
      .catch(() => viaXhr());
  }
  return viaXhr();
}
// urls 为兜底链，依次尝试（每源优先 fetch 后 GM_xmlhttpRequest），任一成功即返回；全部失败 reject。
export function fetchLibText(urls: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= urls.length) { reject(new Error('所有 CDN 来源均失败')); return; }
      const url = urls[idx++];
      loadLibText(url).then(resolve, tryNext);
    };
    tryNext();
  });
}

// ---- base64 编解码（unicode 安全，基于 btoa/atob + encodeURIComponent）----
// 用于 /code 命令值的可靠传输：base64 字符集不含空格，彻底解耦"未加引号值读到行尾"的脆弱约定，
// 含引号/斜杠/换行均安全。解析端见 agent.ts parseToolCommand（b64: 前缀）。
export function b64Encode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}
export function b64Decode(s: string): string {
  return decodeURIComponent(escape(atob(s)));
}

// 导出用：优先取持久化描述符（含 /libs 内联库源码，自包含可重装）；运行期 ToolDef 经 toString 兜底（会丢内联库）。
export function resolveToolDesc(name: string): ToolDesc | undefined {
  const persisted = storage.get<ToolDesc>('tools', name);
  if (persisted) return persisted;
  const live = executor.list(true).find((t) => t.name === name);
  if (!live) return undefined;
  return {
    name: live.name,
    author: live.author,
    description: live.description,
    parameters: live.parameters,
    deps: live.deps,
    riskLevel: live.riskLevel,
    code: live.call ? live.call.toString() : '',
    register: live.register ? live.register.toString() : undefined,
    unregister: live.unregister ? live.unregister.toString() : undefined,
    enabled: true,
  } as ToolDesc;
}

// 删除工具：经用户确认闸后，移除持久化描述符并注销运行期注册；
// 内置（sys）工具无 tools 命名空间描述符，删除后追加到 disabledTools 黑名单，重载不回注（避免"删了又回来"）。
// remove / delete 两个 action 共用此实现，语义一致。
export async function deleteTool(name: string, agent: AgentLike): Promise<string> {
  const confirmed = await executor.requestApproval({ name: `tool_manager.delete(${name})`, riskLevel: 'high' }, agent);
  if (!confirmed) return '已取消';
  const persisted = storage.get<ToolDesc>('tools', name);
  if (persisted) {
    storage.del(NS.TOOLS, name); // 移除持久化（自编排工具真相源）
    } else {
      // 内置工具：无 tools 命名空间描述符 → 追加黑名单，重载不回注
      const set = new Set(agent.config.disabledTools ?? []);
      set.add(name);
      agent.config.disabledTools = [...set]; // setter 触发 gm_storage 落盘钩子
    }
  executor.unregister(name); // 移除运行期注册（含还原其 register/unregister 编排）
  return `已删除工具 ${name}`;
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

// 拓扑排序：在传入的 batch(tools) 上建依赖图，解出"依赖在前"的顺序；环→拒绝（§5.2）。
// 注：仅 batch 内依赖参与排序；已注册工具视为就绪（visit 不递归 registry 中的依赖），避免重复排序。
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

  // 注销：unregister（还原编排）→ 清理该工具登记的全部钩子 → 删表 + 取消挂载
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
    uninstallToolHooks(name); // 一次性清理该工具登记的全部钩子（仅运行期，不删持久化）
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
  // 关闭 UI（ui 这个 tool 被禁用）是风险操作：须经确认闸（agent.extensions 的 'approval'，headless 自动放行）；
  // 用户拒绝则保持原状、什么都不做（调用方负责还原开关视觉）。开启 UI 不确认（安全、可逆）。
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (!enabled && name === 'ui') {
      const ok = await executor.requestApproval({ name: 'ui.disable（关闭界面）', riskLevel: 'high' }, _agent ?? undefined);
      if (!ok) return;
    }
    const desc = storage.get<ToolDesc>('tools', name);
    if (desc) {
      desc.enabled = enabled;
      storage.set(NS.TOOLS, name, desc);
    } else {
      const set = new Set(_agent?.config.disabledTools ?? []);
      if (enabled) set.delete(name);
      else set.add(name);
      if (_agent) { _agent.config.disabledTools = [...set]; } // setter 触发 gm_storage 落盘钩子
    }
    if (enabled) {
      if (desc) {
        try {
          executor.register(buildToolFromDesc(desc));
        } catch (e) {
          console.warn('[MiniAgent] 重注册失败:', name, e);
        }
      } else {
        const bt = [...defaultTools, ...extraBuiltinTools].find((t) => t.name === name);
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
    for (const t of [...defaultTools, ...extraBuiltinTools]) {
      states.push({ name: t.name, author: t.author, enabled: registered.has(t.name), builtin: true, description: t.description });
    }
    for (const desc of storage.listToolDefs()) {
      if (states.some((s) => s.name === desc.name)) continue;
      states.push({ name: desc.name, author: desc.author, enabled: desc.enabled !== false, builtin: false, description: desc.description });
    }
    return states.sort((a, b) => a.name.localeCompare(b.name));
  },

  // 执行一个工具调用，返回"观察结果"文本，回灌给 LLM 作为 tool 消息。
  // 危险工具确认闸在 base 内（run_js 或 riskLevel≥high/critical 时 await executor.requestApproval(..., ctx.agent)）。
  // ctx.agent / ctx.this 由调用方（engine）注入，避免 executor 依赖 agent。
  // 核心审批闸（带钩子，可被用户钩子接管）：见 requestApproval 属性
  requestApproval: async function (
    call: { name: string; code?: unknown; riskLevel?: string },
    agentRef?: AgentLike,
  ): Promise<boolean> {
    const ext = agentRef && (agentRef as unknown as { extensions?: Map<string, unknown> }).extensions;
    const fn = ext && typeof ext.get === 'function' ? ext.get('approval') : null;
    if (typeof fn === 'function') {
      return (fn as (c: { name: string; code?: string; riskLevel?: string }) => Promise<boolean>)(
        call as { name: string; code?: string; riskLevel?: string },
      );
    }
    console.warn(`[MiniAgent] 无审批闸（UI 未挂载），自动放行：${call.name}`);
    return true;
  },

  run: async (call: ToolCall, agentArg?: AgentLike): Promise<string> => {
    const tool = registry.get(call.name);
    if (!tool) {
      console.warn('[MiniAgent.Exec] ⚠️ 未知工具', { name: call.name, args: call.args });
      return `未知工具: ${call.name}`;
    }
    if (typeof tool.call !== 'function') return `工具 ${call.name} 无 call 入口（不可直接调用）`;
    // 边界安全：agentArg 与 _agent 双空（理论上 init 已 attachAgent，但类型允许为空）时返回可读错误，避免非空断言崩溃
    const agentRef = agentArg ?? _agent;
    if (!agentRef) return '执行错误：agent 未初始化（executor.attachAgent 未调用）';
    console.log('[MiniAgent.Exec] ▶ 执行工具', { name: call.name, args: call.args, riskLevel: tool.riskLevel });

    // 确定性确认闸（高危 = 不由模型判断风险；阈值可配，文档 §6/§9）
    const needApproval =
      REQUIRE_CODE_APPROVAL && (call.name === 'run_js' || riskAtLeast(tool.riskLevel, APPROVAL_RISK_LEVEL));
    if (needApproval) {
      const code = call.args.code;
      const ok = await executor.requestApproval({ name: call.name, code, riskLevel: tool.riskLevel }, agentRef);
      if (!ok) return '用户拒绝了执行';
    }
    const ctx: RunCtx = { storage, executor, agent: agentRef, this: agentRef, console };
    try {
      const result = await tool.call(call.args ?? {}, ctx);
      const out = typeof result === 'string' ? result : JSON.stringify(result);
      console.log('[MiniAgent.Exec] ✅ 工具返回', { name: call.name, resultLen: out.length, preview: out.slice(0, 200) });
      return out;
    } catch (e) {
      console.error('[MiniAgent.Exec] ❌ 工具异常', { name: call.name, error: e instanceof Error ? e.message : String(e) });
      return `工具执行错误: ${e instanceof Error ? e.message : String(e)}`;
    }
  },

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

  // 用户钩子重建见 src/tools/hooks.ts 的 rehydrateHooks（由 agent.init 调用）。
};

// 钩子体编译器见 ./sandbox 的 compileHook（由 hooks.ts 的 rehydrateHooks / hooks 的 call(addHook) 调用）。

// 默认工具清单（统一能力面）：领域工具 + 自开发工具 + 系统编排管理。
// 各工具定义已迁至 src/tools/（与 hooks/marked 同例）；全部由 agent.init() 注册；
// hooks 工具既提供 wrapHook 等底层方法，又带 call（进 LLM 日常载荷，供查看/热更新运行期钩子）。
export const defaultTools: ToolDef[] = [
  hooksTool, // 钩子系统：注册即初始化（统一包裹核心函数），须先于其它工具注册
  gmStorageTool,
  runJsTool,
  toolManagerTool,
  sessionTool,
  markedTool,
];

// 由宿主（agent.ts）注入的额外内置工具（UI 等）。executor 不 import ui 以保持核心解耦；
// 此数组供 bootList / allToolStates / setEnabled 统一枚举内置工具（含非 defaultTools 的内置）。
export const extraBuiltinTools: ToolDef[] = [];
