# MiniAgent

一个把"大模型自编排 + 轻量工具注册"直接注入任意网页的 userScript（Tampermonkey / Violentmonkey）。

> 纯原生 TypeScript + 手写 DOM，无框架、无 CDN、无 Service Worker。运行时依赖仅 `@sec-ant/gm-fetch`。
> 架构：OOP 内核 + `withHooks` 钩子编排；能力 = 注册工具，内核极小。

## 1. 设计哲学

- **组合优先**：整合大模型自身智能（推理 + 原生工具调用），直接产出应用，不做框架。
- **内核极小**：Agent 只是工具注册器；其余一切（记忆、抓取、DOM、规划…）都是注册上去的 tool。
- **低耦合 / 可插拔**：新能力 = 注册一个新 tool，核心代码不动。
- **钩子编排**：会话级编排（系统提示注入、运行态、权限）走 `withHooks` 的 `before/after` 钩子；工具注册属初始化，由 `init()` 在 boot 阶段执行。
- **不被规范绑架**：不引入 graph DSL、不堆治理栈；唯一强制的是工具契约。

## 2. 技术栈

- **原生 TypeScript + 手写 DOM**（无 React / Ant Design / langchain.js）—— UI 与逻辑全靠原生 API
- **@sec-ant/gm-fetch** —— 把 `GM_xmlhttpRequest` 包成标准 `fetch`（流式），绕 CORS 直连 LLM
- **vite-plugin-monkey** —— 把 Vite 工程构建成 `.user.js`

## 3. 核心概念（词汇表）

| 概念 | 是什么 | 是不是注册器 |
|---|---|---|
| **Agent** | 根注册器，系统唯一扩展点与安全边界 | **是（唯一注册器）** |
| **chat / engine** | 大模型交互循环：压消息入队列、驱动 LLM、产出文本 / tool_call | 否 |
| **ui.chat** | UI 渲染层：输入 / 气泡 / send-stop / 流式 / 工具开关面板 | 否（调用 Agent 的注册能力） |
| **tool** | 注册单元：声明 `name+author` / `deps`，可选 `call` | 否（被注册的对象） |
| **run_js** | 一个 tool（有 `call`），提供一次性 JS 代码执行能力 | 否 |
| **tool_manager** | 暴露给 LLM 的统一工具自编排管理 tool（action=register/remove/list）；LLM 经 tool_call 调用它来注册/删除/枚举 tool | 否（包装 `executor.register`/`unregister`） |
| **tools 命名空间** | 持久化所有 tool 定义的存储命名空间（真相源） | — |

**关键澄清**：

- `chat` 不是注册器。它是"让大模型通过 tool_call 调用 `tool_manager`"的过程——链路是 `LLM → tool_manager → executor.register`。
- `ui.chat` 不直接注册，它调用 **executor 的 `setEnabled`**（内部走 register/unregister）来管理工具开关。
- 真正的注册器只有 **executor**（挂载于 agent）。注册时把 `this`（= Agent）传给工具的 `register(ctx)`。

## 4. 架构与依赖

```
              agent.init()  (boot)
        ┌──────────┴───────────┐
        ▼                      ▼
   engine (队列循环)         ui.chat (渲染)
   LLM 交互 + 调用控制       气泡/输入/工具面板
        │                      │
        │ LLM tool_call         │ setEnabled → register/unregister
        ▼                      ▼
   tool_manager   ───────►  executor (根注册器)
        │                      │
        │                      ├─ tool.register(ctx.this = Agent)
        │                      ├─ 挂载 agent[name] = tool
        │                      └─ 依赖拓扑排序 / 按名挂载
        ▼
   tools 命名空间（持久化所有 tool 定义，真相源）
```

- 运行时方向：`engine` 驱动 LLM 循环，遇 `tool_call` 调 `executor.run`；`ui.chat` 独立渲染并经 `setEnabled` 驱动开关。
- 编排分层：会话级编排（系统提示注入、运行态按钮、权限确认）走 `withHooks` 钩子；工具注册由 `init()` 在 boot 阶段执行。

## 5. `tools` 命名空间与三视图

**所有 tool 定义持久化在存储的 `tools` 命名空间下**，是整个系统的工具真相源。同一份清单按消费方派生三个视图：

| 视图 | 数据范围 | 用途 |
|---|---|---|
| **ui 工具面板** | `tools` 命名空间**全部**（含关闭项）+ 内置工具 | 开关 UI；用户在此开 / 关 |
| **boot 注册集** | 仅"**开启**"的 tool | 启动时只注册这些；关闭的不进 boot |
| **LLM tool_call 清单** | 已注册且**有 `call`** 的 tool | 喂给大模型；无 `call` 的不展示 |

> **关闭的工具**：定义与配置仍留在命名空间（不清空存储），只是不进 boot 注册集。再次开启时重新走 `executor.register`。

## 6. 注册流程与依赖解析

1. 读取 `tools` 命名空间 → 取**开启**项。
2. **依赖解析（注册前，先排序再注册）**：
   - 每个 tool 声明 `deps: [{ name, author, version? }]`。
   - 按 `deps` 建依赖图，**拓扑排序**，解出"依赖在前"的顺序再注册。
   - 唯一识别标识 = **`name + author`**。
   - **author 不符** → 警告，但可继续安装（非硬失败、不静默覆盖）。
   - **循环依赖** → 拒绝。
3. 逐个注册：`tool.register(ctx)` → 挂载 `agent[name] = tool`，注入 `this`（Agent）。
4. boot 只注册开启项；关闭项留在清单不注册。

## 7. 调用控制与安全姿态

- `executor.run` 提供**工具调用控制**：按 `riskLevel` 对高风险 tool 走确定性确认（HITL），阈值可配（`APPROVAL_RISK_LEVEL`），不由模型判断风险。
- **安装审查**（阶段 3 待做）：安装期 AI 审查代码分支。
- `ui` 工具开关：
  - **关闭** → `executor.unregister(name)`（不清理 `tools` 命名空间）；
  - **开启** → `executor.register(name)` 重新注册。

## 8. tool 可见性

- **tool 有 `call`** → 出现在 LLM 的 tool_call 清单、可被直接调用。
- **tool 无 `call`** → **不向大模型展示**，但仍注册挂载，提供方法（其它 tool 经 `this.tool` 复用）与 `register(ctx)` 钩子。
- 调用统一走 `call`，由 `executor.run` 的调用控制负责。

## 9. 工具契约（唯一需要的"规范"）

- `name` / `author`：唯一标识（组合）
- `description`：给 LLM 看的用途（工具即界面，ACI）
- `parameters`：发给模型的 JSON Schema（OpenAI 标准字段名 `parameters`）。`required` 只列通用必填（单用途工具=全部属性；action 类工具=仅 `action`，其余参数由 `call` 按 action 自查）；`additionalProperties:false` 始终保证。`strict` 仅当 `required` 覆盖全部属性时为 `true`（structured outputs），否则 `false`、允许可选参数。
- `call`：执行入口（可选；无则不被 LLM 直调）
- `riskLevel`：`low` / `medium` / `high` / `critical`
- `deps`：`[{ name, author, version? }]`
- `register` / `unregister`：安装 / 卸载钩子（可选）

## 10. 目录

```
MiniAgent/
├── package.json / tsconfig.json / vite.config.ts
├── src/
│   ├── core/        # withHooks / llm / executor / storage —— 编排原语与内核
│   ├── ui/          # ui.ts —— 原生 DOM 组件（气泡/输入/确认/工具面板）
│   ├── model/       # config.ts —— 配置（provider/key/riskLevel/disabledTools）
│   └── agent.ts     # 全局单例 + 队列引擎 + init() boot
├── docs/
│   ├── ARCHITECTURE.md   # 架构权威说明（注册器、消息队列、工具契约、安全姿态）
│   └── ui-design.html    # UI 设计原型
└── README.md
```

## 11. 开发

```bash
npm install
npm run dev       # monkey dev server，改代码自动重装脚本
npm run build     # 产出 dist/miniagent.user.js，导入 Tampermonkey 即用
npm run typecheck # tsc --noEmit
```

## 12. 设计文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 架构权威说明（注册器、消息队列主循环、工具契约、安全姿态）
- [`docs/ui-design.html`](docs/ui-design.html) —— UI 设计原型

## 13. 状态

- **阶段 1 已完成**：工具契约 + 拓扑排序注册 + 按名挂载 + list-by-call + 确认闸 riskLevel。
- **阶段 2 已完成**：riskLevel 配置化 + 工具启停面板 + setEnabled/allToolStates + unsafeWindow.agent 暴露。
- **阶段 3（可选）**：消息类型 system/control 与 turn 原子性、安装期 AI 审查（parameters 参数校验已由 `strict:true` 模式由模型侧覆盖）。
