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

// ---- basement 核心经 @require 引入 ----
// GreasyFork 要求 @require 的 jsDelivr gh 引用必须是不可变的 40 位 commit SHA（tag/branch 会被拒），
// 故此处钉死 basement-0.2.7 的提交 SHA；basement 发新版本时需同步更新此 SHA。
// 本地开发可设 MINIAGENT_BASEMENT_URL 指向本地静态服务器（如 http://localhost:4174/miniagent-basement.js），免去重新发 tag。
const basementSha = '6859708db9fa4973a5ebfcedcd814a78243aa5aa';
const basementUrl =
  process.env.MINIAGENT_BASEMENT_URL ??
  `https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@${basementSha}/dist/miniagent-basement.js`;

// MiniAgent 构建配置（极简版）：纯原生 TS + 手写 DOM，无 React / antd / langchain / 任何框架
// markdown 渲染交给外部引入的 marked / DOMPurify：通过 @require 在安装期由 Tampermonkey 拉取并缓存
export default defineConfig(async ({ mode, command }) => {
  // 调试态：本地 dev（serve）或 test 构建授予 unsafeWindow；production 构建保持标准用户脚本空间
  const isDebug = command === 'serve' || mode === 'test';
  // 省略 @updateURL / @downloadURL：GreasyFork 与 jsDelivr 各自安装源自动从托管处拉更新，
  // 既规避站外更新源合规风险，也保持 jsDelivr 分支推送即生效的自动化（安装后管理器从原安装源更新）。
  return {
    plugins: [
      monkey({
        entry: 'src/agent.ts',
        userscript: {
          name: 'MiniAgent',
          namespace: 'https://github.com/chensiyi/MiniAgent',
          author: 'chensiyi',
          version,
          description: '极简 userScript 智能体（原生 DOM + GM 桥接 LLM；核心经 @require 引入 basement 全局 MiniAgent）',
          license: 'https://www.apache.org/licenses/LICENSE-2.0', // 脚本许可声明：Apache-2.0（完整 URL，Tampermonkey / GreasyFork 均识别）
          match: ['*://*/*'], // 注入范围（后续脚本管理可控）
          noframes: true, // 仅注入顶层文档：一个标签页可能内嵌多个 iframe，避免脚本在子 frame 内重复实例化
          grant: [
            'GM_addStyle', 'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues',
            // dev serve 与 test 构建授予 unsafeWindow（调试态：控制台直调 agent）；production 构建不挂页面主世界。
            ...(isDebug ? (['unsafeWindow'] as const) : []),
          ],
          connect: ['*'], // 直连 LLM 域名（动态）；后续脚本管理可收敛
          // basement 核心经 @require 引入（当前版本，jsDelivr 按 tag 分发）：运行时仅绑定 executor↔agent + 注册内核 hooks，不自动启动其余工具；
          // 启动编排交给 tool_manager：宿主以两参 definePreset([gmStorage, hooks], [gmStorage, ...defaultTools, ui]) 注入预装宇宙后调用 bootstrap 统一编排（base 在线 → disabledTools 过滤 all → 重建用户工具），
          // 依赖仅活在工具自身 deps 图（hooks ← gm_storage ← ui），内核退化为哑注册表，不打包任何核心源码。
          require: [
            basementUrl,
            // 核心渲染库经 @require 引入（钉精确版本，保证内容不可变、命中 GreasyFork CDN 白名单）：
            // 安装期由 Tampermonkey 拉取并缓存（一次），运行时直接读隔离世界全局。
            // 仅外国 CDN（用户要求"用国外的"）；不内联进产物、不占脚本体、无跨世界问题。
            'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
            'https://cdn.jsdelivr.net/npm/dompurify@3.4.12/dist/purify.min.js',
          ],
          // 省略 @updateURL / @downloadURL（见上方说明）。
        },
      }),
    ],
    build: {
      // 默认 `npm run build`（production）保持压缩，供 jsDelivr 分发；
      // `npm run build:raw`（--mode raw）关闭压缩，产可读明文供 GreasyFork 提交（其要求脚本不得压缩/混淆）。
      minify: mode === 'raw' ? false : true,
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
