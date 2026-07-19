# MiniAgent UI 设计（v4）

> 本文档描述 MiniAgent 的 UI 分层、组件职责与消息气泡（Message Bubble）状态逻辑，是 `docs/ARCHITECTURE.md` 中"消息队列主循环"在界面层的落地。当前为设计稿，不含实现代码。

## 1. UI 分层与依赖顺序

UI 严格沿架构层叠加，依赖方向自下而上：

```
工具加载器 (Tool Loader / 注册表)
        │  提供：已注册工具列表 + 启用状态
        ▼
     chat (对话面)
        │  提供：input · send/stop 按钮 · message bubble
        ▼
   executor (工具面，叠加在 chat 之上)
           提供：input 前的工具列表+开关 · bubble 上的确认
```

- **工具加载器**：数据底座，UI 极薄（仅暴露状态供 executor 绑定）。工具本身在外部"工具存储编辑界面"中定义。
- **chat**：对话骨架，不依赖 executor 即可渲染。
- **executor**：在 chat 容器上叠加工具相关 UI。运行时调用方向相反——chat 驱动 loop，遇到 tool_call 才调 executor。

> 运行时方向：chat → executor（chat 驱动，调用 executor 执行工具）。UI 方向：executor 长在 chat 上。两层均单向依赖，无环。

## 2. Provider 配置：外部跳转，不嵌面板

基座配置（API key / model / base_url）**不进入 chat 面板**。chat 核心仅提供一个入口（设置/链接图标），点击跳转至**工具存储编辑界面**（外部配置页）。理由：避免面板内嵌基座开发，配置与工具统一管理在存储编辑器中。

- chat 核心组件：`input` · `send/stop` · `message bubble` · **设置/存储链接入口**（图标，打开外部编辑器 URL）。

## 3. 组件职责

### 3.1 chat（核心）

| 组件 | 职责 |
|---|---|
| `input` | 文本输入；回合进行中禁用或转为 stop 语义 |
| `send / stop` 按钮 | 双态：空闲=send（输入非空可点）；回合中=stop |
| `message bubble` | 渲染消息列表，按 role/state 分支（见第 4 节） |
| 设置/存储链接 | 跳转外部工具存储编辑界面 |

### 3.2 executor（叠加）

| 组件 | 位置 | 职责 |
|---|---|---|
| 工具列表 + 开关 | `input` **前方** | 列出已注册工具，每行：名称 + 描述 + 风险徽标 + 启用开关；开关改写注册表启用集（白名单）；面板可折叠 |
| 确认控件 | `message bubble` 上（仅工具 bubble 的 `pending` 态） | 高风险工具执行前显示 批准/拒绝；批准→执行，拒绝→回灌 `refused` |

## 4. Message Bubble 逻辑（核心）

气泡按 **role** 与 **内容类型** 分支。工具是 assistant 的子类型，不是独立 role。

### 4.1 气泡类型

| 类型 | 对齐 | 说明 |
|---|---|---|
| **User** | 右 | 用户消息，`sent` 单一状态 |
| **Assistant 文本** | 左 | LLM 文本回复 |
| **Assistant 工具** | 左 | 工具调用/结果，经 `ToolCard` 渲染 |
| **System** | 中 | 状态/通知（"已停止"、"工具已禁用"、错误通告） |

### 4.2 Role × State 矩阵

| Role | 状态 | 视觉 |
|---|---|---|
| user | `sent` | 实心气泡，右对齐 |
| assistant(text) | `streaming` | 光标/渐显，左对齐 |
| assistant(text) | `completed` | 正常文本 |
| assistant(text) | `error` | 错误提示样式 |
| assistant(tool) | `pending` | 工具调用卡 + **批准/拒绝**（仅 high/critical） |
| assistant(tool) | `running` | 工具卡 + 进行指示（spinner） |
| assistant(tool) | `result` | 工具卡 + 结果内容 |
| assistant(tool) | `error` | 工具卡 + 错误 |
| assistant(tool) | `refused` | 工具卡 + "已拒绝"（静音样式） |
| system | `info` | 居中/弱样式状态条 |

### 4.3 Assistant 工具状态机

```
            tool_call (来自 LLM)
                  │
                  ▼
          ┌───────────────┐
          │   pending     │  riskLevel ∈ {high, critical}
          └──────┬────────┘
       批准 │            │ 拒绝
            ▼            ▼
      ┌──────────┐   ┌──────────┐
      │ running  │   │ refused  │──► enqueue(refused) 回 chat
      └────┬─────┘   └──────────┘
    成功/失败
       ┌──┴──┐
       ▼     ▼
   result  error

   riskLevel ∈ {low, medium}：跳过 pending，直接 running。
```

- `pending` 绑定 turn/message id；建议带超时（超时视为拒绝或保持待确认，由策略定）。
- 拒绝不是静默丢弃：enqueue 一个 `refused` 结果，LLM 据此调整后续行为。

### 4.4 与消息队列的映射

| UI 事件 | 入队消息类型 | 产生的气泡 |
|---|---|---|
| 用户发送 | `user` | User bubble |
| LLM 流式输出 | （流，非队列项） | Assistant 文本 streaming→completed |
| LLM 发 tool_call | （触发 executor） | Assistant 工具 pending/running |
| executor 完成 | `tool_result` | Assistant 工具 result/error |
| 用户拒绝 | `refused`（回灌） | Assistant 工具 refused |
| 停止/配置变更 | `control` / `system` | System bubble |

## 5. Send / Stop 双态按钮

- **空闲**：显示 `send`，输入非空时可点；点击 → enqueue `user`。
- **回合进行中**（含工具执行、含 pending 确认等待）：显示 `stop`；点击 → enqueue `control: cancel` → loop 在每步间检查并中断 **流式 LLM** 与 **进行中的工具执行** 两头。

## 6. 工具列表面板（executor）

- 数据源：工具加载器的注册表（名称/描述/riskLevel/启用）。
- 每行：名称 + 描述（hover 提示） + 风险徽标（low/medium/high/critical 配色） + 启用开关。
- 开关改写注册表启用集 → 仅启用工具可被 executor 调用（即白名单）。
- 面板可折叠，节省窄面板空间。
- 禁用某工具应在下一回合生效（turn 原子性）。

## 7. 文本线框（Wireframe）

```
┌─────────────────────────────────────┐
│ MiniAgent                    [🔗设置] │  ← 设置=跳转工具存储编辑界面
├─────────────────────────────────────┤
│ ▸ 工具 (点击展开)                     │  ← 可折叠工具面板
│   ├ 网页搜索        low    [开]      │
│   ├ DOM 提取        medium  [开]    │
│   ├ 执行 JS         high    [关]    │  ← 开关改写注册表
│   └ Memory 写入     critical [开]   │
├─────────────────────────────────────┤
│            [系统] 已连接              │  ← system bubble
│                                     │
│  帮我查下本页标题并记下来     [用户] │  ← user bubble (右)
│                                     │
│  [助手] 我来执行 DOM 提取：          │  ← assistant 文本
│  ┌─ ToolCard: DOM 提取 ──────────┐  │
│  │ 读取 document.title           │  │
│  │ [批准] [拒绝]   ← pending      │  │  ← 高风险确认
│  └───────────────────────────────┘ │
│  ┌─ ToolCard: DOM 提取 ──────────┐  │
│  │ ✅ 结果: "MiniAgent 项目主页"  │  │  ← result
│  └───────────────────────────────┘ │
│  [助手] 已记录 ✅             │      │  ← assistant 文本
├─────────────────────────────────────┤
│ [ 输入消息…                        ]│ [发送] │  ← input + send/stop
└─────────────────────────────────────┘
```

## 8. 可访问性与边界态

- 触摸目标 ≥ 44px（开关、按钮）。
- 窄面板（userScript 注入侧栏）下工具面板默认折叠。
- 空状态：无消息时显示工具面板 + 输入提示，无欢迎气泡亦可。
- 错误态统一：文本气泡 `error`、工具 `error`、系统通告，三者样式区分但都明确。
- 流式输出时 `input` 禁用或转 stop，避免重复发送打断回合。

## 9. 与 ARCHITECTURE.md 的关系

- `docs/ARCHITECTURE.md`：核心架构、消息队列主循环、消息类型（user/tool_result/system/control）、工具契约、最小安全姿态。
- 本文档：将上述 loop 与消息类型映射到**界面组件与气泡状态**，是架构在 UI 层的展开。两者共用同一套消息类型与 turn 原子性定义。
