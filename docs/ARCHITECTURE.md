# MiniAgent 架构设计（v4）

> 本文档描述 MiniAgent 的核心架构与设计取舍。它取代早期随项目迁出、已丢失的设计稿，是当前架构的权威说明。

## 1. 设计哲学

- **不做框架，做组合**：整合网络上成熟的 JS 库与大模型自身的智能（推理 + 原生工具调用），直接产出可用的应用。
- **不被设计规范绑架**：不引入 graph DSL、不强制某种规划算法、不堆 enterprise 治理栈。内核极小，其余皆为加法。
- **低耦合、高内聚、可插拔**：新能力 = 注册一个新工具，核心代码纹丝不动。

## 2. 核心架构

- **Agent = 工具注册器（Tool Registrar）**：核心职责是登记工具（tool）。这是系统唯一的扩展点与安全边界。
- **Bootloader**：启动两项基础原语——
  - `chat`：大模型互动 / 语言接口（"脑"）；
  - `executor`：执行 / 动作（"手"）。
  - 两者起来后，即具备"大模型互动 + 执行"能力。
- **其余所有 tool**（记忆、网页抓取、DOM 操作、反思、规划……）完全在此基础之上注册即可，不动核心。

关注点切分：`chat` = 脑，`executor` = 手，`tool` = 桥。

## 3. 消息队列驱动的主循环

`chat` 启动后，主线程进入**消息处理循环**。UI 每次发送消息，向 `chat` 的**消息队列**压入一条消息——这是一个生产者/消费者 + 邮箱（mailbox）模型：UI 是生产者，只管往队列里压；主线程 loop 是唯一的消费者与驱动者。

```
UI ──enqueue(user)──▶ [ chat 消息队列 ] ──▶ 主线程 loop
                               │                    │
                               │                    ├─▶ chat  (LLM: 文本回复 / tool_call)
                               │                    │       │
                               │                    │       └─▶ executor (执行 tool)
                               │                    │               │
                               │                    │◀── enqueue(tool_result) ┘
                               │                    │
                               └── enqueue(system/control)──▶ (配置变更 / cancel / pause)
                                        │
                                        ▼
                                  输出态(state) ──▶ UI (流式 token / 工具状态)
```

- 入队方向（UI→chat）**单向**；输出走独立的 React 状态/事件通道，保证流式反馈与渲染解耦，UI 永不阻塞。
- `tool_result` 也走同一条队列：executor 执行完将结果 enqueue 回去，而非直接回调 `chat`。**loop 始终是唯一驱动者**，工具链路不会绕开队列。

### 3.1 消息类型（队列承载类型化消息）

| type | 生产者 | 含义 |
|---|---|---|
| `user` | UI | 用户消息，开启一个 turn |
| `tool_result` | executor | 工具执行结果，喂回 `chat` 续跑 |
| `system` | 内部 | 配置变更 / 会话重置 |
| `control` | UI / 内部 | `cancel` / `pause`（确定性中断，接 HITL） |

### 3.2 turn 原子性与排序

- 一个 `user` 消息驱动"一整个回合跑完"（含其中若干轮 tool 调用）再消费下一条 `user`。
- 回合内的 `tool_result` 按 turn / session id 归并，不走主 FIFO，避免新到的用户消息插进进行中的回合、污染上下文。
- 后到的用户消息在队列中等待，天然具备背压。
- `control` 类消息（如 `cancel`）由 loop 在每一步之间检查，实现确定性中断——这是接高风险动作人工确认（HITL）的基础。

## 4. 工具契约（唯一需要的"规范"）

注册器的价值取决于它强制的 tool 形状。这份契约要清楚，其余规范都不必：

- `name`：唯一标识
- `description`：给 LLM 看的用途说明（工具即界面，ACI）
- `inputSchema`：参数结构（用于校验，并防止把注入文本塞进字段）
- `handler`：执行函数
- `riskLevel`：`low` / `medium` / `high` / `critical`（高危走确定性确认）

## 5. 最小安全姿态（页面 MAIN 世界运行）

- 注册器天然 = **白名单**：只有注册过的 tool 才存在、才跑得动。
- `executor` 是风险汇聚点（运行在页面世界），保留三样极简护栏：
  1. 参数 `inputSchema` 校验；
  2. 按 `riskLevel` 对高风险 tool 走**确定性**确认（不由模型判断风险）；
  3. 全链路日志（plan / tool / args / result / error）支持回放。
- 不引入 enterprise 策略引擎，护栏成本压到最低。

## 6. 演进

- 记忆 / 反思 / 规划均登记为普通 tool，核心保持 `chat` + `executor`。
- 多 Agent 仅在确需时预留接口（层级式 Orchestrator），不做过度设计。
