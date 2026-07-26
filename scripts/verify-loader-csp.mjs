import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TM_URL = 'https://github.com/chensiyi/MiniAgent/tree/tampermonkey';
const loaderBody = readFileSync(resolve('dist/bookmarklet.url.txt'), 'utf-8').trim().replace(/^javascript:/, '');
function assert(c, m){ if(!c){ console.error('  FAIL ' + m); process.exitCode = 1; } else { console.log('  ok ' + m); } }
function run(url){
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously', url });
  const w = dom.window;
  w.eval(loaderBody);
  return { w, iframe: w.document.getElementById('miniagent-iframe') };
}

// 严格站点：iframe 因 CSP 等异常无法加载（无 frame-ok）→ 超时后提示去油猴脚本版
{
  console.log('[strict] no frame-ok -> tip to tampermonkey');
  const { w, iframe } = run('https://github.com/');
  assert(!!iframe, 'iframe created');
  await new Promise(r => setTimeout(r, 1700));
  const tip = w.document.getElementById('miniagent-csp-tip');
  assert(!!tip, 'tip shown after timeout');
  const a = tip && tip.querySelector('a');
  assert(a && a.href === TM_URL && a.target === '_blank', 'link -> tampermonkey branch');
  assert(tip && tip.textContent.includes('油猴脚本版'), 'tip mentions 油猴脚本版');
}

// 宽松站点：收到 frame-ok → 不提示、注入越狱桥
{
  console.log('[loose] frame-ok -> no tip');
  const { w, iframe } = run('https://example.com/');
  assert(!!iframe, 'iframe created');
  const src = iframe.contentWindow || iframe;
  w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'ma:frame-ok' }, source: src }));
  await new Promise(r => setTimeout(r, 1700));
  assert(!w.document.getElementById('miniagent-csp-tip'), 'no tip after frame-ok');
  assert(!!w.document.getElementById('ma-bridge'), 'bridge injected on loose site');
}

console.log('VERIFY=' + (process.exitCode ? 'FAILED' : 'OK'));
