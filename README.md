# MiniAgent

一组基于 **React + langchain.js + Ant Design** 的 userScript（Tampermonkey / Violentmonkey），把"大模型自编排 + 轻量工具注册"直接注入任意网页。

> 彻底无 Service Worker / background / sidepanel——成熟库优先复用，userScript 只是 delivery 载体。
> 架构演进：v1 薄中转基座 → v2 管理页 → v3 纯 userScript → **v4 React + langchain.js + Ant Design，内核极小、能力 = 注册工具**。

## 1. 设计哲学

- **组合优先**：整合成熟 JS 库与大模型自身智能（推理 + 原生工具调用），直接产出应用，不做框架。
- **内核极小**：Agent 只是工具注册器；其余一切（记忆、抓取、DOM、规划…）都是注册上去的 tool。
- **低耦合 / 可插拔**：新能力 = 注册一个新 tool，核心代码不动。
- **不被规范绑架**：不引入 graph DSL、不堆治理栈；唯一强制的是工具契约。

## 2. 技术栈

- **React 18** + **Ant Design 5**（重库走 `@require` 外链 CDN）—— UI
- **langchain.js**（`@langchain/core` + `@langchain/openai`）—— agent 编排（ReAct / tools / memory）
- **@sec-ant/gm-fetch** —— 把 `GM_xmlhttpRequest` 包成标准 `fetch`（流式），绕 CORS 直连 LLM
- **vite-plugin-monkey** —— 把 Vite + React 工程构建成 `.user.js`

## 3. 核心概念（词汇表）

| 概念 | 是什么 | 是不是注册器 |
|---|---|---|
| **Agent** | 根注册器，系统唯一扩展点与安全边界 | **是（唯一注册器）** |
| **chat** | 大模型交互循环：压消息入队列、驱动 LLM、产出文本 / tool_call | **否** |
| **chat_ui** | UI 编排层：工具开关 UI、渲染输入 / 气泡 / send-stop / 流式 | 否（调用 Agent 的注册能力） |
| **tool** | 注册单元：声明 `name+author` / `deps`，可选 `call` | 否（被注册的对象） |
| **code** | 一段代码，作为 "run code" tool 的内容被一次性执行 | — |
| **run code** | 一个 tool（有 `call`），提供一次性代码执行能力 | 否 |
| **toolregister** | 暴露给 LLM 的"注册工具"tool；LLM 经 tool_call 调用它来注册新 tool | 否（包装 `Agent.register`） |
| **tools 命名空间** | 持久化所有 tool 定义的存储命名空间 | — |

**关键澄清（易错点）**：

- `chat` **不是注册器**。它是"让大模型通过 tool_call 调用 `toolregister`"的过程——链路是 `LLM → toolregister → Agent.register`。
- `chat_ui` **不直接注册**，它直接调用 **Agent 的 `register` / `unregister`** 来管理工具开关。
- 真正的注册器只有 **Agent**。注册时把 `this`（= Agent）传给工具的 `register(ctx)`。

## 4. 架构与依赖

```
                Bootloader
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
   chat (含 executor)      chat_ui
  LLM 交互 + 调用控制     UI 编排 + 开关
        │                     │
        │  LLM tool_call       │ 直接调用 Agent.register/unregister
        ▼                     ▼
   toolregister  ───────►   Agent (根注册器)
        │                     │
        │                     ├─ tool.register(this = Agent)
        │                     ├─ 挂载 agent[name] = tool
        │                     └─ 依赖解析 / 按名挂载
        ▼
   tools 命名空间（持久化所有 tool 定义）
```

- 运行时方向：`chat` 驱动 LLM 循环，遇 `tool_call` 调 `toolregister` / 执行；`chat_ui` 独立编排 UI 并驱动 Agent 的开关。
- `executor` 已并入 `chat`，不再独立成原语。

## 5. `tools` 命名空间与工具清单（重点）

**所有 tool 定义持久化在存储的 `tools` 命名空间下。** "工具清单"就是**读取 `tools` 命名空间得到的全部 tool**——它是整个系统的工具真相源（single source of truth）。

同一份清单，按消费方不同派生出三个视图：

| 视图 | 数据范围 | 用途 |
|---|---|---|
| **chat_ui 开关清单** | `tools` 命名空间**全部**（含关闭项） | 持久化的开关 UI；用户在此开 / 关 |
| **boot 注册集** | 仅"**开启**"的 tool | 启动时 Agent 只注册这些；**关闭的不出现在 boot** |
| **LLM tool_call 清单** | 已注册且**有 `call`** 的 tool | 喂给大模型做 tool_call；无 `call` 的不展示 |

```
tools 命名空间 ──读取──▶ 工具清单 (全部)
                          ├─▶ chat_ui 开关 (全部, 持久化)
                          ├─▶ 过滤[开启] ──▶ boot 注册集 ──▶ Agent.register
                          └─▶ 过滤[已注册 & 有 call] ──▶ LLM tool_call 清单
```

> **关闭的工具**：从 `tools` 命名空间读取后标记为关，**不进入 boot 注册集**，因此下次启动也不会被注册；它的定义与配置**仍留在命名空间**（不清空、不清理存储）。再次开启时重新走 `Agent.register`。

## 6. 注册流程与依赖解析

1. 读取 `tools` 命名空间 → 取**开启**项。
2. **依赖解析（注册前，先排序再注册）**：
   - 每个 tool 声明 `deps: [{ name, author, version? }]`。
   - 按 `deps` 建依赖图，**拓扑排序**，解出"依赖在前、被依赖在后"的顺序再注册。
   - 唯一识别标识 = **`name + author`**；`version` 为可选项。
   - **author 不符** → `chat_ui` 提供**警告**，但可继续安装（非硬失败）。
   - **循环依赖** → 拒绝。
3. 逐个注册：`tool.register(this = Agent)` → 挂载 `agent[name] = tool`，并把 `this`（Agent）注入工具，供其回注 / 取用其它 tool。
4. boot 只注册开启项；关闭项留在清单不注册。

## 7. 调用控制与安装审查

- `chat`（含 executor）提供**工具调用控制**：按 `riskLevel` 对高风险 tool 走确定性确认（HITL），不由模型判断风险。
- **安装工具的确认过程**含一个分支选项：**AI 审查代码 → 给出建议 / 修改 → 回到安装调用**（带修改后的 code 重新 install）。
- `chat_ui` 开关：
  - **关闭** → 调用 `Agent.unregister(name)`（**不清理 `tools` 命名空间与存储**，故下次 boot 仍不加载）；
  - **开启** → 调用 `Agent.register(name)` 重新注册。

## 8. tool vs code + LLM 可见性

- **tool 有 `call`** → 出现在 LLM 的 tool_call 清单、可被直接调用。
- **tool 无 `call`** → **不向大模型展示 tool_call**，但仍注册挂载，提供方法（其它 tool 经 `this.tool.method()` 复用）与 `register(ctx)` 钩子，承载注册期行为。
- **code** = 一段代码；由 **"run code" tool**（有 `call`）作为内容**一次性执行**。
- 调用统一走 `call` / `handler`（存在时），由 `chat` 的执行 / 调用控制负责。

## 9. 工具契约（唯一需要的"规范"）

- `name` / `author`：唯一标识（组合）
- `description`：给 LLM 看的用途（工具即界面，ACI）
- `inputSchema`：参数结构（校验 + 防注入）
- `handler` / `call`：执行 / 调用入口（可选；无则不被 LLM 直调）
- `riskLevel`：`low` / `medium` / `high` / `critical`
- `deps`：`[{ name, author, version? }]`

## 10. 目录

```
MiniAgent/
├── package.json / tsconfig.json / vite.config.ts / .gitignore
├── src/
│   ├── app/        # main.tsx + App.tsx(组合 view + core)
│   ├── model/      # ModelConfig / Provider / createModel
│   ├── api/        # provider API 客户端接口
│   ├── view/       # ChatPanel / MessageBubble / ToolCard（由 chat_ui 编排）
│   └── core/       # langchain 编排骨架 + useAgent + Agent 注册器 + toolregister
├── docs/
│   ├── ARCHITECTURE.md   # 架构权威说明
│   └── ui-design.html    # UI 设计（玻璃方框浮层 / 靠边隐藏 / 3 秒展开）+ 交互原型
└── README.md
```

## 11. 开发

```bash
npm install
npm run dev       # monkey dev server，改代码自动重装脚本
                  # （Tampermonkey 里把 Modify CSP → Remove entirely，否则 dev 注入可能被 CSP 拦截）
npm run build     # 产出 dist/MiniAgent.user.js，导入 Tampermonkey 即用
npm run typecheck # tsc --noEmit
```

## 12. 设计文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 架构权威说明（注册器、消息队列主循环、工具契约、安全姿态）
- [`docs/ui-design.html`](docs/ui-design.html) —— UI 设计（v4 整合稿：设计说明 + 交互原型）

## 13. 状态

v4 阶段 0 骨架：UI 可编译运行；核心架构（Agent 注册器 / chat / chat_ui / `tools` 命名空间 / 依赖解析）已定稿，待落地实现。
