// 无头验证：UI 发送按钮态应严格由 agent.isRunning（= messageQueue || toolCallQueue 非空）派生，
// 不依赖任何需同步的私有变量。验证多轮连发期间停止按钮不被误复位、队列空时才复位。
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;

const calls = []; // 记录 ui.chat.setRunning 调用
const agent = {
  messageQueue: [],
  toolCallQueue: [],
  config: { apiKey: 'k' },
  tools: new Map([['ui', {}]]),
  extensions: new Map(),
  chatStop() { this._stopped = true; },
  sendMessage: async (text) => {
    // 模拟基座引擎守卫：把用户消息入队后【同步立即 resolve】（不 await engine）
    agent.messageQueue.push({ role: 'user', content: text });
    return;
  },
  output: { append() { return ''; }, update() {}, finalize() {}, setToolHTML() {}, setRunning() {} },
  toolManager: { setEnabled() {} },
};
Object.defineProperty(agent, 'isRunning', {
  get() { return agent.messageQueue.length > 0 || agent.toolCallQueue.length > 0; },
});

globalThis.MiniAgent = {
  agent,
  handleToolCommand: async () => {},
  defaultTools: [],
  executor: { list: () => [], registerAll: () => ({ registered: [], rejected: [] }), requestApproval: async () => true },
  toolManager: agent.toolManager,
};

const uiPath = pathToFileURL(process.cwd() + '/_diag/ui.mjs').href;
const { ui, uiTool } = await import(uiPath);

// spy setRunning，保留原行为（原行为切换按钮 DOM 显隐）
const orig = ui.chat.setRunning.bind(ui.chat);
ui.chat.setRunning = (running, onStop) => { calls.push({ running, hasStop: !!onStop }); return orig(running, onStop); };

const ctx = { agent, executor: { list: () => [] }, storage: { get() {}, set() {}, del() {}, keys: () => [] }, console };
await uiTool.register(ctx); // 内部调 ui.chat.mount 并设 onSendRef（含 run 闭包）

let pass = true;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) pass = false; };
const tick = () => new Promise((r) => setTimeout(r, 0)); // 让 Promise.finally 微任务执行

// ---- Test A：多轮连发，队列持续非空 → 停止按钮不应被复位 ----
ui.chat.setInput('msg1'); ui.chat.send();
ui.chat.setInput('msg2'); ui.chat.send();
await tick();
const falseA = calls.filter((c) => c.running === false).length;
check('多轮连发期间停止按钮未被复位 (setRunning(false)=0)', falseA === 0);
check('队列非空时 isRunning===true（基座守卫使 sendMessage 同步 resolve 仍判定为忙）', agent.isRunning === true);

// ---- Test B：队列已清空（引擎跑完）→ 单条发送后应复位为发送 ----
calls.length = 0;
agent.messageQueue = []; agent.toolCallQueue = [];
agent.sendMessage = async () => { return; }; // 引擎已处理完，不再入队
ui.chat.setInput('single'); ui.chat.send();
await tick();
const falseB = calls.filter((c) => c.running === false).length;
check('队列空时 setRunning(false) 被调用（切回发送）', falseB >= 1);

console.log(pass ? '\nUI_RUN_OK=true' : '\nUI_RUN_OK=false');
process.exit(pass ? 0 : 1);
