// 验证书签加载器：① 开/关 toggle；② 真单例（旧版无 id 的残留 iframe 会被清除，避免叠层挡交互）。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const loader = readFileSync('dist/bookmarklet.url.txt', 'utf-8').replace(/^javascript:/, '');

const mkDom = () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  return dom;
};
const run = (dom) => new Function('document', loader)(dom.window.document);
const disp = (dom) => {
  const f = dom.window.document.getElementById('miniagent-iframe');
  return f ? { exists: true, display: f.style.display || '(empty=可见)' } : { exists: false };
};
const countIframes = (dom) => dom.window.document.querySelectorAll('iframe').length;

let ok = true;
const check = (label, pass, detail) => {
  if (!pass) ok = false;
  console.log(`${pass ? '✓' : '✗'} ${label}: ${detail}`);
};

// ---- 场景 1：开/关 toggle ----
{
  const dom = mkDom();
  const g = (i) => disp(dom);
  run(dom); const a = g(1);
  run(dom); const b = g(2);
  run(dom); const c = g(3);
  run(dom); const d = g(4);
  check('toggle 点1=创建可见', JSON.stringify(a) === JSON.stringify({ exists: true, display: '(empty=可见)' }), JSON.stringify(a));
  check('toggle 点2=隐藏', JSON.stringify(b) === JSON.stringify({ exists: true, display: 'none' }), JSON.stringify(b));
  check('toggle 点3=显示', JSON.stringify(c) === JSON.stringify({ exists: true, display: '(empty=可见)' }), JSON.stringify(c));
  check('toggle 点4=隐藏', JSON.stringify(d) === JSON.stringify({ exists: true, display: 'none' }), JSON.stringify(d));
  check('toggle 始终单实例', countIframes(dom) === 1, 'iframe 数=' + countIframes(dom));
}

// ---- 场景 2：旧版无 id 残留 iframe（模拟换新加载器前已开着的旧 UI）----
{
  const dom = mkDom();
  // 模拟旧加载器留下的 iframe：无 id，src 含 host.html，且可见（之前能交互的单实例）
  const old = dom.window.document.createElement('iframe');
  old.src = 'http://localhost:5174/host.html'; // 旧版也指向同一 host
  old.style.display = '';
  dom.window.document.body.appendChild(old);
  check('前置：存在 1 个旧 iframe', countIframes(dom) === 1, 'iframe 数=' + countIframes(dom));

  // 点击新加载器一次
  run(dom);
  const after = disp(dom);
  check('点击后：旧 iframe 被清除', countIframes(dom) === 1, 'iframe 数=' + countIframes(dom));
  check('点击后：仅剩带 id 的新实例且可见', after.exists && after.display === '(empty=可见)', JSON.stringify(after));
  check('点击后：新实例有 id', !!dom.window.document.getElementById('miniagent-iframe'), 'id 存在');

  // 再点一次应切换为隐藏（toggle 正常）
  run(dom);
  const toggled = disp(dom);
  check('再点：切换为隐藏', toggled.display === 'none', JSON.stringify(toggled));
  check('再点：仍单实例', countIframes(dom) === 1, 'iframe 数=' + countIframes(dom));
}

console.log(ok ? '\nALL_OK=true' : '\nALL_OK=false');
process.exit(ok ? 0 : 1);
