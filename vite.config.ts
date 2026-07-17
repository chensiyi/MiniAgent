import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import monkey from 'vite-plugin-monkey';

// MiniAgent 构建配置：把 Vite + React + TS 工程打成 Tampermonkey/Violentmonkey userScript
// react/react-dom/dayjs 是干净 UMD，经 build.externalGlobals 外链 jsdelivr 公共 CDN（生成 @require）
// ⚠️ antd v5 的 dist/antd.min.js 是 webpack+esl 加载器打包，内部 require('react-dom') 走自己的模块注册表、
//    找不到 @require 注入的全局 ReactDOM → 报 [MODULE_MISS]"react-dom" is not exists!
//    故 antd 不打外链、改由 vite 用其 ESM 打进 bundle（无 esl 坑），仅引用全局 React/ReactDOM/dayjs
export default defineConfig({
  plugins: [
    react(),
    monkey({
      entry: 'src/app/main.tsx',
      userscript: {
        name: 'MiniAgent',
        namespace: 'https://github.com/chensiyi/MiniAgent',
        description: 'React + langchain.js + Ant Design 驱动的 userScript 智能体',
        match: ['*://*/*'], // 注入范围（后续脚本管理可控）
        grant: ['GM_addStyle', 'GM_setValue', 'GM_getValue', 'GM_xmlhttpRequest'],
        connect: ['*'], // 直连 LLM 域名（动态）；后续脚本管理可收敛
      },
      // 用外网公共 CDN jsdelivr（精确版本，对齐 node_modules 安装），避免镜像源失效/版本滞后
      build: {
        externalGlobals: {
          react: ['React', 'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js'],
          'react-dom': ['ReactDOM', 'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js'],
          dayjs: ['dayjs', 'https://cdn.jsdelivr.net/npm/dayjs@1.11.21/dayjs.min.js'],
        },
      },
    }),
  ],
});
