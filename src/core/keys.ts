// 纯常量键（无依赖的叶子模块）：集中存放 key 类常量，打破 executor ↔ tool_manager 的循环依赖。
// SYS_AUTHOR 此前定义在 executor.ts，并在 tool_manager 顶层求值期被引用，导致纯 Node 下模块加载
// 触发 TDZ（Cannot access 'SYS_AUTHOR' before initialization）。挪到叶子模块后该循环被切断。
// 系统作者默认标识：新工具未指定 author 时默认取此值（用户 2026-07-20："所有工具作者都叫sys"）。
export const SYS_AUTHOR = 'sys';
