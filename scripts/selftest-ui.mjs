// 自测：验证构建产物满足「固定宽 + 右下角锚定 + 高度自适应(只调高度、不横向扩充)」。
//
// 要守住的回归点（即用户反复踩的坑）：
//   - 面板绝不能横向撑宽（旧 bug：root 用 width:max-content 且 ResizeObserver 回传 width → 左右扩充/被裁）。
//   - 浮窗必须落在右下角（由加载器 iframe 的 right:16px;bottom:16px 决定，root 自身不再用 position:fixed 钉角）。
//   - 只调高度：加载器 ma:resize 改 f.style.height、不得改 f.style.width；bundle 回传的是 height 而非 width。
//   - 气泡区内部滚动（flex:1 1 auto; overflow-y:auto），上下滑动体验保持。
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const bundle = readFileSync(new URL('../dist/bookmarklet.js', import.meta.url), 'utf-8');
const loader = readFileSync(new URL('../dist/bookmarklet.url.txt', import.meta.url), 'utf-8');

// 1) 从产物抽取 ui.ts 的 STYLE 模板字符串（按反引号定位）
const anchor = 'STYLE = `';
const open = bundle.indexOf(anchor);
if (open === -1) { console.error('FAIL: 在 bookmarklet.js 中找不到 STYLE 定义'); process.exit(1); }
const start = open + anchor.length;
const close = bundle.indexOf('`', start);
const STYLE = bundle.slice(start, close);

// 2) 注入 jsdom 文档，构造 #miniagent-root 并读取计算样式（验证规则确实挂上）
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="miniagent-root"></div></body></html>', { pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
const styleEl = doc.createElement('style');
styleEl.textContent = STYLE;
doc.head.appendChild(styleEl);
const root = doc.getElementById('miniagent-root');
const cs = window.getComputedStyle(root);

const checks = [];
function check(name, cond, detail) { checks.push({ name, ok: !!cond, detail: detail ?? '' }); }

// 3) root 规则体（规则文本解析，不依赖 jsdom 布局引擎）
const rootRule = STYLE.match(/#miniagent-root\{([^}]*)\}/);
const rootBody = rootRule ? rootRule[1] : '';
const bubblesRule = STYLE.match(/\.ma-bubbles\{([^}]*)\}/);
const bubblesBody = bubblesRule ? bubblesRule[1] : '';

// —— 关键回归：不得横向扩充 ——
check('root 不含 width:max-content（左右撑宽根因）', !/width:max-content/.test(rootBody), rootBody.slice(0, 90));
check('root 不含 max-width:420px', !/max-width:420px/.test(rootBody), '');
check('root 不含 min-width:300px', !/min-width:300px/.test(rootBody), '');
// —— root 自身不再用 position:fixed 钉角（右下角改由 iframe 决定）——
check('root 为 position:relative', /position:relative/.test(rootBody), '');
check('root 宽度 100%（填满固定宽 iframe）', /width:100%/.test(rootBody), '');
check('root 高度 100%（填满 iframe，气泡区借此 flex 滚动）', /height:100%/.test(rootBody), '');
check('root 不再 position:fixed 钉角', !/position:fixed/.test(rootBody), '');
check('规则文本确实挂载（计算样式 position=relative）', cs.position === 'relative', `position=${JSON.stringify(cs.position)}`);
// —— 气泡区内部滚动（上下滑动）——
check('bubbles flex:1 1 auto', /flex:1 1 auto/.test(bubblesBody), bubblesBody.slice(0, 90));
check('bubbles overflow-y:auto', /overflow-y:auto/.test(bubblesBody), '');
check('bubbles min-height:0（回退原 ui：短对话不撑高、贴输入）', /min-height:0\b/.test(bubblesBody), bubblesBody.slice(0, 90));
check('bubbles 不再 min-height:60px', !/min-height:60px/.test(bubblesBody), '');
check('bubbles justify-content:flex-end（钉在底部贴输入框往上叠；补偿 iframe 固定高，等同油猴版行为）', /justify-content:flex-end/.test(bubblesBody), '');

// 4) 加载器 iframe 锚定右下角 + 固定宽
check('iframe 右下角锚定 right:16px;bottom:16px', /right:16px;bottom:16px/.test(loader), '');
check('iframe 固定宽 width:360px', /width:360px/.test(loader), '');
check('iframe 不再 top:16px（非满高贴右、改为底部锚定向上生长）', !/top:16px/.test(loader), '');

// 5) ma:resize 只调高度、不调宽度（横向扩充的另一道闸）
check('加载器 ma:resize 改 f.style.height', /f\.style\.height=/.test(loader), '');
check('加载器 ma:resize 不再改 f.style.width（防左右扩充）', !/f\.style\.width=/.test(loader), '');
check('加载器 ma:resize 不再有 160px 最小钳制（面板随内容收拢、无底部空白）', !/Math\.max\(160/.test(loader), '');

// 6) bundle 回传的是 height 而非 width（minify 后 type 与 height 跨行，按实质载荷判断）
check('bundle 回传 ma:resize 用 height 字段', /"ma:resize"/.test(bundle) && /height:\s*chrome\s*\+\s*content/.test(bundle), '');
check('bundle 不再回传 ma:resize 用 width 字段', !/width:\s*(root\.scrollWidth|Math\.max\(root)/.test(bundle), '');

// 7) 折叠按钮视觉位置：DOM 在首位（等同油猴版干净结构），但用 CSS order 重排
//    展开态：bubbles(1) → toggle(2) → input-row(3) → tools-panel(4)，toggle 在气泡与发送框之间
//    折叠态：.ma-collapsed{justify-content:flex-end} 把唯一可见的 toggle 推到底部
const bubblesRule2 = STYLE.match(/\.ma-bubbles\{([^}]*)\}/);
const inputRule = STYLE.match(/\.ma-input-row\{([^}]*)\}/);
const toggleRule = STYLE.match(/\.ma-toggle\{([^}]*)\}/);
const toolsRule = STYLE.match(/\.ma-tools-panel\{([^}]*)\}/);
check('bubbles order:1（展开态 toggle 在气泡下方）', /\border:\s*1/.test(bubblesRule2 ? bubblesRule2[1] : ''), '');
check('toggle order:2（展开态在发送框上方）', /\border:\s*2/.test(toggleRule ? toggleRule[1] : ''), '');
check('input-row order:3', /\border:\s*3/.test(inputRule ? inputRule[1] : ''), '');
check('tools-panel order:4', /\border:\s*4/.test(toolsRule ? toolsRule[1] : ''), '');
check('.ma-collapsed 折叠态 justify-content:flex-end（toggle 落底）', /\.ma-collapsed\{[^}]*justify-content:flex-end/.test(STYLE), '');
const bubblesIdx2 = bundle.indexOf('<div class="ma-bubbles"');
const toggleIdx2 = bundle.indexOf('<button class="ma-toggle"');
const inputIdx2 = bundle.indexOf('<div class="ma-input-row"');
const toolsIdx = bundle.indexOf('<div class="ma-tools-panel"');
check('DOM 顺序：toggle 在首位（toggle<bubbles<input<tools），等同油猴版干净结构', toggleIdx2 < bubblesIdx2 && bubblesIdx2 < inputIdx2 && inputIdx2 < toolsIdx, `toggle=${toggleIdx2},b=${bubblesIdx2},i=${inputIdx2},t=${toolsIdx}`);

// 8) 工具面板不横向溢出：width:100% + box-sizing:border-box，行也受 max-width 约束
const toolsPanelRule = STYLE.match(/\.ma-tools-panel\{([^}]*)\}/);
const toolsPanelBody = toolsPanelRule ? toolsPanelRule[1] : '';
const toolRowRule = STYLE.match(/\.ma-tool-row\{([^}]*)\}/);
const toolRowBody = toolRowRule ? toolRowRule[1] : '';
check('工具面板 width:100% 填满 root', /width:100%/.test(toolsPanelBody), '');
check('工具面板 box-sizing:border-box 防止 padding/border 撑出 iframe', /box-sizing:border-box/.test(toolsPanelBody), '');
check('工具行 max-width:100% 防溢出', /max-width:100%/.test(toolRowBody), '');

// 9) 输出
let failed = 0;
for (const c of checks) {
  const tag = c.ok ? 'PASS' : 'FAIL';
  if (!c.ok) failed++;
  console.log(`[${tag}] ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
}
console.log('\n产物 #miniagent-root 规则体:\n  ' + rootBody.slice(0, 160));
console.log(failed === 0
  ? '\n✅ 全部通过：固定宽360 + 右下角锚定 + 仅高度自适应（无横向扩充）+ 气泡区内部滚动。'
  : `\n❌ ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
