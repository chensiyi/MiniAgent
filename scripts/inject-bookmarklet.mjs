// 把 dist/bookmarklet.url.txt 的启动器代码注入 docs/index.template.html，
// 生成 GitHub Pages 实际服务的 docs/index.html（含真实可拖拽的 bookmarklet 链接）。
// 在 `npm run build` 之后自动运行，保证启动器代码永远与 dist/ 同步。
import { readFileSync, writeFileSync } from 'node:fs';

const raw = readFileSync('dist/bookmarklet.url.txt', 'utf8').trim();

// HTML 属性转义：& " < > 必须转义，否则会破坏 href 属性解析。
// 保留原始 #（启动器里的 # 在 javascript: URI 中按整段执行，与你现在能用的粘贴版一致）。
const esc = raw
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const tpl = readFileSync('docs/index.template.html', 'utf8');
const out = tpl
  .replace('@BOOKMARKLET_CODE@', esc)
  .replace('@BOOKMARKLET_CODE_JSON@', JSON.stringify(raw));

writeFileSync('docs/index.html', out);
console.log('[inject-bookmarklet] 已生成 docs/index.html（启动器代码已注入）');
