import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import fs from 'fs';
import { execSync } from 'child_process';

// 构建时注入当前 git 分支，决定"是否向页面主世界挂载 agent"：
// - dev 分支：额外挂到 unsafeWindow，方便 DevTools 控制台直接访问调试；
// - main/master 等发布分支：保持"标准用户脚本空间"（仅沙箱内 globalThis，不污染页面主世界、不与页面互相影响）。
function getBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}
const branch = getBranch();
const isDevBranch = branch === 'dev';

// ---- 秒级版本号：package.json base + 构建时间戳 YYYYMMDDHHmmss（每次 build 必递增）----
// Tampermonkey 按 . 分段比较版本号，末段 14 位时间戳递增即判定为"有更新" → 检查更新即可秒级拉取。
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version: string };
const buildStamp = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const version = `${pkg.version}.${buildStamp}`;

// ---- 统一测试更新源：本地 preview（端口 4173），Tampermonkey 检查更新即从 localhost 拉取 ----
const updateURL = 'http://localhost:4173/miniagent.user.js';

// MiniAgent 构建配置（极简版）：纯原生 TS + 手写 DOM，无 React / antd / langchain / 任何框架
// markdown 渲染交给外部引入的 marked（经 @require 注入为全局变量，不内联进产物），并由 DOMPurify 清洗 XSS
export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/agent.ts',
      userscript: {
        name: 'MiniAgent',
        namespace: 'https://github.com/chensiyi/MiniAgent',
        version,
        description: '极简 userScript 智能体（原生 DOM + GM 桥接 LLM）',
        match: ['*://*/*'], // 注入范围（后续脚本管理可控）
        // 外部 JS 依赖（@require 注入为全局变量，运行期从 CDN 加载，不打包进产物）
        require: [
          'https://cdn.jsdelivr.net/npm/marked@12/marked.min.js',
          'https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js',
        ],
        grant: [
          'GM_addStyle', 'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues', 'GM_xmlhttpRequest',
          // 仅 dev 分支授予 unsafeWindow：发布分支不挂页面主世界，保持标准用户脚本空间
          ...(isDevBranch ? (['unsafeWindow'] as const) : []),
        ],
        connect: ['*'], // 直连 LLM 域名（动态）；后续脚本管理可收敛
        downloadURL: updateURL,
        updateURL,
      },
    }),
  ],
  define: {
    // 注入分支名，供运行时判断是否需要挂载 unsafeWindow
    __BUILD_BRANCH__: JSON.stringify(branch),
  },
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
});
