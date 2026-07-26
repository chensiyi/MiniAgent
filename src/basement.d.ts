// 声明经 userscript `@require` 引入的 basement 全局契约（类比 monkey.d.ts）。
// basement 构建产物 dist/miniagent-basement.js 在 userscript 隔离作用域内暴露 window.MiniAgent；
// 油猴 / 浏览器标签分支仅写薄壳胶水消费此全局，不打包任何核心源码。
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
    definePreset(tools: ToolDef[]): void; // 宿主层注入完整预装宇宙（单参；basement-0.2.6 契约：bootstrap 内部按 deps 拓扑 + disabledTools 过滤，不区分 base/all）
    bootstrap(): void; // 启动编排：baseTools 先注册 → 镜像存储后读 disabledTools → 过滤注册 allTools → 重建用户工具
    getStates(): ToolState[]; // 完整工具清单（含启用态），供 UI 启停面板渲染
    setEnabled(name: string, enabled: boolean): Promise<void> | void; // 启停（baseTools 拒绝关闭）
    deleteTool(name: string): Promise<string>;
  };

  type Agent = {
    config: AppConfig;
    storage: StorageApi;
    output: OutputSink;
    extensions: Map<string, unknown>;
    tools: Map<string, ToolDef>;
    messages: unknown[];
    sendMessage(text: string): Promise<void>;
    chatStop(): void;
    chat: { sendMessage(text: string): Promise<void> };
  };

  // ---- basement IIFE 全局（@require 引入；运行时仅绑定 executor↔agent + 注册内核 hooks，不自动启动其余工具）----
  // 启动编排完全交给 tool_manager：宿主层注入预装宇宙（含环境层工具 gm_storage / ui），由 bootstrap 统一编排；
  // 依赖关系只活在工具自身 deps 图（hooks ← gm_storage ← ui），由 registerAll 内部拓扑序处理，内核不另设优先级层。
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
