import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import monkey from 'vite-plugin-monkey';

// MiniAgent 构建配置：把 Vite + React + TS 工程打成 Tampermonkey/Violentmonkey userScript
// 重库（react/react-dom/dayjs/antd）直接打进 bundle，不依赖任何 CDN @require
// —— 镜像源（npmmirror）已失效、且 CDN 版本须与安装版本死同步（360 滞后新版），故全打包最稳
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
    }),
  ],
});
