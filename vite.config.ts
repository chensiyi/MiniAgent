// bookmarklet 分支专用构建配置（产出独立 IIFE + 宿主页 + javascript: 加载器）。
// 两种模式唯一区别：一组地址。
//   - 生产（npm run build，默认）：bookmarklet.js 走 jsDelivr @bookmarklet（dist/），宿主页走 GitHub Pages；发 tag 时 dist/ 一并入库供 CDN 拉取。
//   - test（npm run test）：bookmarklet.js 与宿主页都走本地 http://localhost:5174，改代码无需推 CDN 即可见效。
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@bookmarklet/dist';
const PAGES_HOST = 'https://chensiyi.github.io/MiniAgent/host.html';
const LOCAL_HOST = 'http://localhost:5174/host.html';
const LOCAL_JS = 'http://localhost:5174/bookmarklet.js';
const CDN_JS_MARKER =
  'https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@bookmarklet/dist/bookmarklet.js?v=2026072604';

export default defineConfig(({ mode }) => {
  const test = mode === 'test';

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, 'src/bootstrap.ts'),
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
          const dist = resolve(__dirname, 'dist');
          const docs = resolve(__dirname, 'docs');
          fs.mkdirSync(dist, { recursive: true });
          fs.mkdirSync(docs, { recursive: true });

          const bundlePath = resolve(dist, 'bookmarklet.js');
          const jsSrc = (test ? LOCAL_JS : CDN_BASE + '/bookmarklet.js') + '?v=' + Date.now();
          const hostUrl = test ? LOCAL_HOST : PAGES_HOST;

          // 宿主页：把模板里的 CDN js 地址替换为目标地址
          let html = fs.readFileSync(resolve(__dirname, 'src/host.html'), 'utf-8');
          html = html.replace(CDN_JS_MARKER, jsSrc);
          fs.writeFileSync(resolve(docs, 'host.html'), html);

          // bookmarklet.js 落盘：test 随宿主页一起放 docs/ 本地服务；prod 已在 dist/（CDN），清理本地残留
          if (test) {
            fs.copyFileSync(bundlePath, resolve(docs, 'bookmarklet.js'));
          } else if (fs.existsSync(resolve(docs, 'bookmarklet.js'))) {
            fs.rmSync(resolve(docs, 'bookmarklet.js'), { force: true });
          }

          // javascript: 加载器（iframe 指向宿主页）。
          // 锚定【右下角】（CSS right:16px;bottom:16px，固定宽 360px、初始高 480px）；仅【高度】随内容自适应：
          // mount 时 ResizeObserver 回传自然高度，此处 ma:resize 把 iframe 高夹在 [160, 视口高-32]，向上生长、封顶视口。
          // 宽度恒定不随内容横向扩充（避免左右撑宽错位）。透明、pointer-events 默认 auto，原网页其余区域完全可点。
          // 开/关 toggle + 真单例逻辑保留（防重复叠加）。
          // 宽严站点探测：iframe 一旦被允许加载，host.html 会立即 postMessage 'ma:frame-ok'（先于 basement）；
          // 若 iframe 因宿主页 frame-src CSP 被拦截（如 GitHub），浏览器会立即派发 securitypolicyviolation 事件
          // （violatedDirective='frame-src'、blockedURI 含 host.html）→ 直接显示提示（瞬时、不轮询、不等待）。
          // 提示里的「油猴脚本版」是可点击链接（target=_blank），点击跳转 tampermonkey 分支首页；不做整页自动重定向。
          // 越狱桥（ma:runjs）只在 ma:frame-ok 收到后才注入，避免严格 CSP 站点上 script-src 内联脚本报错。
          // 书签分支定位宽松站点；严格 CSP 站点交给 tampermonkey 分支。
          const TM_URL = 'https://github.com/chensiyi/MiniAgent/tree/tampermonkey';
          const MA_ID = 'miniagent-iframe';
          // 父页面「越狱桥」：常驻监听 ma:runjs，在【原网页】上下文执行 run_js 代码并回传结果。
          // 仅响应来自本 iframe 的消息（e.source === window.__maIframe.contentWindow），避免被任意页面误触发。
          const BRIDGE_SRC = [
            '(function(){',
            'function ss(v){try{return typeof v==="object"&&v!==null?(v.outerHTML||JSON.stringify(v,null,2)):String(v);}catch(e){return String(v);}}',
            'window.addEventListener("message",function(e){',
            'var d=e.data||{};if(d.type!=="ma:runjs")return;',
            'console.log("[MA bridge] received ma:runjs",{id:d.id,sourceOk:e.source===window.__maIframe.contentWindow,hasIframe:!!window.__maIframe});',
            'if(!window.__maIframe||e.source!==window.__maIframe.contentWindow)return;',
            'var ctx={window:window,document:document,location:location,fetch:window.fetch};',
            'try{var fn=new Function("ctx","\\"use strict\\";\\n"+d.code);var r=fn(ctx);console.log("[MA bridge] executed ok",{id:d.id,resultType:typeof r});e.source.postMessage({type:"ma:runjs:result",id:d.id,ok:true,result:ss(r)},"*");}',
            'catch(err){console.error("[MA bridge] exec error",{id:d.id,err:err&&err.stack});e.source.postMessage({type:"ma:runjs:result",id:d.id,ok:false,error:String((err&&err.stack)||err)},"*");}',
            '});',
            '})();',
          ].join('');
          const loader =
            'javascript:(function(){' +
            'var MA_ID=' + JSON.stringify(MA_ID) + ';' +
            'if(window.__maUnsupported) return;' +
            'var f=document.getElementById(MA_ID);' +
            'if(f && f.style.display!=="none"){ f.style.display="none"; return; }' +
            'if(f && f.style.display==="none"){ f.style.display=""; return; }' +
            'if(document.getElementById("miniagent-csp-tip")) return;' +
            'var all=document.querySelectorAll("iframe");' +
            'for(var i=0;i<all.length;i++){var s=all[i].src||"";if(s.indexOf("host.html")!==-1)all[i].remove();}' +
            'f=document.createElement("iframe");' +
            'f.id=MA_ID;' +
            'f.src=' + JSON.stringify(hostUrl + '?v=' + Date.now()) + ';' +
            'f.style.cssText="position:fixed;right:16px;bottom:16px;width:360px;height:480px;border:0;z-index:2147483647;background:transparent;overflow:hidden";' +
            'document.body.appendChild(f);' +
            'window.__maIframe=f;' +
            'var framed=false;' +
            'function showTip(){' +
            '  if(window.__maUnsupported || framed) return;' +
            '  window.__maUnsupported=true;' +
            '  if(f&&f.parentNode) f.parentNode.removeChild(f);' +
            '  var t=document.createElement("div");' +
            '  t.id="miniagent-csp-tip";' +
            '  t.style.cssText="position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1f1f1f;color:#fff;padding:10px 14px;border-radius:8px;font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:80vw;cursor:default";' +
            '  var msg=document.createTextNode("当前站点禁止加载浮层（严格 CSP），请使用 ");' +
            '  var a=document.createElement("a");' +
            '  a.href=' + JSON.stringify(TM_URL) + ';' +
            '  a.target="_blank"; a.rel="noopener"; a.textContent="油猴脚本版";' +
            '  a.style.color="#4ea1ff"; a.style.textDecoration="underline";' +
            '  t.appendChild(msg); t.appendChild(a);' +
            '  var timer=setTimeout(function(){ if(t.parentNode) t.remove(); }, 8000);' +
            '  t.addEventListener("mouseenter",function(){ clearTimeout(timer); });' +
            '  t.addEventListener("mouseleave",function(){ timer=setTimeout(function(){ if(t.parentNode) t.remove(); }, 8000); });' +
            '  document.body.appendChild(t);' +
            '}' +
            'if(!window.__maMsgBound){window.__maMsgBound=true;' +
            'window.addEventListener("message",function(e){' +
            '  if(e.source===f.contentWindow){' +
            '    var d=e.data||{};' +
            '    if(d.type==="ma:frame-ok"){ framed=true; var tip=document.getElementById("miniagent-csp-tip"); if(tip) tip.remove(); var BR2="ma-bridge"; if(!document.getElementById(BR2)){var bs=document.createElement("script");bs.id=BR2;bs.textContent=' + JSON.stringify(BRIDGE_SRC) + ';document.body.appendChild(bs);} }' +
            '    else if(d.type==="ma:resize"){' +
            '      var vh=window.innerHeight;' +
            '      var h=Math.min(d.height||0, vh-32);' +
            '      f.style.height=h+"px";' +
            '    }' +
            '  }' +
            '});}' +
                                    'setTimeout(function(){ if(!framed) showTip(); }, 1500);' +
            '})()';
          fs.writeFileSync(resolve(dist, 'bookmarklet.url.txt'), loader);

          console.log(
            '[bookmarklet] 构建完成 -> ' +
              (test
                ? '本地模式：serve docs/ @5174（host=' + LOCAL_HOST + '）'
                : '发布模式：CDN=' + CDN_BASE + '，Pages=' + PAGES_HOST),
          );
        },
      },
    ],
  };
});
