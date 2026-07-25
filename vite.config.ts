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
    outDir: 'dist',
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
        const out = resolve(__dirname, 'dist');
        fs.mkdirSync(out, { recursive: true });
        // 拷贝固定宿主页（iframe 的 src，决定存储绑定到的固定源）
        // 同时注入 cache-buster（?v=时间戳），绕过 jsDelivr 7天 CDN 缓存
        const v = '?v=' + Date.now();
        let html = fs.readFileSync(resolve(__dirname, 'bookmarklet/host.html'), 'utf-8');
        html = html.replace(/bookmarklet\.js(\s*["'>])/g, 'bookmarklet.js' + v + '$1');
        fs.writeFileSync(resolve(out, 'host.html'), html);
        // 同时输出到 docs/，供 GitHub Pages（源 = bookmarklet 分支 + /docs）以站点根提供 text/html
        const docs = resolve(__dirname, 'docs');
        fs.mkdirSync(docs, { recursive: true });
        fs.writeFileSync(resolve(docs, 'host.html'), html);
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
        console.log('[bookmarklet] host.html + bookmarklet.js + bookmarklet.url.txt 已生成 -> ' + out + ' (Pages 用 docs/host.html)');
      },
    },
  ],
});
