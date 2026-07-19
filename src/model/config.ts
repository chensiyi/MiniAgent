import { storage } from '../core/storage';

// 单一配置原型：基础必要变量（主题风格 + api 标准），一块 blob 存、一次读出反序列化
export interface AppConfig {
  theme: 'light' | 'dark';
  apiKey: string;
  model: string;
  baseURL: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'light',
  apiKey: 'REDACTED',
  model: 'openrouter/free',
  baseURL: 'https://openrouter.ai/api/v1',
};

// 自我开发能力的开关：code.run 执行前是否必须人工确认（默认 true，强烈建议保持）
// 已在 executor.run base 内接入（name==='code_run' 且本开关为 true 时 await ui.requestApproval）。
export const REQUIRE_CODE_APPROVAL = true;

// TODO（上下文 / 权限管理）：当前仅占位，不进运行时。
// 未来规划：withHooks 的 before 钩子注入共享 ctx（上下文），并在敏感操作前做权限鉴权；
// 权限系统就位后，ui.requestApproval 可由权限 hook 自动允许（白名单）/ 拦截，而不总是弹窗。
// 另：可为工具加 danger 标记，让确认闸覆盖更多危险工具（非仅 code_run）。

// 系统提示：告诉 LLM 它有哪些工具，以及"自我编辑/管理"的能力边界
const SYSTEM_PROMPT = `你是运行在浏览器页面上的轻量 AI 智能体（MiniAgent）。当前可用工具：
- storage_get / storage_set：读写持久存储（默认 memory 命名空间，可指定 ns 读写其它命名空间）。用于记忆、配置、状态。
- code_gen：把一段 JS 代码保存到 code 命名空间（不执行）。
- code_run：执行已保存（或直接传入）的 JS 代码，实现自我开发。执行前系统自动弹确认框，你无需在文字里确认。
- tool_create / tool_remove：注册 / 删除自编排工具（持久化到 tools 命名空间，重载自动重建）。
- session：会话管理，自动把对话消息与工具调用落盘到 session 命名空间。
- tool_list：枚举全部已注册工具（含隐藏的系统原语），研究自我组织时查看完整能力面。

规则：
- 想新增能力：用 tool_create 注册工具（提供 name/description/parameters/code），或用 code_gen + code_run。
- code_run 由界面自动弹确认框，直接调用即可，不要在文字里向用户确认。
- 代码内用 ctx.storage 访问存储、ctx.console 打印，不要依赖未注入的全局变量。
- 回答简明，必要时一句话说明在做什么。`;

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

// 配置落盘到 default 命名空间下的 config 键（default:config）
export function getConfig(): AppConfig {
  const saved = storage.get<Partial<AppConfig>>('default', 'config');
  return { ...DEFAULT_CONFIG, ...(saved ?? {}) };
}

export function saveConfig(patch: Partial<AppConfig>): void {
  storage.set('default', 'config', { ...getConfig(), ...patch });
}
