/// <reference path="./basement.d.ts" />

import { uiTool } from './tools/ui';
import { gmStorageTool } from './tools/gm_storage';

// 消费经 @require 引入的 basement 全局（运行时仅绑定 executor↔agent，IIFE 已注册内核 hooks；不自动启动其余工具）。
// 启动编排完全交给 tool_manager：注入完整预装宇宙（含环境层工具 gm_storage / ui），由 bootstrap 统一编排。
//  - 依赖关系只活在工具自身 deps 图（hooks ← gm_storage ← ui），由 registerAll 内部拓扑序处理，内核不另设优先级层；
//  - 预装宇宙以单参 definePreset(tools) 注入（basement-0.2.6 单参；hooks 已在 defaultTools 内、gm_storage/ui 为宿主层补充）；
//  - bootstrap 内部按 disabledTools 过滤并按 deps 拓扑注册，最后重建用户持久化工具；
//  - baseTools/infra 概念由 basement 内部处理（已注册工具不可经开关关闭），宿主层不再区分 base/all。
const { agent, toolManager, defaultTools } = MiniAgent;

toolManager.definePreset([gmStorageTool, ...defaultTools, uiTool]); // 单参：完整预装宇宙（gm_storage/ui 为宿主层补充，hooks 已在 defaultTools 内）
toolManager.bootstrap(); // 启动编排（按 disabledTools 过滤 → 按 deps 拓扑注册 → 重建用户工具）

// 暴露全局单例（标准用户脚本空间：沙箱内 globalThis，便于运行时 / LLM 动态编辑）
(globalThis as unknown as { agent: Agent }).agent = agent;

// 仅调试构建（npm run dev 的 serve，或 npm run test → vite build --mode test）额外挂到 unsafeWindow，
// 使 DevTools 控制台可直接访问（补偿 userscript 沙箱隔离）；
// 生产构建（npm run build，mode=production）一律不挂，避免与页面主世界互相影响。
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  const uw = (globalThis as unknown as { unsafeWindow?: typeof globalThis }).unsafeWindow;
  if (uw) (uw as Record<string, unknown>).agent = agent;
}
