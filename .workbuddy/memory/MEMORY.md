# MiniAgent 项目长期约定

## 架构铁律（OOP + withHooks 编排）
- 编排 / 初始化分层（用户 2026-07-19 修正）：会话级编排（系统提示注入、运行态、权限）走 `withHooks` 的 `before/after` 钩子；**工具注册（含 `onRegister`/`onUnregister` 编排重建）属"进工作循环前的基本初始化"，由 `init()` 在 boot 阶段执行，`executor.register` 即编排重建入口，不走钩子**。仍禁止顶层写死业务装配副作用（默认工具"定义"可顶层声明常量，但"注册动作"放 `init()`）。
- `base` 函数只保留最小核心流程（如队列引擎循环、LLM 调用），所有可控的插入/替换都交给钩子，便于编排方插拔/替换与 LLM 动态编辑。
- 钩子注册示例（用户原设计模式）：`agent.sendMessage.beforeExe.push(fn)`。
- `withHooks(fn, thisArg?)` 返回普通函数；`beforeExe/afterExe` 为数组；钩子 `opts={args,result}`；返回值严格跟随 base 同步/异步。

## 模块职责（锁定）
- `src/core/withHooks.ts` 工厂原语；`src/core/bus.ts` 极简事件总线。
- `src/core/llm.ts` 流式 + 参数补齐(temperature/maxTokens/reasoningEffort) + 响应(reasoningContent/finishReason/usage/model) + 首类 `cancel()`。
- `src/core/executor.ts` `run/runLoop` withHooks；`code_run` 确认闸在 `run` base（`REQUIRE_CODE_APPROVAL` 时 `await ui.requestApproval`）；`register/unregister` 写表后触发 `tool.onRegister/onUnregister`（RegisterCtx={storage,executor,agent}，agent 由 `attachAgent` 注入，executor 不 import agent 消循环），同名 register 先 `onUnregister` 旧再 `onRegister` 新；`list(includeHidden)` 默认过滤 hidden（喂 LLM），`list(true)` 全量（tool_list/系统提示用）；`run(call, agent)` 把 agent 注入 RunCtx（{storage,executor,agent,console}），编译 `code`/`onRegister` 用 `new Function` 沙箱；默认工具 storage_get/set(memory)、code_gen/code_run(code)、tool_create/tool_remove(tools)、`orchestrate_send`(hidden，包装 agent.sendMessage，系统编排原语，统一能力面)、`tool_list`(枚举全量)；`session` 工具（用户 2026-07-19 要求做成注册式工具）：其 `onRegister` 生成 sessionId、初始化 `session:<id>` 落盘、写 `default:sessions` 索引、并向 `agent.sendMessage.afterExe` 挂自动落盘钩子（每次对话轮结束把 messages 落盘到 `session:<id>`）。
- `src/core/storage.ts` 命名空间 API：`get/set/del/keys(namespace, key?)` 均 withHooks，内部 `realKey=ns+':'+key`，`keys(ns)` 返回去前缀子键；分区 default(config,sessions)/session/tools/code/(其他按同理新增)；`set.afterExe`→`bus.emit('storage:changed')`；`get` 改为真泛型（修旧 TS2558）。
- `src/ui/ui.ts` 原生组件 + 玻璃在气泡上；`chat.*`(普通)/`requestApproval`(withHooks)；无脚本内存储面板（编辑走油猴「存储」标签页）。
- `src/agent.ts` 全局单例 `globalThis.agent` + 队列引擎；`agent.sessionId` 由 session 工具 `onRegister` 生成；`init()` boot 阶段（进循环前）：config 迁移(`migrateFlatToNs`)+种子+`executor.attachAgent(agent)`+注册默认工具（含 session，其 `onRegister` 完成会话落盘安装）+`rehydrateTools()`（读 `tools:*`→构造 ToolDef→register→`onRegister` 重建）；`orchestrateSystemPrompt` 仍 `sendMessage.beforeExe` 钩子（会话级编排）。
- 装配入口 `src/agent.ts`，`vite.config.ts` entry 指向它。
