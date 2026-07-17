import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import monkey from 'vite-plugin-monkey';

// MiniAgent 构建配置：把 Vite + React + TS 工程打成 Tampermonkey/Violentmonkey userScript
// 重库（react/react-dom/dayjs/antd）经 build.externalGlobals 外链 CDN（生成 @require），缩小 .user.js 体积
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
      // 注意：antd v5 UMD 依赖 react/react-dom/dayjs 三个全局先挂好
      // 用国内镜像 cdn.npmmirror.com 更稳；build.externalGlobals 自动生成 @require
      build: {
        externalGlobals: {
          react: ['React', 'https://cdn.npmmirror.com/react@18/umd/react.production.min.js'],
          'react-dom': ['ReactDOM', 'https://cdn.npmmirror.com/react-dom@18/umd/react-dom.production.min.js'],
          dayjs: ['dayjs', 'https://cdn.npmmirror.com/dayjs@1/dayjs.min.js'],
          antd: ['antd', 'https://cdn.npmmirror.com/antd@5/dist/antd.min.js'],
        },
      },
    }),
  ],
});
