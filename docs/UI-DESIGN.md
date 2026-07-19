# MiniAgent UI 设计（v4）

> 本文档描述 MiniAgent 的 UI 分层、组件职责与消息气泡（Message Bubble）状态逻辑，是 `docs/ARCHITECTURE.md` 中"消息队列主循环"在界面层的落地。当前为设计稿，不含实现代码。
>
> **形态约束（v2 调整）**：UI 为**浮于宿主页面的玻璃态浮层**——**无背景板、无标题栏**；输入框与气泡均为**毛玻璃透明**；工具入口是**输入框左侧的按钮**，点击展开；外部工具存储编辑**链接仅出现在配置异常报错气泡内**，不在常态 UI 中。

## 1. UI 分层与依赖顺序

UI 严格沿架构层叠加，依赖方向自下而上；视觉上整体为透明浮层，无独立容器底板：

```
工具加载器 (Tool Loader / 注册表)
        │  提供：已注册工具列表 + 启用状态
        ▼
     chat (对话面)
        │  提供：input(glass) · send/stop 按钮 · message bubble(glass)
        ▼
   executor (工具面，叠加在 chat 之上)
           提供：input 左侧工具按钮(展开面板) · bubble 上的确认
```

- **工具加载器**：数据底座，UI 极薄（仅暴露状态供 executor 绑定）。工具本身在外部"工具存储编辑界面"中定义。
- **chat**：对话骨架，不依赖 executor 即可渲染；整体浮于页面、无背景板无标题栏。
- **executor**：在 chat 容器上叠加工具相关 UI。运行时调用方向相反——chat 驱动 loop，遇到 tool_call 才调 executor。

> 运行时方向：chat → executor（chat 驱动，调用 executor 执行工具）。UI 方向：executor 长在 chat 上。两层均单向依赖，无环。

## 2. Provider 配置：异常时才给跳转链接

基座配置（API key / model / base_url）**不进入常态 chat UI**，常态无设置/编辑按钮。仅当**配置加载失败**时，由 `system(error)` 气泡承载一条跳转链接，指向**工具存储编辑界面**（外部配置页）。理由：避免面板内嵌基座开发，配置与工具统一管理在存储编辑器中；常态不打扰用户，异常才引导修复。

- 常态 chat 核心组件：`input`(glass) · `send/stop` · `message bubble`(glass) · **工具入口按钮（input 左侧）**。
- 异常态：`system(error)` 气泡内嵌 `err-link` → 打开外部编辑器 URL。

## 3. 组件职责

### 3.1 chat（核心，浮层）

| 组件 | 职责 |
|---|---|
| `input` | 玻璃态文本输入；回合进行中禁用或转为 stop 语义 |
| `send / stop` 按钮 | 双态：空闲=send（输入非空可点）；回合中=stop |
| `message bubble` | 玻璃态渲染消息列表，按 role/state 分支（见第 4 节） |
| 工具入口按钮 | 位于 `input` **左侧**；点击展开/收起工具注册表面板 |

### 3.2 executor（叠加）

| 组件 | 位置 | 职责 |
|---|---|---|
| 工具注册表面板 | 由 input 左侧按钮**展开**（浮于输入行上方 popover） | 列出已注册工具，每行：名称 + 描述 + 风险徽标 + 启用开关；开关改写注册表启用集（白名单） |
| 确认控件 | `message bubble` 上（仅工具 bubble 的 `pending` 态） | 高风险工具执行前显示 批准/拒绝；批准→执行，拒绝→回灌 `refused` |

## 4. Message Bubble 逻辑（核心）

气泡按 **role** 与 **内容类型** 分支。工具是 assistant 的子类型，不是独立 role。所有气泡均为**毛玻璃透明**效果。

### 4.1 气泡类型

| 类型 | 对齐 | 说明 | 玻璃基调 |
|---|---|---|---|
| **User** | 右 | 用户消息，`sent` 单一状态 | 品牌蓝透明 |
| **Assistant 文本** | 左 | LLM 文本回复 | 中性深色透明 |
| **Assistant 工具** | 左 | 工具调用/结果，经 `ToolCard` 渲染 | 中性深色透明 |
| **System** | 中 | 状态/通知（"已停止"、"工具已禁用"） | 极弱透明 |
| **System(error)** | 中 | 配置异常通告，**内含跳转链接** | 红调透明 |

### 4.2 Role × State 矩阵

| Role | 状态 | 视觉 |
|---|---|---|
| user | `sent` | 玻璃气泡，右对齐 |
| assistant(text) | `streaming` | 光标/渐显，左对齐 |
| assistant(text) | `completed` | 正常文本 |
| assistant(text) | `error` | 错误提示样式 |
| assistant(tool) | `pending` | 工具调用卡 + **批准/拒绝**（仅 high/critical） |
| assistant(tool) | `running` | 工具卡 + 进行指示（spinner） |
| assistant(tool) | `result` | 工具卡 + 结果内容 |
| assistant(tool) | `error` | 工具卡 + 错误 |
| assistant(tool) | `refused` | 工具卡 + "已拒绝"（静音样式） |
| system | `info` | 居中/弱样式状态条 |
| system(error) | `config_error` | 红调玻璃 + 跳转链接（仅此处出现外部编辑器入口） |

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
| 配置加载失败 | `system(error)` | System(error) bubble + 跳转链接 |

## 5. Send / Stop 双态按钮

- **空闲**：显示 `send`，输入非空时可点；点击 → enqueue `user`。
- **回合进行中**（含工具执行、含 pending 确认等待）：显示 `stop`；点击 → enqueue `control: cancel` → loop 在每步间检查并中断 **流式 LLM** 与 **进行中的工具执行** 两头。

## 6. 工具入口与注册表面板（executor）

- 入口形态：**输入行最左侧的圆形玻璃按钮**（🔧），右上角带"启用 N/总"计数角标。
- 交互：点击按钮 → 工具面板以 **popover** 形式浮于输入行**上方**展开；再点收起。无独立常驻面板、无标题栏。
- 数据源：工具加载器的注册表（名称/描述/riskLevel/启用）。
- 每行：名称 + 描述（hover 提示） + 风险徽标（low/medium/high/critical 配色） + 启用开关。
- 开关改写注册表启用集 → 仅启用工具可被 executor 调用（即白名单）。
- 禁用某工具应在下一回合生效（turn 原子性）。
- 计数角标实时反映启用数量（"启用 N / 4"）。

## 7. 文本线框（Wireframe，v2 浮层形态）

```
（无背景板 · 无标题栏 · 直接浮于宿主页面）

            [系统] 已加载 4 个工具          ← system bubble (玻璃)
                                     [用户] │  ← user bubble 右(玻璃)
  [助手] 我来执行 DOM 提取：         │      ← assistant 文本(玻璃)
  ┌─ ToolCard: DOM 提取 ──────────┐  │
  │ medium · 仅读取公开网页        │  │
  │ [允许执行] [拒绝]   ← pending  │  │      ← 高风险确认
  └───────────────────────────────┘  │
  ┌─ System(error) 配置异常 ──────┐  │      ← 仅此处出现外部链接
  │ provider 未配置或令牌失效      │  │
  │ [前往工具存储编辑 →]           │  │
  └───────────────────────────────┘  │

  ┌──────────────────────────────────────┐
  │ (点击🔧展开) 工具注册表面板(popover)    │  ← 浮于输入行上方
  │   网页搜索      low    [开]           │
  │   DOM 提取      medium  [开]          │
  │   执行 JS       high    [开]          │
  │   Memory 写入   critical[开]          │
  └──────────────────────────────────────┘
  [🔧④] [ 输入消息…(玻璃)              ] [发送]  ← 工具按钮(左)·输入·send/stop
```

## 8. 可访问性与边界态

- 玻璃态需保证对比度：气泡用深色半透明底 + `blur`，文字用近白，确保浮于任意背景仍可读（WCAG AA 文字对比 ≥ 4.5:1）。
- 触摸目标 ≥ 44px（工具按钮、开关、发送按钮）。
- 工具面板默认收起（窄面板空间友好），仅按钮角标提示启用数。
- 空状态：无消息时显示 system 提示 + 输入提示，无欢迎气泡亦可。
- 错误态统一：文本气泡 `error`、工具 `error`、System(error) 三者区分；外部编辑器链接**仅**在 System(error) 出现。
- 流式输出时 `input` 禁用或转 stop，避免重复发送打断回合。
- `backdrop-filter` 需带 `-webkit-` 前缀兼容；不支持时降级为普通半透明（仍可用）。

## 9. 与 ARCHITECTURE.md 的关系

- `docs/ARCHITECTURE.md`：核心架构、消息队列主循环、消息类型（user/tool_result/system/control）、工具契约、最小安全姿态。
- 本文档：将上述 loop 与消息类型映射到**界面组件与气泡状态**，是架构在 UI 层的展开。两者共用同一套消息类型与 turn 原子性定义。
