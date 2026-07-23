/// <reference path="./basement.d.ts" />

import { ui } from './ui/ui';
import { gmStorageTool } from './tools/gm_storage';

// 消费经 @require 引入的 basement 全局（运行时已自动 init：注册核心默认工具、读 config）
const { agent, executor, handleToolCommand } = MiniAgent;

// 无 UI 时的空输出槽（UI 工具 unregister 时还原 headless）
const headlessSink: OutputSink = {
  append: () => '', update() {}, finalize() {}, setToolHTML() {}, setRunning() {},
};

// 配置不完整时的提示文案
const CONFIG_HINT = '⚠️ 未配置 API Key。两种设置方式：\n① 打开 Tampermonkey 仪表盘 → 本脚本 → 数值，直接编辑 `config` 键（JSON：{"apiKey":"你的Key","baseURL":"https://openrouter.ai/api/v1","model":"openrouter/free"}）；\n② 或运行命令：/gm_storage /action set /ns "" /key config /update true /value {"apiKey":"你的Key","baseURL":"https://openrouter.ai/api/v1","model":"openrouter/free"}';

// 等待 DOM 就绪（UI 挂载用）
function whenDomReady(): Promise<void> {
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') return resolve();
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

// 持久化的最小启动器：UI 被禁用后的"重新启用"入口（独立于已被卸载的 UI 本身，保证可逆、humane）
let launcherEl: HTMLElement | null = null;
function ensureLauncher(): HTMLElement {
  if (launcherEl) return launcherEl;
  const css =
    '#miniagent-launcher{position:fixed;right:14px;bottom:14px;z-index:2147483646}' +
    '#miniagent-launcher button{padding:6px 12px;border:1px solid rgba(55,141,221,.6);border-radius:8px;' +
    'background:rgba(55,141,221,.92);color:#fff;cursor:pointer;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3)}';
  const style = document.createElement('style'); style.textContent = css;
  (document.head ?? document.documentElement).append(style);
  const el = document.createElement('div'); el.id = 'miniagent-launcher';
  el.innerHTML = '<button type="button" title="启用 MiniAgent 界面">💬 启用界面</button>';
  (el.querySelector('button') as HTMLButtonElement).onclick = () => { void executor.setEnabled('ui', true); };
  if (document.body) document.body.append(el);
  else document.addEventListener('DOMContentLoaded', () => document.body.append(el), { once: true });
  launcherEl = el;
  return el;
}
function showLauncher(): void { ensureLauncher().style.display = ''; }
function hideLauncher(): void { ensureLauncher().style.display = 'none'; }
function createLauncher(): void {
  const el = ensureLauncher();
  const uiUp = agent.tools.has('ui');
  el.style.display = uiUp ? 'none' : '';
}

const uiTool: ToolDef = {
  name: 'ui',
  author: 'sys',
  description: '界面工具：注册后挂载聊天界面并接管输出/渲染/确认闸；在工具清单禁用即"关闭界面"（经确认闸、可逆），核心仍 headless 运行。启用即重新挂载。',
  parameters: {},
  register: async (_ctx) => {
    agent.output = ui.chat; // 输出槽接管（agent.output 默认 headless 空实现）
    agent.extensions.set('ui', ui.chat); // UI 渲染能力（marked 已成为独立工具，不经此接管）
    agent.extensions.set('approval', ui.requestApproval); // 确认闸经此接入（核心 requestApproval 委托）
    await whenDomReady();
    ui.chat.mount((text) => {
      // 用户直接调用工具：/tool_name /param value
      if (text.startsWith('/')) {
        agent.output.append('user', text);
        void handleToolCommand(text);
        return;
      }
      // 配置检查：apiKey 未配置时提示用户通过工具命令设置
      if (!agent.config.apiKey) {
        agent.output.append('user', text);
        agent.output.append('tool', CONFIG_HINT);
        return;
      }
      void agent.sendMessage(text);
    });
    hideLauncher();
  },
  unregister: (_ctx) => {
    ui.chat.unmount();
    agent.output = headlessSink; // 还原 headless 空实现
    agent.extensions.delete('ui');
    agent.extensions.delete('approval');
    showLauncher(); // 露出重新启用入口，保证可逆
  },
};

// basement 已自动 init 并注册核心默认工具；此处叠加油猴环境能力（GM_* 存储 + UI）。
// 顺序：先装 GM_* 镜像与落盘钩子（gm_storage 把 GM_* 镜像进内存 Map，覆盖 init 时种子出的默认 config，
// 引擎运行期 agent.config 实时读 storage → 拿到真实 apiKey），再挂载 UI 接管输出槽。
executor.registerAll([gmStorageTool, uiTool]);
createLauncher();

// 暴露全局单例（标准用户脚本空间：沙箱内 globalThis，便于运行时 / LLM 动态编辑）
(globalThis as unknown as { agent: Agent }).agent = agent;

// 仅 dev 分支额外挂到 unsafeWindow，使 DevTools 控制台可直接访问（补偿 userscript 沙箱隔离）；
// 发布分支（main/master 等）一律不挂，避免与页面主世界互相影响。
declare const __BUILD_BRANCH__: string;
if (__BUILD_BRANCH__ === 'dev') {
  const uw = (globalThis as unknown as { unsafeWindow?: typeof globalThis }).unsafeWindow;
  if (uw) (uw as Record<string, unknown>).agent = agent;
}
