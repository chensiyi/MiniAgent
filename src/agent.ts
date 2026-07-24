/// <reference path="./basement.d.ts" />

import { uiTool } from './tools/ui';
import { gmStorageTool } from './tools/gm_storage';

// 消费经 @require 引入的 basement 全局（运行时已自动 init：注册核心默认工具、读 config）
const { agent, executor } = MiniAgent;

// basement 已自动 init 并注册核心默认工具；此处叠加油猴环境能力（GM_* 存储 + UI）。
// 顺序：先装 GM_* 镜像与落盘钩子（gm_storage 把 GM_* 镜像进内存 Map，覆盖 init 时种子出的默认 config，
// 引擎运行期 agent.config 实时读 storage → 拿到真实 apiKey），再挂载 UI 接管输出槽。
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
