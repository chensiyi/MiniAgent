import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// MiniAgent 构建配置（极简版）：纯原生 TS + 手写 DOM，无 React / antd / langchain / 任何框架
// 全部内联进单文件 userscript，零 @require、零 CDN 依赖，任何页面即开即用

// 从 package.json 读语义化 base 版本，再拼秒级构建时间戳 → 每次 build @version 必递增
// 秒级精度保证本地快速连续 build 也递增；Tampermonkey 按 `.` 分段比较数字大小
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const d = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const buildStamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const VERSION = `${pkg.version}.${buildStamp}`;

// 分支感知更新源：
//   dev    → 本地 preview 服务（http://localhost:4173），持续发布测试，改完 build 即可让油猴拉新版本，无需 push
//   master → GitHub raw（正式发布），build + push 后 Tampermonkey 定期检查更新
// 切换分支即切换更新源，一份配置两分支都正确。无 git 环境时降级 master。
const BRANCH = (() => {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim(); }
  catch { return 'master'; }
})();
const IS_DEV = BRANCH === 'dev';
const SCRIPT_URL = IS_DEV
  ? 'http://localhost:4173/miniagent.user.js'
  : 'https://raw.githubusercontent.com/chensiyi/MiniAgent/master/dist/miniagent.user.js';

export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/agent.ts',
      userscript: {
        name: 'MiniAgent',
        namespace: 'https://github.com/chensiyi/MiniAgent',
        version: VERSION,
        description: `极简 userScript 智能体（原生 DOM + GM 桥接 LLM）${IS_DEV ? ' [dev]' : ''}`,
        match: ['*://*/*'], // 注入范围（后续脚本管理可控）
        updateURL: SCRIPT_URL,
        downloadURL: SCRIPT_URL,
        grant: ['GM_addStyle', 'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues', 'GM_xmlhttpRequest', 'GM_addValueChangeListener', 'unsafeWindow'],
        connect: ['*'], // 直连 LLM 域名（动态）；后续脚本管理可收敛
      },
    }),
  ],
  build: {
    // 沙箱环境下 vite 的 emptyOutDir 会走"安全删除"(genie-trash) 并超时，导致 build 失败；
    // 关闭它，直接覆盖写入 dist，绕开对回收站的依赖
    emptyOutDir: false,
  },
  preview: {
    port: 4173, // 与 dev 分支 updateURL 指向一致
    host: true, // 允许局域网设备访问（同网段手机/其他机器可拉取测试）
  },
});
