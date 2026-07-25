// bookmarklet 分支专用构建配置（去掉 vite-plugin-monkey，产出独立 IIFE + 宿主页 + javascript: 加载器）。
// 发布走 @bookmarklet 分支引用；本地测试用 MINIAGENT_BOOKMARKLET_HOST 指本地静态服务。
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const hostUrl =
  process.env.MINIAGENT_BOOKMARKLET_HOST ||
  'https://chensiyi.github.io/MiniAgent/host.html';

export default defineConfig({
  resolve: {
    alias: {
      // bookmarklet 环境：把油猴虚拟模块 '$' 映射到本分支的 iframe 垫片
      $: resolve(__dirname, 'bookmarklet/env.ts'),
    },
  },
  build: {
    outDir: 'dist-bookmarklet',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'bookmarklet/bootstrap.ts'),
      formats: ['iife'],
      name: 'MiniAgentBookmarklet',
      fileName: () => 'bookmarklet.js',
    },
    minify: false,
  },
  plugins: [
    {
      name: 'bookmarklet-post',
      closeBundle() {
        const out = resolve(__dirname, 'dist-bookmarklet');
        fs.mkdirSync(out, { recursive: true });
        // 拷贝固定宿主页（iframe 的 src，决定存储绑定到的固定源）
        fs.copyFileSync(resolve(__dirname, 'bookmarklet/host.html'), resolve(out, 'host.html'));
        // 生成 javascript: 加载器（创建指向 host.html 的 iframe）
        const loader =
          'javascript:(function(){var f=document.createElement("iframe");' +
          'f.src=' +
          JSON.stringify(hostUrl) +
          ';' +
          'f.style.cssText="position:fixed;top:0;right:0;width:380px;height:100%;border:0;z-index:2147483647";' +
          'document.body.appendChild(f);})()';
        fs.writeFileSync(resolve(out, 'bookmarklet.url.txt'), loader);
        // eslint-disable-next-line no-console
        console.log('[bookmarklet] host.html + bookmarklet.js + bookmarklet.url.txt 已生成 -> ' + out);
      },
    },
  ],
});
