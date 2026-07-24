// hooks.ts：钩子系统 = 内置工具（name: 'hooks', author: 'sys'）。
//
// 设计（用户 2026-07-22）：
//  - withHooks 不再是一个孤立模块，而是本工具提供的方法 wrapHook——把普通函数包成"可 hook 的普通函数"。
//  - 钩子安装/卸载 API 集中在本模块（installHook / uninstallHookById / uninstallHookByName / uninstallToolHooks / restoreAllWrapped）。
//  - 包裹是【懒】的：installHook 在首次给某目标挂钩时，若目标尚未被钩（无 __hooked），自动经 wrapHook 包裹
//    并就地替换回宿主属性（仅包裹一次），同时把 original 记进 wrapedFns 以便关闭时还原。调用方无需关心"是否已初始化包裹"。
//  - 关闭 hooks 工具（unregister）时：restoreAllWrapped() 把全部被包裹的函数还原为原始过程，并清空注册表——
//    即"关闭 hooks 后恢复全部过程"，不留悬挂的钩子数组、不污染宿主属性。
//  - 安装只在工具 register 环节调用（规范，非强制）；安装时记录调用方 toolName 与 hookId；
//    工具 uninstall 时经 uninstallToolHooks(toolName) 一次性清理其登记的全部钩子（仅运行期，不删持久化）。
//  - 不 import ui 等上层模块（仅经 ctx 拿到 agent/executor），保持核心解耦；仅依赖底层 storage / llm（叶子模块，存储键常量也定义在 storage.ts 内）。

import { storage } from '../core/storage';
import { llm } from '../core/react_loop';
import { NS } from '../core/storage';
import { compileHook } from '../core/sandbox';
import type { RegisterCtx, AgentLike, ExecutorLike } from '../core/executor';

// ===== wrapHook：把普通函数包成"可 hook 的普通函数" =====
// - 调用方签名不变（无 .call()、非 class 实例），仍 fn(...args) 正常调，无感。
// - beforeExe / afterExe 为钩子数组；钩子签名 (opts) => void | Promise<void>。
// - opts = { args, result }：before 可改 opts.args，after 读 opts.result。
// - 返回值严格跟随 base：async→Promise、sync→原值、生成器→返回生成器（仅 before 钩子）。
// - thisArg：透传给 fn.apply(thisArg, args)；支持包时立即传（自动包裹时传宿主对象），也支持声明后迟绑（wrapped.__thisArg = ctx）。
// - __hooked：标记已包裹，供懒包裹幂等判断（避免重复包裹）。
//
// ★ 异常契约（落盘等关键场景依赖此语义）：
//   before 钩子链中任一钩子抛错 → 直接中断、base（原方法）不再执行，错误向上传播。
//   例：gm_storage 在 storageSet.before 装了 GM 落盘钩子——若 GM 写入抛错（如配额超限），
//   则 config.set 等原本的内存写入被跳过（"落盘失败即不写"），保证内存与落盘不出现半吊子状态。
//   after 钩子抛错不影响 base 结果（base 已执行并 return），仅错误向上传播。
export type HookOpts = { args: any[]; result: any };
export type HookFn = (opts: HookOpts) => void | Promise<void>;

export interface HookedFunction {
  (...args: any[]): any;
  beforeExe: HookFn[];
  afterExe: HookFn[];
  __thisArg?: any;
  __hooked?: boolean;
}

function kindOf(fn: Function): 'asyncGenerator' | 'generator' | 'async' | 'sync' {
  const name = fn.constructor ? fn.constructor.name : '';
  if (/AsyncGeneratorFunction/.test(name)) return 'asyncGenerator';
  if (/GeneratorFunction/.test(name)) return 'generator';
  if (/AsyncFunction/.test(name)) return 'async';
  return 'sync';
}

export function wrapHook<T extends (...args: any[]) => any>(
  fn: T,
  thisArg?: any,
): T & HookedFunction {
  const beforeExe: HookFn[] = [];
  const afterExe: HookFn[] = [];
  let wRef: HookedFunction | undefined;

  const attach = (w: T & HookedFunction): T & HookedFunction => {
    w.beforeExe = beforeExe;
    w.afterExe = afterExe;
    w.__thisArg = thisArg;
    w.__hooked = true;
    wRef = w;
    return w;
  };

  // 运行期取 this：优先已迟绑的 __thisArg，否则回落包时传入的 thisArg。
  const getThis = (): any =>
    wRef ? (wRef as HookedFunction & { __thisArg?: any }).__thisArg : thisArg;

  const kind = kindOf(fn as unknown as Function);

  // 异步生成器（如 llm.chat）：返回 AsyncGenerator，仅 before 钩子（惰性、after 无法落点）。
  // 关键：不能用 yield* 委托——它会吞掉原生成器的 return 值（工具调用清单 {toolCalls} 在此丢失，
  // 导致 agent 收到 toolCalls:0、主区空白）。改为手动 next() 迭代并 return last.value 透传返回值。
  if (kind === 'asyncGenerator') {
    const w = (async function* (...args: any[]) {
      const opts: HookOpts = { args, result: undefined };
      for (const h of beforeExe) await h(opts);
      const inner = fn.apply(getThis(), opts.args) as AsyncGenerator<any, any, any>;
      let step: IteratorResult<any, any> = { done: false, value: undefined };
      while (true) {
        step = await inner.next();
        if (step.done) return step.value; // 透传原生成器的 return 值（工具调用清单在此返回）
        yield step.value;
      }
    }) as T & HookedFunction;
    return attach(w);
  }

  // 同步生成器：返回 Generator，仅 before 钩子。同样手动迭代以透传 return 值。
  if (kind === 'generator') {
    const w = (function* (...args: any[]) {
      const opts: HookOpts = { args, result: undefined };
      for (const h of beforeExe) h(opts);
      const inner = fn.apply(getThis(), opts.args) as Generator<any, any, any>;
      let step: IteratorResult<any, any> = { done: false, value: undefined };
      while (true) {
        step = inner.next();
        if (step.done) return step.value; // 透传 return 值
        yield step.value;
      }
    }) as T & HookedFunction;
    return attach(w);
  }

  // 异步函数：await before / base / after。
  if (kind === 'async') {
    const w = (async (...args: any[]) => {
      const opts: HookOpts = { args, result: undefined };
      for (const h of beforeExe) await h(opts);
      const result = await (fn.apply(getThis(), opts.args) as Promise<any>);
      opts.result = result;
      for (const h of afterExe) await h(opts);
      return opts.result;
    }) as T & HookedFunction;
    return attach(w);
  }

  // 同步函数：同步跑钩子（约定 sync base 用 sync hook）。
  const w = ((...args: any[]) => {
    const opts: HookOpts = { args, result: undefined };
    for (const h of beforeExe) h(opts);
    const result = fn.apply(getThis(), opts.args);
    opts.result = result;
    for (const h of afterExe) h(opts);
    return opts.result;
  }) as T & HookedFunction;
  return attach(w);
}

// ===== 钩子注册表（集中安装 / 卸载）=====
// 标记约定：core 钩子打 __coreHook（系统级），user 钩子打 __userHook；二者皆带 __name / __hookId。

interface HookRec {
  fn: HookFn;
  target: HookedFunction;
  phase: 'before' | 'after';
  id: string;
  name: string;
  toolName: string;
}

// id → 记录（含 target，便于按 id 反向摘除，无需枚举全部钩子目标）
const byId = new Map<string, HookRec>();
// toolName → 该工具登记的全部 hookId（卸载时一次性清理）
const byTool = new Map<string, Set<string>>();

// 被 lazy-wrap 过的函数记录：关闭 hooks 时经此还原为 original（恢复全部过程）。
interface WrappedRec { host: any; prop: string; name: string; wrapped: HookedFunction; original: Function; }
const wrapedFns = new Map<HookedFunction, WrappedRec>();

// 宿主引用（由 hooksTool.register 捕获；调用方可经 opts.agentRef/execRef 显式覆盖，解耦启动顺序）。
let _agent: AgentLike | null = null;
let _exec: ExecutorLike | null = null;

// 目标名 → 宿主对象 + 属性名（宿主即被 hook 的函数所在处，包裹后需就地替换回来）。
// 名即下方 resolveHookTarget 解析的钩子目标：sendMessage / engine / run / chat / requestApproval / storageSet。
export function resolveHookTarget(
  name: string,
  agentRef?: AgentLike,
  execRef?: ExecutorLike,
): { host: any; prop: string } | null {
  const agent = agentRef ?? _agent;
  const exec = execRef ?? _exec;
  switch (name) {
    case 'sendMessage': return agent ? { host: agent, prop: 'sendMessage' } : null;
    case 'engine': return agent ? { host: agent, prop: 'engine' } : null;
    case 'run': return exec ? { host: exec, prop: 'run' } : null;
    case 'requestApproval': return exec ? { host: exec, prop: 'requestApproval' } : null;
  case 'chat': return { host: llm, prop: 'chat' };
  case 'storageSet': return { host: storage, prop: 'set' };
  case 'storageDelete': return { host: storage, prop: 'del' };
  default: return null;
  }
}

// 当前已挂载（被懒包裹过）的钩子目标名清单——从注册表反向枚举，无需预设列表。
export function listHookedTargetNames(): string[] {
  return Array.from(new Set([...wrapedFns.values()].map((r) => r.name)));
}

// 解析并返回某目标当前的「可 hook 包裹函数」（供 hooks.view 读取 beforeExe/afterExe）；
// 目标从未被包裹则返回 null。单一来源，替代原 executor.resolveTarget。
export function getHookedTarget(
  name: string,
  agentRef?: AgentLike,
  execRef?: ExecutorLike,
): HookedFunction | null {
  const ref = resolveHookTarget(name, agentRef, execRef);
  if (!ref) return null;
  const fn = ref.host[ref.prop] as HookedFunction | undefined;
  return fn && (fn as unknown as { __hooked?: boolean }).__hooked ? fn : null;
}

function markHook(fn: HookFn, id: string, name: string, core: boolean): HookFn {
  const f = fn as HookFn & Record<string, unknown>;
  f.__hookId = id;
  f.__name = name;
  if (core) {
    f.__coreHook = true;
    f.__userHook = false;
  } else {
    f.__userHook = true;
    f.__coreHook = false;
  }
  return fn;
}

// 把 fn 从目标数组摘除（仅运行期）
function detach(rec: HookRec): void {
  const arr = (rec.target as unknown as Record<string, HookFn[]>)[rec.phase + 'Exe'];
  const i = arr.findIndex((f) => (f as unknown as Record<string, unknown>).__hookId === rec.id);
  if (i >= 0) arr.splice(i, 1);
}

export interface InstallHookOpts {
  id?: string; // 稳定 id（core 钩子应固定，便于幂等/辨识）；缺省自动生成
  name?: string; // 可读名（hooks.view 显示）
  toolName?: string; // 调用方工具名（登记到 byTool，卸载时清理）
  core?: boolean; // true=系统钩子（__coreHook）；false=用户钩子（__userHook）
  agentRef?: AgentLike; // 覆盖模块级 _agent（用于 installHook 早于 hooks.register 的边界场景）
  execRef?: ExecutorLike; // 覆盖模块级 _exec
}

// 安装一个钩子到指定目标（按名）的 phase 阶段。
// ★ 懒包裹：若目标尚未被钩（无 __hooked），自动经 wrapHook 包裹并就地替换回宿主属性，仅包裹一次（登记 wrapedFns）。
//   约定（规范，非强制）：仅在工具 register 环节调用。
// 幂等：同 id 重装时就地替换（re-register 用新 ctx 闭包覆盖旧的），不累积重复钩子。
export function installHook(
  targetName: string,
  phase: 'before' | 'after',
  fn: HookFn,
  opts: InstallHookOpts = {},
): HookFn {
  const ref = resolveHookTarget(targetName, opts.agentRef, opts.execRef);
  if (!ref) {
    console.warn('[MiniAgent] 未知/不可解析的钩子目标:', targetName);
    return fn;
  }
  let target = ref.host[ref.prop] as HookedFunction | undefined;
  // 懒包裹：目标未被钩 → 自动 wrapHook 并就地替换回宿主属性，记录 original 以便关闭时还原。
  if (!target || !(target as unknown as { __hooked?: boolean }).__hooked) {
    if (!target) {
      console.warn('[MiniAgent] 钩子目标不存在，无法包裹:', targetName);
      return fn;
    }
    const original = target as unknown as (...args: any[]) => any;
    const wrapped = wrapHook(original, ref.host); // thisArg = 宿主对象（自动绑定，无需迟绑）
    ref.host[ref.prop] = wrapped;
    wrapedFns.set(wrapped, { host: ref.host, prop: ref.prop, name: targetName, wrapped, original });
    target = wrapped;
    console.log('[MiniAgent] 自动 wrapHook:', targetName);
  }

  const id = opts.id ?? 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const name = opts.name ?? 'hook';
  const marked = markHook(fn, id, name, opts.core === true);
  const arr = (target as unknown as Record<string, HookFn[]>)[phase + 'Exe'];
  const existing = arr.findIndex((f) => (f as unknown as Record<string, unknown>).__hookId === id);
  if (existing >= 0) {
    arr[existing] = marked; // 就地替换（re-register 刷新 ctx 闭包，避免重复累积）
  } else {
    arr.push(marked);
  }
  const rec: HookRec = { fn: marked, target, phase, id, name, toolName: opts.toolName ?? '' };
  byId.set(id, rec);
  if (opts.toolName) {
    if (!byTool.has(opts.toolName)) byTool.set(opts.toolName, new Set());
    byTool.get(opts.toolName)!.add(id);
  }
  return marked;
}

// 按 id 卸载：摘除运行期 + 清持久化（供 hooks.removeHook 用户动作）。
export function uninstallHookById(id: string): boolean {
  const rec = byId.get(id);
  if (!rec) return false;
  detach(rec);
  byId.delete(id);
  if (rec.toolName) byTool.get(rec.toolName)?.delete(id);
  storage.del(NS.HOOKS, id); // 同步清持久化（用户钩子真相源）
  return true;
}

// 按名卸载全部同名用户钩子（供 removeHook name=）。
export function uninstallHookByName(name: string): number {
  let n = 0;
  for (const rec of [...byId.values()]) {
    if (rec.name === name && (rec.fn as unknown as Record<string, unknown>).__userHook) {
      if (uninstallHookById(rec.id)) n++;
    }
  }
  return n;
}

// 工具卸载时一次性清理：摘除其登记的全部钩子的运行期数组（不删持久化——
// 持久化供下次重载 rehydrate 重建，或用 removeHook 显式删除）。返回清理数量。
export function uninstallToolHooks(toolName: string): number {
  const ids = byTool.get(toolName);
  if (!ids || ids.size === 0) return 0;
  let n = 0;
  for (const id of [...ids]) {
    const rec = byId.get(id);
    if (!rec) continue;
    detach(rec);
    byId.delete(id);
    n++;
  }
  byTool.delete(toolName);
  return n;
}

// 关闭 hooks：把全部被 lazy-wrap 的函数还原为原始过程（恢复全部过程），并清空注册表。
// 仅当宿主属性仍是我们的包裹时才还原，避免误伤；还原后清空 wrapedFns。
export function restoreAllWrapped(): void {
  for (const rec of wrapedFns.values()) {
    if (rec.host[rec.prop] === rec.wrapped) {
      rec.host[rec.prop] = rec.original;
    }
  }
  wrapedFns.clear();
  byId.clear();
  byTool.clear();
}

// 重建用户钩子：读 hooks 命名空间全部描述符 → 编译 → installHook 挂接（登记到注册表，便于 removeHook / 卸载清理）。
// installHook 按 desc.target 名解析并懒包裹，故 hooks 的 call 无需预设 target 清单。
// executor 经 agentRef.executor 注入（避免本模块运行期 import executor，保持无循环依赖）。
export function rehydrateHooks(agentRef: AgentLike): void {
  for (const id of storage.keys(NS.HOOKS)) {
    const desc = storage.get<{ id: string; name: string; target: string; phase: string; code: string }>('hooks', id);
    if (!desc || !desc.code) continue;
    try {
      const wrapped = compileHook(desc.code, desc.name, agentRef);
      // installHook 按名解析 + 懒包裹 + 登记（toolName='hooks'，便于 removeHook 按 id/名移除、卸载时一次性清理）
      installHook(desc.target, (desc.phase === 'after' ? 'after' : 'before'), wrapped as HookFn, {
        id: desc.id,
        name: desc.name,
        toolName: 'hooks',
        core: false,
        agentRef,
        execRef: agentRef.executor,
      });
      console.log('[MiniAgent] 重建钩子:', desc.name, '→', desc.target + '.' + desc.phase);
    } catch (e) {
      console.warn('[MiniAgent] 重建钩子失败:', desc.name, e);
    }
  }
}

// ===== 钩子工具：注册即初始化（捕获宿主引用）；挂接由 installHook 懒包裹 =====
import type { ToolDef } from '../core/executor';

export const hooksTool: ToolDef & { wrapHook: typeof wrapHook; installHook: typeof installHook; uninstallToolHooks: typeof uninstallToolHooks } = {
  name: 'hooks',
  author: 'sys',
  description:
    '钩子系统（内置工具）：提供 wrapHook 方法，把普通函数包成可挂 before/after 钩子的函数；集中管理钩子的安装/卸载（installHook / uninstallHookById / uninstallHookByName / uninstallToolHooks / restoreAllWrapped）。包裹是懒的：首次给某目标挂钩时自动 wrapHook 并就地替换回宿主（维护 wrapedFns）。关闭本工具时 restoreAllWrapped 把全部被包裹函数还原为原始过程，不留悬挂钩子。各工具在 register 环节经 installHook 挂接系统钩子（如 session 落盘）。' +
    '同时作为用户/LLM 界面，提供 action：view（查看实时编排快照：各钩子目标 sendMessage/engine/run/chat/requestApproval/storageSet/storageDelete 的运行期钩子清单（含 name 与 id）+ 工具清单 + 引擎（endpoint 的 model/baseURL））/ addHook（热挂接用户钩子，需传 name/target/phase/code；code 为钩子体，签名 (opts, agent, storage, executor, console)，可经 opts.args 改写请求体（chat.before 里改 opts.args[0].messages/.tools/.model/温度等即可在请求发出前编辑完整 ChatRequestBody））/ removeHook（移除用户钩子，需传 hookId 或 name；按 name 移除所有同名用户钩子）。addHook/removeHook 执行前均弹确认框。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'addHook', 'removeHook'],
        description: 'view=查看快照(默认)；addHook=挂接用户钩子；removeHook=移除用户钩子',
      },
      name: { type: 'string', description: 'addHook 时钩子显示名；removeHook 时按名移除（移除所有同名用户钩子）。与 hookId 二选一' },
      target: {
        type: 'string',
        enum: ['sendMessage', 'engine', 'run', 'chat', 'requestApproval', 'storageSet', 'storageDelete'],
        description: 'addHook 时挂接到哪个钩子目标（storageSet=storage.set 前落盘；storageDelete=storage.del 前清落盘）',
      },
      phase: { type: 'string', enum: ['before', 'after'], description: 'addHook 时 before/after 阶段（默认 before）' },
      code: {
        type: 'string',
        description: 'addHook 时的钩子体源码。会被包成 (opts, agent, storage, executor, console) => void：可通过改写 opts.args 影响行为（如 chat.before 里改 opts.args[0].messages / .tools / .model / 温度等，即可在请求发出前编辑完整请求体 ChatRequestBody）；agent/storage/executor/console 为运行时上下文。示例："console.log(opts.args);"。',
      },
      hookId: { type: 'string', description: 'removeHook 时目标钩子 id（与 name 二选一）' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  // 对外提供钩子能力方法（用户要求：钩子能力以工具方法形态暴露，统一经 agent.tools.get('hooks') 调用，
  // 避免散装全局声明）：wrapHook 包裹函数；installHook/uninstallToolHooks 安装/卸载钩子。
  wrapHook,
  installHook,
  uninstallToolHooks,
  // 注册 = 初始化：仅捕获宿主引用，不预包裹任何函数。包裹延后到 installHook（首次挂钩时自动发生）。
  // 约定：hooks 必须在其它会 installHook 的工具之前注册（defaultTools 首位），确保 _agent/_exec 已就绪；
  // 调用方亦可经 opts.agentRef/execRef 显式传入，进一步解耦启动顺序。
  register(ctx: RegisterCtx): void {
    _agent = ctx.agent;
    _exec = ctx.executor;
    console.log('[MiniAgent] 钩子系统已初始化（懒包裹：首次挂钩时自动 wrapHook，关闭时还原全部）');
  },
  // 关闭 = 恢复全部过程：把被 hook 包裹的函数还原为原始实现，并清空注册表。
  unregister(_ctx: RegisterCtx): void {
    restoreAllWrapped();
    console.log('[MiniAgent] 钩子系统已关闭，已还原全部被包裹函数');
  },
  // 用户/LLM 界面：view 快照 + addHook/removeHook（原 orchestrate 工具的 call，已并入本工具）。
  // 不 import executor：经 ctx.executor 取 list/requestApproval，保持本模块无循环依赖。
  call: async (args, ctx) => {
    const action = String(args.action ?? 'view');
    if (action === 'view') {
      const hooksSnap: Record<string, { before: { name: string; id: string | null }[]; after: { name: string; id: string | null }[] }> = {};
      for (const t of listHookedTargetNames()) {
        const fn = getHookedTarget(t, ctx.agent, ctx.executor);
        // 懒包裹下，某些目标可能从未被挂钩（仍是原始函数，无 beforeExe/afterExe）→ 视为空列表，不报错。
        const hooked = fn && (fn as unknown as { __hooked?: boolean }).__hooked ? fn : null;
        // 每个钩子带 name + id（user 钩子有 id，core 钩子也有稳定 id + 可读名）——便于编排查看与按名/按 id 排序
        const describe = (f: any): { name: string; id: string | null } => {
          if (f.__userHook) return { name: String(f.__name ?? 'userHook'), id: (f.__hookId as string) ?? null };
          if (f.__coreHook) return { name: String(f.__name ?? 'system'), id: (f.__hookId as string) ?? null };
          return { name: '(core)', id: null };
        };
        hooksSnap[t] = {
          before: hooked ? hooked.beforeExe.map(describe) : [],
          after: hooked ? hooked.afterExe.map(describe) : [],
        };
      }
      const cfg = ctx.agent.config;
      return JSON.stringify(
        {
          hooks: hooksSnap,
          tools: ctx.executor.list(true).map((t) => ({ name: t.name, author: t.author, hasCall: typeof t.call === 'function' })),
          engine: {
            endpoint: { model: cfg.model, baseURL: cfg.baseURL },
          },
        },
        null,
        2,
      );
    }
    if (action === 'addHook') {
      const codeStr = String(args.code ?? '');
      const ok = await ctx.executor.requestApproval({ name: 'hooks.addHook', riskLevel: 'high', code: codeStr }, ctx.agent);
      if (!ok) return '已取消';
      const target = String(args.target ?? '');
      if (!resolveHookTarget(target, ctx.agent, ctx.executor)) return `未知 target: ${args.target}`;
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
      // installHook 按名解析 + 懒包裹 + 登记（toolName='hooks'，便于 removeHook / 卸载时一次性清理）+ 持久化
      installHook(target, (phase === 'after' ? 'after' : 'before'), wrapped as HookFn, {
        id,
        name,
        toolName: 'hooks',
        core: false,
        agentRef: ctx.agent,
        execRef: ctx.executor,
      });
      storage.set(NS.HOOKS, id, { id, name, target, phase, code: codeStr });
      return `已挂接用户钩子 ${name} → ${target}.${phase}（id=${id}），刷新不丢`;
    }
    if (action === 'removeHook') {
      const id = String(args.hookId ?? '');
      const name = String(args.name ?? '');
      if (!id && !name) return 'removeHook 需提供 hookId 或 name（按 name 移除所有同名用户钩子）';
      const ok = await ctx.executor.requestApproval({ name: 'hooks.removeHook', riskLevel: 'high', code: id || name }, ctx.agent);
      if (!ok) return '已取消';
      // 回收：经集中式钩子 API 按 id / 名移除（同时清持久化；core 钩子经 __userHook 过滤不在此移除）
      let removed = 0;
      if (id) removed += uninstallHookById(id) ? 1 : 0;
      else if (name) removed += uninstallHookByName(name);
      return removed ? `已移除 ${removed} 个钩子（id=${id || '-'} name=${name || '-'}）` : `未找到匹配钩子（id=${id || '-'} name=${name || '-'}）`;
    }
    return `未知 action: ${action}（支持 view/addHook/removeHook）`;
  },
};
