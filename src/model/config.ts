// 纯配置模型（不含任何 storage 逻辑）。运行期配置以 agent.config 形式常驻内存，
// 持久化由业务代码显式负责：storage.set('config', agent.config)。
// 系统提示 systemPrompt 并入本对象，存于扁平键 config（无 ns 前缀，用户可在 Tampermonkey 数值里直接编辑）。
export interface AppConfig {
  apiKey: string;
  model: string;
  baseURL: string;
  systemPrompt?: string; // 系统提示单一真相源：存于扁平 config 键（经 storage.set 写入）。运行期只认此值，不回退源码常量；默认值由 DEFAULT_CONFIG 经 normalizeConfig 兜底
  disabledTools?: string[]; // 工具黑名单：环境层 registerAll 前按此过滤（文档 §3/§5.2）
  reasoningEffort?: ReasoningEffort; // 思考强度（reasoning effort）：仅推理模型（o-series / 支持 reasoning_effort 的模型）生效；非推理模型传此字段可能被忽略或报错，故默认不设置（不向 API 注入该字段）。经 agent.engine 以 OpenAI 标准字段名 `reasoning_effort` 注入请求体。
}

// 思考强度枚举（对齐 OpenAI reasoning_effort 取值）。
// low=少思考 / medium=适中 / high=深度思考。是否生效取决于模型是否支持。
export type ReasoningEffort = 'low' | 'medium' | 'high';



// 系统提示种子（作为 DEFAULT_CONFIG.systemPrompt 的默认值；运行期只读 agent.config，绝不回退本常量）。
export const SYSTEM_PROMPT = `你是运行在浏览器页面上的轻量 AI 智能体（MiniAgent）。工具是你唯一的能力面，按统一契约声明；工具清单与入参见下方函数定义。

规则：
- 需要新能力时，用 tool_manager（action=register）创建工具，提供 name、description、parameters、code（call 源码）；必要时加 deps / riskLevel / register（安装钩子）。注册会持久化到 tools 命名空间（重载按依赖拓扑自动重建），但默认处于停用状态；传 enabled=true 可注册后立即启用，或事后在 ⚙ 工具面板开启。
- run_js 及工具注册/删除、运行态热更新等高风险操作，由界面按风险级别自动请求用户确认，直接调用即可，不要口头向用户确认。
- 在工具代码里通过 ctx.storage 访问存储、ctx.console 打印、ctx.this.<name> 取其它已挂载工具；不要依赖未注入的全局变量。
- 可用 hooks 查看 / 热更新运行态（钩子、引擎），用 session 管理对话落盘与多会话切换。
- 回答简明，必要时一句话说明在做什么。`;

export const DEFAULT_CONFIG: AppConfig = {
  // theme: 'light',
  apiKey: '', // 如果没有，会报错提示如何填写，勿硬编码进源码（Push Protection 会拦截）
  model: 'openrouter/free',
  baseURL: 'https://openrouter.ai/api/v1',
  systemPrompt: SYSTEM_PROMPT, // 系统提示默认值：经 normalizeConfig 兜底，首次运行/缺失即落此种子值
};

// 自我开发能力的开关：run_js 执行前是否必须人工确认（默认 true，强烈建议保持）
// 已在 executor.run base 内接入（name==='run_js' 且本开关为 true 时 await ui.requestApproval）。
export const REQUIRE_CODE_APPROVAL = true;

// 确定性确认的风险阈值（文档 §6/§9）：riskLevel 达到该级别（含）的工具，在 executor.run 必须人工确认。
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export const APPROVAL_RISK_LEVEL: RiskLevel = 'high';
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function riskAtLeast(level: RiskLevel | undefined, threshold: RiskLevel): boolean {
  if (!level) return false;
  return RISK_ORDER[level] >= RISK_ORDER[threshold];
}



// 反序列化辅助（storage-agnostic）：合并默认值，缺失字段回落 DEFAULT_CONFIG。
export function normalizeConfig(raw: Partial<AppConfig> | null | undefined): AppConfig {
  return { ...DEFAULT_CONFIG, ...(raw ?? {}) };
}
