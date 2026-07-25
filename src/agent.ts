/// <reference path="./basement.d.ts" />

import { uiTool } from './tools/ui';
import { gmStorageTool } from './tools/gm_storage';

// 消费经 @require 引入的 basement 全局（运行时仅绑定 executor↔agent，不自动 init）。
const { agent, executor } = MiniAgent;

// basement 不自动启动：本脚本仅叠加油猴环境能力（GM_* 存储 + UI）。
// 胶水只负责一次 registerAll：gm_storage.register 自包含「镜像 GM_* → 触发 boot() → 装落盘钩子」，
// ui 经 deps:[gm_storage] 排在 boot 之后挂载（此时 hooks/默认工具已就绪、输出槽接管）。
// UI 工具（含 launcher/headless 还原）已随 src/tools/ui.ts 一并归入 tools，模块加载时自管 createLauncher。
executor.registerAll([gmStorageTool, uiTool]);

// 暴露全局单例（标准用户脚本空间：沙箱内 globalThis，便于运行时 / LLM 动态编辑）
(globalThis as unknown as { agent: Agent }).agent = agent;

// 仅 dev 分支额外挂到 unsafeWindow，使 DevTools 控制台可直接访问（补偿 userscript 沙箱隔离）；
// 发布分支（main/master 等）一律不挂，避免与页面主世界互相影响。
declare const __BUILD_BRANCH__: string;
if (__BUILD_BRANCH__ === 'dev') {
  const uw = (globalThis as unknown as { unsafeWindow?: typeof globalThis }).unsafeWindow;
  if (uw) (uw as Record<string, unknown>).agent = agent;
}
