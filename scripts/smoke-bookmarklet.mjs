// 无头冒烟测试：用 jsdom 在本地加载 basement + dist/bookmarklet.js，
// 捕获控制台日志，定位「UI 为何未被 bootstrap 注册 / 不挂载」的根因。
// 无需浏览器，由 node 直接运行：node scripts/smoke-bookmarklet.mjs
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)); // D:/dev/MiniAgent/

// 1. 从 src/host.html 提取 basement URL（与用户浏览器一致）
const hostHtml = fs.readFileSync(root + 'src/host.html', 'utf-8');
const bmMatch = hostHtml.match(/src="([^"]*miniagent-basement[^"]*)"/);
const basementUrl = bmMatch
  ? bmMatch[1]
  : 'https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@basement-0.2.6/dist/miniagent-basement.js';
console.log('[smoke] basement URL:', basementUrl);

// 2. 拉 basement 源码
let basementSrc;
try {
  const resp = await fetch(basementUrl);
  if (!resp.ok) {
    console.error('[smoke] 拉取 basement 失败 HTTP', resp.status, resp.statusText);
    process.exit(1);
  }
  basementSrc = await resp.text();
  console.log('[smoke] basement 源码长度:', basementSrc.length);
} catch (e) {
  console.error('[smoke] 拉取 basement 异常:', e);
  process.exit(1);
}

const bmSrc = fs.readFileSync(root + 'dist/bookmarklet.js', 'utf-8');
console.log('[smoke] bookmarklet 源码长度:', bmSrc.length);

// 3. 起 jsdom（dangerously 才能真正执行注入的 <script>）
const dom = new JSDOM(
  '<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>',
  {
    url: 'https://chensiyi.github.io/MiniAgent/host.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  },
);
const { window } = dom;

// stub 渲染库（jsdom 不拉外部 CDN；ui 注册阶段不调用 marked/DOMPurify，仅保底）
window.marked = { parse: (s) => s };
window.DOMPurify = { sanitize: (s) => s };

// 捕获 console（含对象展开）
const logs = [];
for (const m of ['log', 'warn', 'error', 'info', 'debug']) {
  window.console[m] = (...a) => {
    const line =
      `[${m}] ` +
      a
        .map((x) =>
          typeof x === 'string'
            ? x
            : x && x.stack
              ? x.stack
              : JSON.stringify(x, (_k, v) => (typeof v === 'function' ? '[fn]' : v)),
        )
        .join(' ');
    logs.push(line);
  };
}

// 4. 注入 basement（建立 window.MiniAgent）
const s1 = window.document.createElement('script');
s1.textContent = basementSrc;
window.document.body.appendChild(s1);
console.log('[smoke] 注入 basement 后 window.MiniAgent =', typeof window.MiniAgent);

// 5. 注入 bookmarklet（IIFE，顶层 void main() 立即执行）
const s2 = window.document.createElement('script');
s2.textContent = bmSrc;
window.document.body.appendChild(s2);

// 6. 等 main() 的 async 链完成
await new Promise((r) => setTimeout(r, 1500));

console.log('\n===== CAPTURED CONSOLE =====');
for (const l of logs) console.log(l);

console.log('\n===== DOM STATE =====');
console.log('miniagent-root 存在:', !!window.document.getElementById('miniagent-root'));
const launcher = window.document.getElementById('miniagent-launcher');
console.log('miniagent-launcher 存在:', !!launcher);
console.log('launcher display:', launcher ? launcher.style.display || '(空=默认显示)' : '(无)');
