// withHooks：把普通函数包成"可 hook 的普通函数"。
// - 调用方签名不变（无 .call()、非 class 实例），仍 fn(...args) 正常调，无感。
// - beforeExe / afterExe 为钩子数组；钩子签名 (opts) => void | Promise<void>。
// - opts = { args, result }：before 可改 opts.args，after 读 opts.result。
// - 返回值严格跟随 base：async→Promise、sync→原值、生成器→返回生成器（仅 before 钩子）。
// - 控制流（确认闸、运行态兜底）放 base，不靠 skip/replace escape（呼应"调用方返回无变化"）。
// - thisArg：透传给 fn.apply(thisArg, args)，使被包函数体内 this 指向局部上下文；
//   既支持包时立即传（withHooks(fn, ctx)），也支持声明后迟绑（wrapped.__thisArg = ctx）——
//   避免"在模块对象自身的初始化器里引用自身"导致的 TDZ。调用方可经 this 快速访问局部上下文并进行相关操作。

export type HookOpts = { args: any[]; result: any };
export type HookFn = (opts: HookOpts) => void | Promise<void>;

export interface HookedFunction {
  (...args: any[]): any;
  beforeExe: HookFn[];
  afterExe: HookFn[];
  __thisArg?: any;
}

function kindOf(fn: Function): 'asyncGenerator' | 'generator' | 'async' | 'sync' {
  const name = fn.constructor ? fn.constructor.name : '';
  if (/AsyncGeneratorFunction/.test(name)) return 'asyncGenerator';
  if (/GeneratorFunction/.test(name)) return 'generator';
  if (/AsyncFunction/.test(name)) return 'async';
  return 'sync';
}

export function withHooks<T extends (...args: any[]) => any>(
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
    wRef = w;
    return w;
  };

  // 运行期取 this：优先已迟绑的 __thisArg（声明后赋值，避免 TDZ），否则回落包时传入的 thisArg。
  const getThis = (): any =>
    wRef ? (wRef as HookedFunction & { __thisArg?: any }).__thisArg : thisArg;

  const kind = kindOf(fn as unknown as Function);

  // 异步生成器（如 llm.streamChat）：返回 AsyncGenerator，仅 before 钩子（惰性、after 无法落点）。
  if (kind === 'asyncGenerator') {
    const w = (async function* (...args: any[]) {
      const opts: HookOpts = { args, result: undefined };
      for (const h of beforeExe) await h(opts);
      yield* (fn.apply(getThis(), opts.args) as AsyncGenerator);
    }) as T & HookedFunction;
    return attach(w);
  }

  // 同步生成器：返回 Generator，仅 before 钩子。
  if (kind === 'generator') {
    const w = (function* (...args: any[]) {
      const opts: HookOpts = { args, result: undefined };
      for (const h of beforeExe) h(opts);
      yield* (fn.apply(getThis(), opts.args) as Generator);
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
