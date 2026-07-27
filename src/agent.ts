/// <reference path="./basement.d.ts" />

import { uiTool } from './tools/ui';
import { gmStorageTool } from './tools/gm_storage';
import { GM_getValue } from '$';

// 消费经 @require 引入的 basement 全局（运行时仅绑定 executor↔agent，IIFE 已注册内核 hooks；不自动启动其余工具）。
// 启动编排完全交给 tool_manager：注入完整预装宇宙（含环境层工具 gm_storage / ui），由 bootstrap 统一编排。
//  - 依赖关系只活在工具自身 deps 图（hooks ← gm_storage ← ui），由 registerAll 内部拓扑序处理，内核不另设优先级层；
//  - 预装宇宙以两参 definePreset(baseTools, allTools) 注入（basement-0.2.7 两参模型）：
//      baseTools = 基础底座（gm_storage 存储层 + hooks 内核），始终先注册、不可经开关关闭；
//      allTools = 完整预装（baseTools 去重 + defaultTools + ui），按 config.disabledTools 过滤后注册；
//  - bootstrap 内部按 disabledTools 过滤 allTools 并按 deps 拓扑注册，最后重建用户持久化工具；
//  - 两参模型下宿主层需区分 base/all：base 为不可关的底座，all 为含用户可关项的完整宇宙。
//
// 借鉴 page-agent demo.ts 的 IIFE 注入范式（C 计划 A/B/C 三项）：
//  A) 从注入脚本 URL 参数覆盖 LLM 配置（model / baseURL / apiKey / systemPrompt / reasoningEffort / lang）；
//     油猴脚本通常无 currentScript.src 参数，此处保留能力以兼容书签式 / 开发态复用同套逻辑（null 时静默跳过）。
//  B) autoInit 开关：默认自动启动；GM_getValue('autoInit','true')==='false' 时仅暴露全局、不自动 bootstrap，
//     便于控制台手动调参后调用 MiniAgent.toolManager.bootstrap()。
//  C) 去重防护：已挂载旧实例先 dispose 再重建（类比 page-agent window.pageAgent.dispose()；bootstrap 幂等，重复安全）。
const { agent, toolManager, defaultTools } = MiniAgent;
const hooksTool = defaultTools.find((t) => t.name === 'hooks');

// —— C-A：URL 参数覆盖 LLM 配置 ——
// 借用 page-agent demo.ts 的 currentScript.src 解析；油猴无参数时 currentScriptURL 为 null，遍历被跳过。
const currentScript = document.currentScript as HTMLScriptElement | null;
const currentScriptURL = currentScript?.src ? new URL(currentScript.src) : null;
const CONFIG_OVERRIDE_KEYS = [
	'model',
	'baseURL',
	'apiKey',
	'systemPrompt',
	'reasoningEffort',
	'lang',
] as const;
if (currentScriptURL) {
	const override: Record<string, string> = {};
	for (const k of CONFIG_OVERRIDE_KEYS) {
		const v = currentScriptURL.searchParams.get(k);
		if (v !== null) override[k] = v;
	}
	if (Object.keys(override).length) {
		agent.config = { ...agent.config, ...override };
	}
}

// —— C-B：autoInit 开关（GM 不可用时回退自动启动）——
function resolveAutoInit(): boolean {
	try {
		return GM_getValue<string>('autoInit', 'true') !== 'false';
	} catch {
		return true;
	}
}
const autoInit = resolveAutoInit();

// —— C-C：去重防护 —— 旧实例先 dispose（basement-0.2.8+ 提供；旧版无该方法则跳过，不影响重建）。
if (autoInit) {
	const existing = (globalThis as unknown as { agent?: Agent }).agent;
	if (existing && typeof existing.dispose === 'function') {
		try {
			existing.dispose();
		} catch {
			// 释放失败不应阻断重建
		}
	}
}

toolManager.definePreset([gmStorageTool, hooksTool!], [gmStorageTool, ...defaultTools, uiTool]); // baseTools=基础底座（先注册、不可关）；allTools=完整预装（按 disabledTools 过滤）

if (autoInit) {
	toolManager.bootstrap(); // 启动编排（按 disabledTools 过滤 → 按 deps 拓扑注册 → 重建用户工具；幂等，重复调用安全）
}

// 暴露全局单例（标准用户脚本空间：沙箱内 globalThis，便于运行时 / LLM 动态编辑）
(globalThis as unknown as { agent: Agent }).agent = agent;

// 仅调试构建（npm run dev 的 serve，或 npm run test → vite build --mode test）额外挂到 unsafeWindow，
// 使 DevTools 控制台可直接访问（补偿 userscript 沙箱隔离）；
// 生产构建（npm run build，mode=production）一律不挂，避免与页面主世界互相影响。
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
	const uw = (globalThis as unknown as { unsafeWindow?: typeof globalThis }).unsafeWindow;
	if (uw) (uw as Record<string, unknown>).agent = agent;
}
