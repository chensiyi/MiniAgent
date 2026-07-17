import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import monkey from 'vite-plugin-monkey';

// MiniAgent 构建配置：把 Vite + React + TS 工程打成 Tampermonkey/Violentmonkey userScript
// 重库（react/react-dom/dayjs/antd）经 build.externalGlobals 外链 jsdelivr 公共 CDN（生成 @require），缩小 .user.js 体积
// —— 实测 jsdelivr/unpkg 均 200 通；antd v5 UMD 仅依赖 react/react-dom/dayjs（icons 已内置），故只需 4 条 @require
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
      // 注意：antd v5 UMD 依赖 react/react-dom/dayjs 三个全局先挂好，故顺序排在最后
      // 用外网公共 CDN jsdelivr（精确版本，对齐 node_modules 安装），避免镜像源失效/版本滞后
      build: {
        externalGlobals: {
          react: ['React', 'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js'],
          'react-dom': ['ReactDOM', 'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js'],
          dayjs: ['dayjs', 'https://cdn.jsdelivr.net/npm/dayjs@1.11.21/dayjs.min.js'],
          antd: ['antd', 'https://cdn.jsdelivr.net/npm/antd@5.29.3/dist/antd.min.js'],
        },
      },
    }),
  ],
});
