import { storage } from '../core/storage';

// 单一配置原型：基础必要变量（主题风格 + api 标准），一块 blob 存、一次读出反序列化
export interface AppConfig {
  theme: 'light' | 'dark';
  apiKey: string;
  model: string;
  baseURL: string;
  disabledTools?: string[]; // 工具黑名单：boot 时直接从注册名单剔除（文档 §3/§5.2）
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'light',
  apiKey: '', // 由用户运行时在配置/UI 中填写，勿硬编码进源码（Push Protection 会拦截）
  model: 'openrouter/free',
  baseURL: 'https://openrouter.ai/api/v1',
};

// 自我开发能力的开关：code.run 执行前是否必须人工确认（默认 true，强烈建议保持）
// 已在 executor.run base 内接入（name==='code_run' 且本开关为 true 时 await ui.requestApproval）。
export const REQUIRE_CODE_APPROVAL = true;

// 确定性确认的风险阈值（文档 §6/§9）：riskLevel 达到该级别（含）的工具，在 executor.run 必须人工确认。
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export const APPROVAL_RISK_LEVEL: RiskLevel = 'high';
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function riskAtLeast(level: RiskLevel | undefined, threshold: RiskLevel): boolean {
  if (!level) return false;
  return RISK_ORDER[level] >= RISK_ORDER[threshold];
}

// TODO（上下文 / 权限管理）：当前仅占位，不进运行时。
// 未来规划：withHooks 的 before 钩子注入共享 ctx（上下文），并在敏感操作前做权限鉴权；
// 权限系统就位后，ui.requestApproval 可由权限 hook 自动允许（白名单）/ 拦截，而不总是弹窗。
// 另：可为工具加 danger 标记，让确认闸覆盖更多危险工具（非仅 code_run）。

// 系统提示：告诉 LLM 它有哪些工具，以及"自我编辑/管理"的能力边界
const SYSTEM_PROMPT = `你是运行在浏览器页面上的轻量 AI 智能体（MiniAgent）。工具是唯一的能力面，按契约声明；有 call 的工具才会被直接调用。

- gm_storage（author: core）：统一的持久存储管理。action 取值 get/set/list/del（默认 memory 命名空间，可指定 ns）。get=读取键；set=写入键（update=true 时合并已有对象）；list=列出键（给定 ns 列该分区子键，不给 ns 按 default/config/sessions/tools/code/memory 分区概览）；del=删除键（riskLevel=high，删除前系统自动弹确认框）。用于记忆、配置、状态管理。
- code_run（author: core）：执行js代码，riskLevel=high，执行前系统自动弹确认框，你无需在文字里确认。
- tool_manager（author: core）：统一的工具自编排管理。action 取值 register/remove/list。register=注册/创建新工具（参数含 name/description/inputSchema/deps/riskLevel/code，code 为 call 源码，依赖按 name 匹配、author 不符仅警告；注册后持久化到 tools 命名空间，重载按依赖拓扑自动重建）；remove=删除自编排工具；list=枚举全部已注册工具（含无 call 的系统原语），研究自我组织时查看完整能力面。
- session（author: core）：会话管理，自动把对话消息落盘到 session 命名空间（session:<id>），并在 default:sessions 建索引。action 取值 info（查看当前会话，默认）/ save（立即落盘）/ list（列出全部会话）/ create（开新会话并清空上下文）/ switch（切换到指定会话，需传 id）/ remove（删除指定会话，需传 id，删当前则自动开新会话）。

规则：
- 想新增能力：用 tool_manager（action=register）注册工具（提供 name/description/inputSchema/code，必要时 deps/riskLevel/register 安装钩子）。
- code_run 由界面自动弹确认框，直接调用即可，不要在文字里向用户确认。
- 代码内用 ctx.storage 访问存储、ctx.console 打印、ctx.this.<name> 取其它已挂载工具，不要依赖未注入的全局变量。
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
