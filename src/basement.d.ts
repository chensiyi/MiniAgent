// 声明经 CDN <script> 引入的 basement 全局契约。
// basement 构建产物 dist/miniagent-basement.js 在 iframe 全局作用域内暴露 window.MiniAgent；
// bookmarklet 分支仅写薄壳胶水消费此全局，不打包任何核心源码。
export {};

declare global {
  // ---- 核心类型（与 basement/src 保持一致；basement API 变动时同步此处）----

  // 输出槽：引擎只写此槽，环境层提供具体实现（DOM / 控制台等）
  type OutputSink = {
    append(role: string, text: string, id?: string): string;
    update(mid: string, role: string, text: string, reasoning?: string): void;
    finalize(mid: string, role: string, text: string, reasoning?: string): void;
    setToolHTML(mid: string, html: string): void;
    setRunning(running: boolean, onStop?: () => void): void;
  };

  // 工具定义
  type ToolDef = {
    name: string;
    author?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    deps?: { name: string; author?: string }[];
    hidden?: boolean;
    riskLevel?: 'low' | 'medium' | 'high' | 'critical'; // 高危走确定性确认（与 basement 运行时对齐）
    call?: (args: Record<string, unknown>, ctx: RunCtx) => Promise<string> | string;
    register?: (ctx: RegisterCtx) => void | Promise<void>;
    unregister?: (ctx: RegisterCtx) => void | Promise<void>;
  };

  type RegisterCtx = { agent: Agent; executor: ExecutorApi; storage: StorageApi; console: Console };
  type RunCtx = { storage: StorageApi; executor: ExecutorApi; agent: Agent; this: Agent; console: Console };

  // 逻辑存储层（内存 Map，落盘由环境层透明完成）
  type StorageApi = {
    get<T = unknown>(nsOrKey: string, keyOrFallback?: T | string, fallback?: T): T;
    set(nsOrKey: string, keyOrValue: unknown, value?: unknown): void;
    del(nsOrKey: string, key?: string): void;
    keys(ns?: string): string[];
  };

  type AppConfig = {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    systemPrompt?: string;
    reasoningEffort?: string;
    disabledTools?: string[];
    [k: string]: unknown;
  };

  type ToolState = { name: string; author?: string; description?: string; enabled: boolean; builtin: boolean };

  // 执行器公开面（环境层 UI / 胶水所需）：内核退化为哑注册表，仅保留基础注册/列举/审批能力
  type ExecutorApi = {
    registerAll(tools: ToolDef[]): { registered: string[]; rejected: string[] };
    list(includeAll?: boolean): ToolDef[];
    requestApproval(call: { name: string; code?: string; riskLevel?: string }, agent: Agent): Promise<boolean>;
  };

  // 工具生命周期管理器（2026-07-25 从 executor 迁入）：预装宇宙 / bootstrap / 启停 / 重建 全部收归此处。
  // 内核 executor 退化为哑注册表，不关心预装清单与业务启停。
  type ToolManagerApi = {
    // basement-0.2.7 两参模型：宿主层注入预装宇宙。
    //  - baseTools：基础底座（始终先注册、不可经开关关闭）；
    //  - allTools：完整预装（按 config.disabledTools 过滤后注册）；
    // 两列表在 getStates / 注册真相源里合并，故 allTools 应包含 baseTools（去重）。
    definePreset(baseTools: ToolDef[], allTools: ToolDef[]): void; // 注入预装宇宙（base=底座，all=完整预装），由 bootstrap 统一编排
    bootstrap(): void; // 启动编排：baseTools 先注册 → 镜像存储后读 disabledTools → 过滤注册 allTools → 重建用户工具
    getStates(): ToolState[]; // 完整工具清单（含启用态），供 UI 启停面板渲染
    setEnabled(name: string, enabled: boolean): Promise<void> | void; // 启停工具（ui 关闭前弹确认）
    deleteTool(name: string): Promise<string>;
  };

  type Agent = {
    config: AppConfig;
    storage: StorageApi;
    output: OutputSink;
    extensions: Map<string, unknown>;
    tools: Map<string, ToolDef>;
    messages: unknown[];
    isRunning: boolean; // 运行态派生判据：messageQueue 或 toolCallQueue 非空即为 true（由两队列纯派生，无需额外布尔）；UI 据此决定发送/停止按钮
    sendMessage(text: string): Promise<void>;
    chatStop(): void;
    chat: { sendMessage(text: string): Promise<void> };
  };

  // ---- basement IIFE 全局（CDN <script> 引入；运行时仅绑定 executor↔agent + 注册内核 hooks，不自动启动其余工具）----
  // 启动编排完全交给 tool_manager：宿主层注入预装宇宙（含环境层工具 storage / ui），由 bootstrap 统一编排；
  // 依赖关系只活在工具自身 deps 图（hooks ← storage ← ui），由 registerAll 内部拓扑序处理，内核不另设优先级层。
  // 钩子能力（installHook / uninstallToolHooks / wrapHook）不再作为散装全局暴露，
  // 统一经 agent.tools.get('hooks') 取回 HooksTool 后调用（标准 tool 接口，避免框架不清的调用声明）。
  const MiniAgent: {
    agent: Agent;
    executor: ExecutorApi;
    handleToolCommand(text: string): Promise<void>;
    defaultTools: ToolDef[];
    toolManager: ToolManagerApi;
  };

  // hooks 工具对象类型：经 agent.tools.get('hooks') 取回后强转使用（标准 tool 接口）。
  type HooksTool = ToolDef & {
    wrapHook: (fn: (...args: any[]) => any, thisArg?: any) => any;
    installHook: (
      targetName: string,
      phase: 'before' | 'after',
      fn: (opts: { args: any[]; result: any }) => void | Promise<void>,
      opts?: Record<string, unknown>,
    ) => any;
    uninstallToolHooks: (toolName: string) => number;
  };
}
