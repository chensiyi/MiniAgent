/// <reference path="./basement.d.ts" />

import { uiTool } from './tools/ui';
import { gmStorageTool } from './tools/gm_storage';

// 消费经 @require 引入的 basement 全局（运行时仅绑定 executor↔agent，IIFE 已注册内核 hooks；不自动启动其余工具）。
// 启动编排完全交给 tool_manager：注入预装宇宙（含环境层工具 gm_storage / ui），由 bootstrap 统一编排。
//  - 依赖关系只活在工具自身 deps 图（hooks ← gm_storage ← ui），由 registerAll 内部拓扑序处理，内核不另设优先级层；
//  - baseTools（hooks 已在 IIFE 注册、gm_storage 为存储底座）始终先注册、不可经开关关闭；
//  - 其余预装项（allTools）按 config.disabledTools 过滤；最后重建用户持久化工具（运行期创建并持久化的工具）。
const { agent, toolManager, defaultTools } = MiniAgent;
const hooksTool = defaultTools.find((t) => t.name === 'hooks');

toolManager.definePreset([gmStorageTool, hooksTool!], [gmStorageTool, ...defaultTools, uiTool]); // baseTools=基础能力（先注册）；allTools=完整预装（按 disabledTools 过滤）+ 环境层 UI
toolManager.bootstrap(); // 启动编排（baseTools 在线 → 按 disabledTools 过滤 allTools → 重建用户工具）

// 暴露全局单例（标准用户脚本空间：沙箱内 globalThis，便于运行时 / LLM 动态编辑）
(globalThis as unknown as { agent: Agent }).agent = agent;

// 仅 dev 分支额外挂到 unsafeWindow，使 DevTools 控制台可直接访问（补偿 userscript 沙箱隔离）；
// 发布分支（main/master 等）一律不挂，避免与页面主世界互相影响。
declare const __BUILD_BRANCH__: string;
if (__BUILD_BRANCH__ === 'dev') {
  const uw = (globalThis as unknown as { unsafeWindow?: typeof globalThis }).unsafeWindow;
  if (uw) (uw as Record<string, unknown>).agent = agent;
}
