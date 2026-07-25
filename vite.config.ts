import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import fs from 'fs';

// 调试态（unsafeWindow 授予 + 挂主世界）由"运行环境"决定，而非 git 分支：
// - `npm run dev`（vite serve）：授予 unsafeWindow，HMR 热更 + DevTools 控制台直调 agent；
// - `npm run test`（vite build --mode test）：授予 unsafeWindow，供 Tampermonkey 检查更新拉取调试构建；
// - `npm run build`（默认 production）：标准用户脚本空间，不污染页面主世界。
// 单分支即可区分调试/发布，不再依赖 git 分支名（避免 CI detached HEAD 等静默翻转）。

// ---- 秒级版本号：package.json base + 构建时间戳 YYYYMMDDHHmmss（每次 build 必递增）----
// Tampermonkey 按 . 分段比较版本号，末段 14 位时间戳递增即判定为"有更新" → 检查更新即可秒级拉取。
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version: string };
const buildStamp = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const version = `${pkg.version}.${buildStamp}`;

// ---- basement 核心经 @require 引入（当前版本，jsDelivr 按 tag 分发）----
// 本地开发可设 MINIAGENT_BASEMENT_URL 指向本地静态服务器（如 http://localhost:4174/miniagent-basement.js），
// 免去每次改 basement 后重新发 tag。产物需先在 basement 分支 `npm run build` 产出 dist/miniagent-basement.js。
const basementVersion = '0.2.6';
const basementUrl =
  process.env.MINIAGENT_BASEMENT_URL ??
  `https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@basement-${basementVersion}/dist/miniagent-basement.js`;

// MiniAgent 构建配置（极简版）：纯原生 TS + 手写 DOM，无 React / antd / langchain / 任何框架
// markdown 渲染交给外部引入的 marked / DOMPurify：通过 @require 在安装期由 Tampermonkey 拉取并缓存
export default defineConfig(async ({ mode, command }) => {
  // 调试态：本地 dev（serve）或 test 构建授予 unsafeWindow；production 构建保持标准用户脚本空间
  const isDebug = command === 'serve' || mode === 'test';
  // 更新源：production 构建指向 CDN（jsDelivr 按 dev 分支分发产物）；本地 dev / test 走 localhost:4173 preview
  // 注意：发布源依赖 dev 分支的 dist/ 已 `git add -f` 入库并推送（同 basement 的发布策略），否则该 CDN 地址会 404。
  const updateURL =
    mode === 'production'
      ? 'https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@dev/dist/miniagent.user.js'
      : 'http://localhost:4173/miniagent.user.js';
  return {
    plugins: [
      monkey({
        entry: 'src/agent.ts',
        userscript: {
          name: 'MiniAgent',
          namespace: 'https://github.com/chensiyi/MiniAgent',
          version,
          description: '极简 userScript 智能体（原生 DOM + GM 桥接 LLM；核心经 @require 引入 basement 全局 MiniAgent）',
          match: ['*://*/*'], // 注入范围（后续脚本管理可控）
          noframes: true, // 仅注入顶层文档：一个标签页可能内嵌多个 iframe，避免脚本在子 frame 内重复实例化
          grant: [
            'GM_addStyle', 'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues',
            // dev serve 与 test 构建授予 unsafeWindow（调试态：控制台直调 agent）；production 构建不挂页面主世界。
            ...(isDebug ? (['unsafeWindow'] as const) : []),
          ],
          connect: ['*'], // 直连 LLM 域名（动态）；后续脚本管理可收敛
          // basement 核心经 @require 引入（当前版本，jsDelivr 按 tag 分发）：运行时仅绑定 executor↔agent + 注册内核 hooks，不自动启动其余工具；
          // 启动编排交给 tool_manager：宿主注入预装宇宙（[gmStorage, ...defaultTools, ui]）后调用 bootstrap 统一编排（infra 在线 → disabledTools 过滤 → 重建用户工具），
          // 依赖仅活在工具自身 deps 图（hooks ← gm_storage ← ui），内核退化为哑注册表，不打包任何核心源码。
          require: [
            basementUrl,
            // 核心渲染库经 @require 引入：安装期由 Tampermonkey 拉取并缓存（一次），运行时直接读隔离世界全局。
            // 仅外国 CDN（用户要求"用国外的"）；不内联进产物、不占脚本体、无跨世界问题。
            'https://cdn.jsdelivr.net/npm/marked@12/marked.min.js',
            'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js',
          ],
          downloadURL: updateURL,
          updateURL,
        },
      }),
    ],
    build: {
      // 沙箱环境下 vite 的 emptyOutDir 会走"安全删除"(genie-trash) 并超时，导致 build 失败；
      // 关闭它，直接覆盖写入 dist，绕开对回收站的依赖
      emptyOutDir: false,
    },
    // 预览服务器：统一测试入口，供 Tampermonkey 检查更新秒级拉取最新脚本
    preview: {
      host: true,
      port: 4173,
    },
  };
});
