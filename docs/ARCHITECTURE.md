# MiniAgent 架构设计（v4，整合稿）

> 本文档是 MiniAgent 核心架构的权威说明，取代早期随项目迁出、已丢失的设计稿。UI 层见 `docs/ui-design.html`，项目总览见 `README.md`。

## 1. 设计哲学

- **组合优先**：整合成熟 JS 库与大模型自身智能（推理 + 原生工具调用），直接产出应用，不做框架。
- **内核极小**：Agent 只是工具注册器；其余一切（记忆、抓取、DOM、规划…）都是注册上去的 tool。
- **低耦合 / 可插拔**：新能力 = 注册一个新 tool，核心代码纹丝不动。
- **不被规范绑架**：不引入 graph DSL、不堆治理栈；唯一强制的是工具契约。

## 2. 核心架构

### 2.1 组件与角色

| 组件 | 职责 | 是否注册器 |
|---|---|---|
| **Agent** | 根注册器；系统唯一扩展点与安全边界 | **是（唯一注册器）** |
| **chat** | 大模型交互循环：压消息入队列、驱动 LLM、产出文本 / tool_call；**内嵌 executor** | **否** |
| **chat_ui** | UI 编排层：工具开关 UI、渲染输入 / 气泡 / send-stop / 流式；**直接调用 Agent 的 register/unregister** | 否 |
| **tool_register** | 暴露给 LLM 的"注册工具"tool；LLM 经 tool_call 调用它来注册新 tool（包装 `Agent.register`） | 否 |
| **tool** | 注册单元：声明 `name+author` / `deps`，可选 `call` | 否（被注册对象） |
| **code** | 一段代码，作为 "run code" tool 的内容被一次性执行 | — |
| **run code** | 一个 tool（有 `call`），提供一次性代码执行能力 | 否 |
| **tools 命名空间** | 持久化所有 tool 定义的存储命名空间 | — |

### 2.2 关键澄清

- **`chat` 不是注册器**。它是"让大模型通过 tool_call 调用 `tool_register`"的过程——链路是 `LLM → tool_register → Agent.register`。
- **`chat_ui` 不直接注册**，它直接调用 **Agent 的 `register` / `unregister`** 管理工具开关。
- 真正的注册器只有 **Agent**。注册时把 `this`（= Agent）传给工具的 `register(ctx)`。
- `executor` 已并入 `chat`，不再独立成原语。

### 2.3 架构图

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
   tool_register  ───────►   Agent (根注册器)
        │                     │
        │                     ├─ tool.register(this = Agent)
        │                     ├─ 挂载 agent[name] = tool
        │                     └─ 依赖解析 / 按名挂载
        ▼
   tools 命名空间（持久化所有 tool 定义）
```

## 3. `tools` 命名空间与工具清单

**所有 tool 定义持久化在存储的 `tools` 命名空间下。** "工具清单"就是**读取 `tools` 命名空间得到的全部 tool**——它是整个系统的工具真相源。

同一份清单按消费方派生三个视图：

| 视图 | 数据范围 | 用途 |
|---|---|---|
| **chat_ui 开关清单** | `tools` 命名空间**全部**（含关闭项） | 持久化开关 UI；用户在此开 / 关 |
| **boot 注册集** | 仅"**开启**"的 tool | 启动时 Agent 只注册这些；**关闭的不出现在 boot** |
| **LLM tool_call 清单** | 已注册且**有 `call`** 的 tool | 喂给大模型做 tool_call；无 `call` 的不展示 |

```
tools 命名空间 ──读取──▶ 工具清单 (全部)
                          ├─▶ chat_ui 开关 (全部, 持久化)
                          ├─▶ 过滤[开启] ──▶ boot 注册集 ──▶ Agent.register
                          └─▶ 过滤[已注册 & 有 call] ──▶ LLM tool_call 清单
```

**关闭的工具**：从 `tools` 命名空间读取后标记为关，**不进入 boot 注册集**，下次启动也不注册；其定义与配置仍留在命名空间（不清空、不清理存储）。再次开启时重新走 `Agent.register`。

## 4. 消息队列驱动的主循环

`chat` 启动后，主线程进入**消息处理循环**。UI 每次发送消息，向 `chat` 的**消息队列**压入一条消息——生产者/消费者 + 邮箱模型：UI 是生产者，只管压队；主线程 loop 是唯一消费者与驱动者。

```
UI ──enqueue(user)──▶ [ chat 消息队列 ] ──▶ 主线程 loop (chat 驱动)
                               │                    │
                               │                    ├─▶ LLM: 文本回复 / tool_call
                               │                    │       │
                               │                    │       ├─▶ tool_register (注册新 tool)
                               │                    │       └─▶ 执行 tool.call (executor 在 chat 内)
                               │                    │               │
                               │                    │◀── enqueue(tool_result) ┘
                               │                    │
                               └── enqueue(system/control)──▶ (配置变更 / cancel / pause)
                                        │
                                        ▼
                                  输出态(state) ──▶ UI (流式 token / 工具状态)
```

- 入队方向（UI→chat）**单向**；输出走独立事件通道，流式反馈与渲染解耦，UI 永不阻塞。
- `tool_result` 也走同一条队列：执行完将结果 enqueue 回去，loop 始终是唯一驱动者。

### 4.1 消息类型

| type | 生产者 | 含义 |
|---|---|---|
| `user` | UI | 用户消息，开启一个 turn |
| `tool_result` | executor(in chat) | 工具执行结果，喂回 `chat` 续跑 |
| `system` | 内部 | 配置变更 / 会话重置 |
| `control` | UI / 内部 | `cancel` / `pause`（确定性中断，接 HITL） |

### 4.2 turn 原子性与排序

- 一个 `user` 消息驱动"一整个回合跑完"（含若干轮 tool 调用）再消费下一条 `user`。
- 回合内 `tool_result` 按 turn / session id 归并，不走主 FIFO，避免新到用户消息插进进行中的回合。
- 后到用户消息在队列等待，天然具备背压。
- `control`（如 `cancel`）由 loop 每步间检查，实现确定性中断——接高风险动作人工确认（HITL）的基础。

## 5. 注册流程与依赖解析

工具注册由 **Agent** 执行，流程如下：

1. 读取 `tools` 命名空间 → 取**开启**项（关闭项不进入 boot）。
2. **依赖解析（先排序再注册）**：
   - 每个 tool 声明 `deps: [{ name, author, version? }]`。
   - 按 `deps` 建依赖图，**拓扑排序**，解出"依赖在前、被依赖在后"的顺序。
   - 唯一识别标识 = **`name + author`**；`version` 为可选项。
   - **author 不符** → `chat_ui` 提供**警告**，但可继续安装（非硬失败）。
   - **循环依赖** → 拒绝。
3. 逐个注册：`tool.register(this = Agent)` → 挂载 `agent[name] = tool`，并把 `this`（Agent）注入工具，供其回注 / 取用其它 tool（如 `this.<depName>`）。
4. boot 只注册开启项；关闭项留在清单不注册。

### 5.1 注册器模式（`this` 传递）

- **Agent 是唯一注册器**；`chat` / `chat_ui` / `tool_register` 都不是注册器。
- 注册时 `Agent.register(tool)` 内部调用 `tool.register(this)`，把 **`this`（=Agent 实例）** 作为注册上下文传给工具。
- 工具据此可：注册子工具、enqueue、读取 `this.<name>` 取已挂载工具、访问共享服务。
- `chat_ui` 通过直接调用 `Agent.register/unregister` 管理开关；LLM 通过 `tool_register`（→ `Agent.register`）自扩展。

### 5.2 按名挂载

- 注册成功：`agent[name] = toolInstance`（以工具名挂载到 Agent）。
- 便捷访问：`agent.<name>` 直接取工具对象；`if (agent.<name>)` / `'<name>' in agent` 判断存在性。
- 权威注册表另存一份 `Map<name, tool>` 用于遍历 / 去重 / 白名单；命名挂载是便捷访问层。
- author 冲突由"警告 + 继续"处理（见 §5 解析规则），不静默覆盖。

## 6. 调用控制与安装审查

- `chat`（含 executor）提供**工具调用控制**：按 `riskLevel` 对高风险 tool 走确定性确认（HITL），不由模型判断风险。
- **安装工具的确认过程**含分支选项：**AI 审查代码 → 给出建议 / 修改 → 回到安装调用**（带修改后的 code 重新 install）。
- `chat_ui` 开关：
  - **关闭** → `Agent.unregister(name)`（**不清理 `tools` 命名空间与存储**，故下次 boot 仍不加载）；
  - **开启** → `Agent.register(name)` 重新注册。

## 7. tool vs code + LLM 可见性

- **tool 有 `call`** → 出现在 LLM 的 tool_call 清单、可被直接调用。
- **tool 无 `call`** → **不向大模型展示 tool_call**，但仍注册挂载，提供方法（其它 tool 经 `this.tool.method()` 复用）与 `register(ctx)` 钩子，承载注册期行为。
- **code** = 一段代码；由 **"run code" tool**（有 `call`）作为内容**一次性执行**。
- 调用统一走 `call` / `handler`（存在时），由 `chat` 的执行 / 调用控制负责。

## 8. 工具契约（唯一需要的"规范"）

注册器的价值取决于它强制的 tool 形状。这份契约要清楚，其余规范都不必：

- `name` / `author`：唯一标识（组合）
- `description`：给 LLM 看的用途说明（工具即界面，ACI）
- `inputSchema`：参数结构（用于校验，并防止把注入文本塞进字段）
- `handler` / `call`：执行 / 调用入口（可选；无则不被 LLM 直调）
- `riskLevel`：`low` / `medium` / `high` / `critical`（高危走确定性确认）
- `deps`：`[{ name, author, version? }]`

## 9. 最小安全姿态（页面 MAIN 世界运行）

- 注册器天然 = **白名单**：只有注册过的 tool 才存在、才跑得动（尤其是 `tools` 命名空间只加载开启项）。
- `chat`（含 executor）是风险汇聚点，保留三样极简护栏：
  1. 参数 `inputSchema` 校验；
  2. 按 `riskLevel` 对高风险 tool 走**确定性**确认（不由模型判断风险）；
  3. 安装期可选 **AI 审查代码** 分支（§6），对来源不明 tool 做发布前把关。
- 全链路日志（plan / tool / args / result / error）支持回放。
- 不引入 enterprise 策略引擎，护栏成本压到最低。

## 10. 演进

- 记忆 / 反思 / 规划均登记为普通 tool，核心保持 `chat` + `chat_ui` + 注册器。
- 多 Agent 仅在确需时预留接口（层级式 Orchestrator），不做过度设计。
- `tool_register` 让 LLM 具备自扩展能力（安装新 tool），是内核极少却可生长的关键支点。
