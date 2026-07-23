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
    deps?: { name: string; author: string }[];
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

  type ToolState = { name: string; author?: string; description?: string; enabled: boolean };

  // 执行器公开面（环境层 UI / 胶水所需）
  type ExecutorApi = {
    registerAll(tools: ToolDef[]): { registered: string[]; rejected: string[] };
    list(includeAll?: boolean): ToolDef[];
    allToolStates(): ToolState[];
    setEnabled(name: string, enabled: boolean): Promise<void> | void;
    requestApproval(call: { name: string; code?: string; riskLevel?: string }, agent: Agent): Promise<boolean>;
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

  // ---- basement IIFE 全局（@require 引入，运行时已自动 init）----
  const MiniAgent: {
    agent: Agent;
    executor: ExecutorApi;
    handleToolCommand(text: string): Promise<void>;
    installHook(
      hookName: string,
      when: 'before' | 'after',
      fn: (opts: { args: unknown[]; [k: string]: unknown }) => unknown,
      opts: Record<string, unknown>,
    ): void;
    uninstallToolHooks(toolName: string): void;
    renderMarkdown(text: string): string;
  };
}
