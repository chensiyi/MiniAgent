/// <reference path="./basement.d.ts" />

import { uiTool } from './tools/ui';
import { gmStorageTool } from './tools/gm_storage';

// 消费经 @require 引入的 basement 全局（运行时仅绑定 executor↔agent，IIFE 已注册内核 hooks；不自动启动其余工具）。
// 启动编排完全交给 tool_manager：注入完整预装宇宙（含环境层工具 gm_storage / ui），由 bootstrap 统一编排。
//  - 依赖关系只活在工具自身 deps 图（hooks ← gm_storage ← ui），由 registerAll 内部拓扑序处理，内核不另设优先级层；
//  - 预装宇宙以两参 definePreset(baseTools, allTools) 注入（basement-0.2.7 两参模型）：
//      baseTools = 基础底座（gm_storage 存储层 + hooks 内核），始终先注册、不可经开关关闭；
//      allTools = 完整预装（baseTools 去重 + defaultTools + ui），按 config.disabledTools 过滤后注册；
//  - bootstrap 内部按 disabledTools 过滤 allTools 并按 deps 拓扑注册，最后重建用户持久化工具；
//  - 两参模型下宿主层需区分 base/all：base 为不可关的底座，all 为含用户可关项的完整宇宙。
const { agent, toolManager, defaultTools } = MiniAgent;
const hooksTool = defaultTools.find((t) => t.name === 'hooks');

toolManager.definePreset([gmStorageTool, hooksTool!], [gmStorageTool, ...defaultTools, uiTool]); // baseTools=基础底座（先注册、不可关）；allTools=完整预装（按 disabledTools 过滤）
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
