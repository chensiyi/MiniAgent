/// <reference path="./basement.d.ts" />

import { uiTool } from './tools/ui';
import { gmStorageTool } from './tools/gm_storage';

// 消费经 @require 引入的 basement 全局（运行时仅绑定 executor↔agent，IIFE 已注册内核 hooks；不自动启动其余工具）。
const { agent, executor, defaultTools, extraBuiltinTools } = MiniAgent;

// 显式分段注册（dev 编排启动过程）：
// ① 先注册 gm_storage：其 register 把 GM_* 镜像进内存 Map（此后 agent.config 才是真实持久化值）。
// ② 再按 config.disabledTools 过滤注册默认工具 + UI（依赖 hooks 已就绪、config 已镜像）。
// ③ 重建用户保存的自编排工具（运行期创建并持久化的工具）。
// 用户钩子为内存级临时调试对象，不持久化、不重建（设计如此）。
executor.registerAll([gmStorageTool]); // ① 镜像 GM_*（register 内完成）
const disabled = new Set(agent.config.disabledTools ?? []);
const builtins = [...defaultTools, ...extraBuiltinTools].filter(
  (t) => !disabled.has(t.name) && t.name !== 'hooks', // hooks 已由 IIFE 注册，排除避免重复
);
executor.registerAll([...builtins, uiTool]); // ② 默认工具（剔除黑名单）+ UI（经 deps:[gm_storage] 排在其后）
executor.rehydrateTools(); // ③ 重建用户保存的自编排工具

// 暴露全局单例（标准用户脚本空间：沙箱内 globalThis，便于运行时 / LLM 动态编辑）
(globalThis as unknown as { agent: Agent }).agent = agent;

// 仅 dev 分支额外挂到 unsafeWindow，使 DevTools 控制台可直接访问（补偿 userscript 沙箱隔离）；
// 发布分支（main/master 等）一律不挂，避免与页面主世界互相影响。
declare const __BUILD_BRANCH__: string;
if (__BUILD_BRANCH__ === 'dev') {
  const uw = (globalThis as unknown as { unsafeWindow?: typeof globalThis }).unsafeWindow;
  if (uw) (uw as Record<string, unknown>).agent = agent;
}
