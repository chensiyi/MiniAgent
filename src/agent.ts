/// <reference path="./basement.d.ts" />

import { uiTool } from './tools/ui';
import { storageTool } from './tools/bookmarklet_local_storage';

// 消费经 CDN <script> 引入的 basement 全局（运行时仅绑定 executor↔agent，IIFE 已注册内核 hooks；不自动启动其余工具）。
// 启动编排完全交给 tool_manager：注入预装宇宙（含环境层工具 storage / ui），由 bootstrap 统一编排。
//  - basement 的 definePreset 仅收【单个】完整工具列表（内部 T = 该列表，第二参数会被忽略）；
//    因此 storage + defaultTools + ui 合并为一份传入，否则含 ui 的 allTools 会被丢弃。
//  - 依赖关系只活在工具自身 deps 图（hooks ← storage ← ui），由 registerAll 内部拓扑序处理，内核不另设优先级层；
//  - 其余预装项按 config.disabledTools 过滤；
//  - 最后重建用户持久化工具（运行期创建并持久化的工具）。
const { agent, toolManager, defaultTools } = MiniAgent;

// ⚠️ 单参：完整预装列表（含 storage/ui）；其余按 disabledTools 过滤；
// bootstrap 内部拓扑序处理 hooks ← storage ← ui 依赖。
toolManager.definePreset([storageTool, ...defaultTools, uiTool]);
toolManager.bootstrap(); // 启动编排（按 disabledTools 过滤预装 → 重建用户工具）

// 暴露全局单例（iframe 全局作用域，便于运行时 / LLM 动态编辑）
(globalThis as unknown as { agent: Agent }).agent = agent;

// 仅调试构建（npm run dev 的 serve，或 npm run test → vite build --mode test）额外挂到 window，
// 使 DevTools 控制台可直接访问；
// 生产构建（npm run build，mode=production）一律不挂，避免与页面主世界互相影响。
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  const uw = (globalThis as unknown as { unsafeWindow?: typeof globalThis }).unsafeWindow;
  if (uw) (uw as Record<string, unknown>).agent = agent;
}
