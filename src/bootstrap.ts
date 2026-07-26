// bookmarklet 入口（运行在 CDN 源的 iframe 内，由 host.html 加载）。
// 消费 basement 全局 → 注入环境层工具（storage/ui，直接读写 iframe localStorage）→ 启动。
// 存储 = iframe 的 localStorage（固定 CDN 源）。注意：浏览器对【跨源 iframe 的 storage 按嵌入站点分区】，
// 故同一书签在不同网页上的工具开关等状态是【按站点各自独立】的，并非跨站统一（跨站统一需油猴版）。
import { uiTool } from './tools/ui';
import { storageTool } from './tools/bookmarklet_local_storage';
import { runJsTool } from './tools/run_js_bookmarklet';

// host.html 已先加载 basement，MiniAgent 全局此刻就绪（跨源 iframe，不受宿主页 CSP 约束）。
const { agent, toolManager, defaultTools } = MiniAgent;

// #app 为状态提示槽：仅启动失败时显示错误，成功路径不打扰 UI（保持纯粹浮窗）
const appEl = document.getElementById('app');
function setBootStatus(text: string): void {
  if (appEl) appEl.textContent = text;
  else console.warn('[MiniAgent] #app 元素未找到，无法更新状态文字');
}

// 等 DOM 解析完成（ui.register 内部也 await 同一事件后才 mount，故此后浮窗已挂上）。
// 带超时保护：极端环境下 DOMContentLoaded 迟迟不触发也不至于卡死启动。
function domReady(): Promise<void> {
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') return resolve();
    const timer = setTimeout(resolve, 3000);
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function main(): Promise<void> {
  try {
    console.log('[MiniAgent][boot] ① 启动');

    // ⚠️ 关键：basement 的 definePreset 仅接收【单个】工具列表（内部 T = 该列表，第二参数会被忽略）。
    // 因此必须把 storage（base）+ 默认工具 + ui 合并为一份完整列表传入；
    // 之前误传两参 (base, all) 导致 allTools（含 ui）被丢弃，bootstrap 只注册了 baseTools → UI 不挂载。
    // ui 为常规工具，经 disabledTools 过滤后仍默认启用（见下方清理）。
    // run_js 用 bookmarklet 越狱包装替换 basement 原版（默认在【原网页】上下文执行，可操作原网页 DOM）。
    const bmDefaultTools = (defaultTools as ToolDef[]).filter((t) => t.name !== 'run_js');
    const allTools = [storageTool, ...bmDefaultTools, runJsTool, uiTool];
    toolManager.definePreset(allTools);
    console.log('[MiniAgent][boot] ② definePreset 完成（共 ' + allTools.length + ' 个工具），开始 bootstrap()');

    // 防御：旧持久化数据可能残留 'ui'/'gm_storage' 在 disabledTools（改名后旧键失效，或曾被手动禁用），
    // 导致 boot 过滤掉 UI。agent.config 是访问器属性，必须【整体赋值】触发 setter 写回 localStorage，
    // 仅改 agent.config.disabledTools 只作用于临时副本、不持久化。
    const badKey = (x: string): boolean => x === 'ui' || x === 'gm_storage';
    const dt = (agent.config.disabledTools ?? []) as string[];
    if (dt.some(badKey)) {
      const cleaned = dt.filter((x) => !badKey(x));
      agent.config = { ...agent.config, disabledTools: cleaned }; // 整体赋值触发 setter 写回
      console.log('[MiniAgent][boot] 已清理 disabledTools 残留:', dt, '→', cleaned);
    }

    // 工具开关持久化：basement 的 config 是纯模型、不保证自动落盘（详见 basement config.ts 注释），
    // 故书签分支自行维护 iframe localStorage 键 'miniagent:__disabledTools'，ui.ts 在开关变化时写入、此处读取。
    // 注意：该存储按嵌入站点分区（见文件头注释），仅同站点内刷新后存活，跨站不共享。
    try {
      const raw = localStorage.getItem('miniagent:__disabledTools');
      const persisted = raw ? (JSON.parse(raw) as unknown[]) : [];
      if (Array.isArray(persisted) && persisted.length) {
        const merged = new Set([
          ...((agent.config.disabledTools ?? []) as string[]),
          ...persisted.filter((x) => typeof x === 'string'),
        ]);
        agent.config = { ...agent.config, disabledTools: [...merged] };
        console.log('[MiniAgent][boot] 已从本地键恢复 disabledTools:', [...merged]);
      }
    } catch (e) {
      console.warn('[MiniAgent][boot] 读取本地 disabledTools 失败:', e);
    }

    // 必须 await：bootstrap 内部依次调用每个工具的 register()（含 ui→mount DOM），
    // 不 await 的话后续 setBootStatus 在注册完成前就跑了，且异步异常会被吞掉。
    await toolManager.bootstrap();
    console.log('[MiniAgent][boot] ③ bootstrap() 完成');

    // ui.register 内部 await whenDomReady 才真正 mount DOM，bootstrap() 不等待该异步；
    // 等 DOM ready 确保浮窗已挂上，再更新状态提示（避免「root=无」的假阴性）。
    await domReady();

    // 暴露全局单例（iframe 自身 window），便于调试 / 运行时编辑
    (globalThis as unknown as { agent: unknown }).agent = agent;
    (window as unknown as { MiniAgent: unknown }).MiniAgent = MiniAgent;

    // ---- 验证：跨站固定存储链路（iframe + CDN + localStorage）----
    const TEST_KEY = '__boot_test__';
    const stamp = 'ok@' + Date.now();
    localStorage.setItem('miniagent:' + TEST_KEY, stamp);
    const got = localStorage.getItem('miniagent:' + TEST_KEY);

    const rootEl = document.getElementById('miniagent-root');

    // 成功路径不打扰 UI（保持纯粹浮窗）；#app 槽位仅在 catch 失败分支写错误提示。
    console.log('[MiniAgent][boot] ④ 全部完成', {
      storageTest: got,
      origin: location.origin,
      hasRoot: !!rootEl,
      hasLauncher: !!document.getElementById('miniagent-launcher'),
      launcherDisplay: document.getElementById('miniagent-launcher')?.style.display,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setBootStatus('❌ MiniAgent 启动失败: ' + msg);
    console.error('[MiniAgent][boot] ✗ 异常:', e);
    // eslint-disable-next-line no-alert
    alert('MiniAgent 启动失败: ' + msg);
  }
}

void main();
