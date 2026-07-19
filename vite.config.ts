import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

// MiniAgent 构建配置（极简版）：纯原生 TS + 手写 DOM，无 React / antd / langchain / 任何框架
// 全部内联进单文件 userscript，零 @require、零 CDN 依赖，任何页面即开即用
export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/agent.ts',
      userscript: {
        name: 'MiniAgent',
        namespace: 'https://github.com/chensiyi/MiniAgent',
        description: '极简 userScript 智能体（原生 DOM + GM 桥接 LLM）',
        match: ['*://*/*'], // 注入范围（后续脚本管理可控）
        grant: ['GM_addStyle', 'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues', 'GM_xmlhttpRequest', 'unsafeWindow'],
        connect: ['*'], // 直连 LLM 域名（动态）；后续脚本管理可收敛
      },
    }),
  ],
  build: {
    // 沙箱环境下 vite 的 emptyOutDir 会走"安全删除"(genie-trash) 并超时，导致 build 失败；
    // 关闭它，直接覆盖写入 dist，绕开对回收站的依赖
    emptyOutDir: false,
  },
});
