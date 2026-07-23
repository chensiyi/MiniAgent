// sandbox.ts：沙箱编译家族（用户代码编译的唯一入口）。
//
// 设计（用户 2026-07-21 / 2026-07-23 抽取）：运行期任何动态编译
// （工具 call/register/unregister 重建、run_js 自我执行、hooks 用户钩子）
// 必须经由本模块编译，禁止在调用链路里散落裸 new Function。统一点：
//   1) 强制 "use strict"；
//   2) 仅暴露显式注入的形参（ctx / opts / agent…，绝不暴露模块作用域或全局敏感对象）；
//   3) 编译失败原样抛出，由调用方 try/catch 转成用户可读错误。
// 这样沙箱边界只在一处定义，便于审计与加固。
//
// 本模块运行时仅依赖叶子模块 storage（不产生循环依赖）；对 executor 仅做类型导入
// （类型在编译期擦除，不引入运行期循环）。钩子编译需注入 executor 时，经
// compileHook 的 agentRef.executor 取得，而不在本模块运行期 import executor。
import { storage } from './storage';
import type { ToolDesc, ToolDef, RunCtx, RegisterCtx, AgentLike } from './executor';

const SANDBOX_HEADER = '"use strict";\n';

// 唯一底层构造器：所有编译入口共用，确保沙箱定义不分叉、可一处审计。
function createSandboxFn(argNames: string[], body: string): (...a: any[]) => any {
  return new Function(...argNames, SANDBOX_HEADER + body) as (...a: any[]) => any;
}

// 编译"函数表达式"源码（工具描述符的 call/register/unregister 是 (args,ctx)=>… 表达式）。
function compileFn(code: string): (...a: any[]) => any {
  const c = code.trim().replace(/;\s*$/, '');
  return createSandboxFn([], `return (${c});`) as (...a: any[]) => any;
}

// 编译"函数体"源码（run_js / 用户钩子：拿注入的形参直接执行）。
export function compileBody(argNames: string[], code: string): (...a: any[]) => any {
  return createSandboxFn(argNames, code);
}

// 由持久化描述符构造最小 ToolDef：call 永远由 code 编译（重建即重编译）；register/unregister 可选。
export function buildToolFromDesc(desc: ToolDesc): ToolDef {
  const call = compileFn(desc.code) as (args: Record<string, unknown>, ctx: RunCtx) => string;
  const tool: ToolDef = {
    name: desc.name,
    author: desc.author,
    description: desc.description,
    parameters: desc.parameters,
    deps: desc.deps,
    riskLevel: desc.riskLevel,
    call,
  };
  if (desc.register) tool.register = compileFn(desc.register) as (ctx: RegisterCtx) => void;
  if (desc.unregister) tool.unregister = compileFn(desc.unregister) as (ctx: RegisterCtx) => void;
  return tool;
}

// 把钩子体编译成安全包装函数：用户 fn 抛错不会影响主循环；打 __userHook/__name 标记供 view 区分来源。
// executor 经 agentRef.executor 注入（避免本模块运行期 import executor，保持无循环依赖）。
export function compileHook(code: string, name: string, agentRef: AgentLike): ((opts: any) => void) & Record<string, unknown> {
  const userFn = compileBody(['opts', 'agent', 'storage', 'executor', 'console'], code) as (
    opts: any,
    agent: any,
    storage: any,
    executor: any,
    console: Console,
  ) => void;
  const wrapped = ((hookOpts: any) => {
    try {
      userFn(hookOpts, agentRef, storage, agentRef.executor, console);
    } catch (e) {
      console.error('[hook]', name, e);
    }
  }) as ((opts: any) => void) & Record<string, unknown>;
  wrapped.__userHook = true;
  wrapped.__name = name;
  return wrapped;
}
