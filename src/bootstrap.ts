// bookmarklet 入口（运行在 CDN 源的 iframe 内，由 host.html 加载）。
// 复用 dev 的薄壳编排：消费 basement 全局 → 注入环境层工具（gm_storage/ui，经 $ 别名解析到本分支 env.ts）→ 启动。
// 存储 = iframe 的 localStorage（CDN 固定源）→ 跨站统一持久化。
import { uiTool } from '../src/tools/ui';
import { gmStorageTool } from '../src/tools/gm_storage';
import { GM_setValue, GM_getValue } from './env';

// host.html 已先加载 basement，MiniAgent 全局此刻就绪（跨源 iframe，不受宿主页 CSP 约束）。
const { agent, toolManager, defaultTools } = MiniAgent;
const hooksTool = defaultTools.find((t) => t.name === 'hooks');

// 清除 host.html 的初始加载提示（bootstrap 成功后替换为就绪状态）
const appEl = document.getElementById('app');
function setBootStatus(text: string): void {
  if (appEl) appEl.textContent = text;
  else console.warn('[MiniAgent] #app 元素未找到，无法更新状态文字');
}

async function main(): Promise<void> {
  try {
    setBootStatus('MiniAgent 启动中…');
    console.log('[MiniAgent][boot] ① definePreset 前');

    toolManager.definePreset([gmStorageTool, hooksTool!], [gmStorageTool, ...defaultTools, uiTool]);
    console.log('[MiniAgent][boot] ② definePreset 完成，开始 bootstrap()');

    // ⚠️ 必须await：bootstrap 内部依次调用每个工具的 register()（含 ui→mount DOM），
    // 不 await 的话后续 setBootStatus 在注册完成前就跑了，且异步异常会被吞掉
    await toolManager.bootstrap();
    console.log('[MiniAgent][boot] ③ bootstrap() 完成，UI 应已 mount');

    // 暴露全局单例（iframe 自身 window），便于调试 / 运行时编辑
    (globalThis as unknown as { agent: unknown }).agent = agent;
    (window as unknown as { MiniAgent: unknown }).MiniAgent = MiniAgent;

    // ---- 验证：跨站固定存储链路（iframe + CDN + localStorage）----
    const TEST_KEY = '__boot_test__';
    const stamp = 'ok@' + Date.now();
    GM_setValue(TEST_KEY, stamp);
    const got = GM_getValue(TEST_KEY);

    const rootEl = document.getElementById('miniagent-root');
    setBootStatus('✅ MiniAgent 就绪（' + location.origin + '）[root=' + (rootEl ? '有' : '无') + ']');

    console.log('[MiniAgent][boot] ④ 全部完成', {
      agent: typeof agent,
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
