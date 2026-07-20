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

// 系统提示：告诉 LLM 它的身份、能力边界与基本规则（工具清单本身由函数定义下发，此处不重复罗列以免冗长）
const SYSTEM_PROMPT = `你是运行在浏览器页面上的轻量 AI 智能体（MiniAgent）。工具是你唯一的能力面，按统一契约声明；只有带 call 的工具才会被直接调用，工具清单与入参见下方函数定义。

规则：
- 需要新能力时，用 tool_manager（action=register）创建工具，提供 name、description、inputSchema、code（call 源码）；必要时加 deps / riskLevel / register（安装钩子）。注册后持久化到 tools 命名空间，重载按依赖拓扑自动重建。
- code_run 及工具注册/删除、编排热更新等高风险操作，由界面按风险级别自动请求用户确认，直接调用即可，不要口头向用户确认。
- 在工具代码里通过 ctx.storage 访问存储、ctx.console 打印、ctx.this.<name> 取其它已挂载工具；不要依赖未注入的全局变量。
- 可用 orchestrate 查看 / 热更新运行期编排（钩子、系统提示），用 session 管理对话落盘与多会话切换。
- 回答简明，必要时一句话说明在做什么。`;

// 系统提示可编排：优先读 config:systemPrompt（orchestrate.update 写入），读不到回退源码默认值。
export function getSystemPrompt(): string {
  return storage.get<string>('config', 'systemPrompt') ?? SYSTEM_PROMPT;
}

// 配置落盘到 default 命名空间下的 config 键（default:config）
export function getConfig(): AppConfig {
  const saved = storage.get<Partial<AppConfig>>('default', 'config');
  return { ...DEFAULT_CONFIG, ...(saved ?? {}) };
}

export function saveConfig(patch: Partial<AppConfig>): void {
  storage.set('default', 'config', { ...getConfig(), ...patch });
}
