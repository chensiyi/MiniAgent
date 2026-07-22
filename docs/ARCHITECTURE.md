# MiniAgent 架构设计（v4，整合稿）

> 本文档是 MiniAgent 核心架构的权威说明，取代早期随项目迁出、已丢失的设计稿。UI 层见 `docs/ui-design.html`，项目总览见 `README.md`。

## 0. 顶层规范（权威总览，下级章节均服从此节）

> 一切设计、编码、重构都先对齐本节；§13/§14/§17 等是该规范在具体议题上的落地，冲突以本节为准。

1. **范式**：OOP + `withHooks` 钩子工厂；内核极小（Agent=根注册器）；UI 可插拔、核心可 headless 运行。
2. **解耦铁律**：`executor`/`llm`/`storage` **绝不 `import` UI 模块**，也不得硬编码 `agent.ui`；UI 能力只经 `agent.extensions.get('KEY')` 发现。`agent` 作为**装配层**可 `import ui` 以定义 `uiTool` 适配器（§12.6，已在代码中如此实现），但运行时不依赖 UI 形状（经 `extensions` 解耦，headless 无 UI 照常跑）。UI 是工具清单里一个**可逆**的 tool（关闭=禁用 `ui`，有确认、可重开），绝不永久销毁式关闭。
3. **外部库二分加载**（§13）：
   - 核心系统功能库（marked / DOMPurify 等固定基础库）→ 油猴 `@require`，缓存由 Tampermonkey 管理，核心不自己 fetch；
   - 纯 JS 代码工具（工具自带 `code`、`/libs` 安装期内联的库）→ 脚本世界 `new Function` 自包含（**download→replace→install**，见 §13.2），运行期沙箱、离线可用。
4. **`noframes` 保留**：`vite.config.ts` 的 `@noframes` 用于**防止页面内多个 iframe 各自加载一份插件实例**（去重），是有意保留，非"修复 runtime.lastError"。
5. **重大设计先确认再动手**；外部库只用**外国 CDN**（jsDelivr/unpkg/cdnjs）；**不要在项目代码里改 GM grant / 注入策略去"修" Tampermonkey/Chrome MV3 的环境报错**（`Unchecked runtime.lastError: ...` 是官方已知 issue，与本脚本无关）。
6. **顶层禁写死业务装配副作用**（系统提示/工具清单/运行态/权限走钩子）；bootstrap（seed、UI mount）可留顶层。base 只留最小核心流程。
7. **工具面闸门=用户确认**：任何工具（含 sys / 第三方）经用户确认即可替换/删除；`SYS_AUTHOR` 仅作默认值，非编辑限制。

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
| **chat_ui（UI）** | UI 编排层（**可插拔组件**）：工具开关 UI、渲染输入 / 气泡 / send-stop / 流式。**已与核心解耦**——核心只写 `agent.output` 输出槽、经 `agent.extensions` 通用能力表发现 UI 能力，绝不 `import` UI；UI 挂载时注册 `'ui'`(渲染)/`'approval'`(确认闸)。核心可无 UI headless 运行（§11）。 | 否 |
| **tool_manager** | 暴露给 LLM 的统一工具自编排管理 tool（action=register/remove/list）；LLM 经 tool_call 调用它来注册/删除/枚举 tool（包装 `Agent.register`/`unregister`） | 否 |
| **tool** | 注册单元：声明 `name+author` / `deps`，可选 `call` | 否（被注册对象） |
| **code** | 一段代码，作为 "run code" tool 的内容被一次性执行 | — |
| **run code** | 一个 tool（有 `call`），提供一次性代码执行能力 | 否 |
| **tools 命名空间** | 持久化所有 tool 定义的存储命名空间 | — |

### 2.2 关键澄清

- **`chat` 不是注册器**。它是"让大模型通过 tool_call 调用 `tool_manager`"的过程——链路是 `LLM → tool_manager → Agent.register`。
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
   tool_manager   ───────►   Agent (根注册器)
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
                               │                    │       ├─▶ tool_manager (注册/删除/枚举 tool)
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

- **Agent 是唯一注册器**；`chat` / `chat_ui` / `tool_manager` 都不是注册器。
- 注册时 `Agent.register(tool)` 内部调用 `tool.register(this)`，把 **`this`（=Agent 实例）** 作为注册上下文传给工具。
- 工具据此可：注册子工具、enqueue、读取 `this.<name>` 取已挂载工具、访问共享服务。
- `chat_ui` 通过直接调用 `Agent.register/unregister` 管理开关；LLM 通过 `tool_manager`（→ `Agent.register`/`unregister`）自扩展。

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
- `tool_manager` 让 LLM 具备自扩展能力（注册/删除/枚举 tool），是内核极少却可生长的关键支点。

## 11. UI 解耦（核心可无 UI 运行）

UI 不是核心的一部分，而是一个**可插拔组件**（概念上的 tool / adapter）。核心（agent / executor / llm / storage）**不得 `import` UI 模块**，可在无 DOM、无 UI 的 headless 环境下运行——这是架构铁律，任何新能力接入 UI 都不得让核心回退为直连 UI。

### 11.1 三个解耦点

1. **输出槽 `agent.output`（核心契约）**
   - 核心定义 `OutputSink` 接口（`append` / `updateLast` / `finalizeLast` / `setToolHTML` / `setRunning`），并提供 **headless 默认空实现**。
   - 引擎、`sendMessage`、`handleToolCommand` **只写 `agent.output`**，绝不直连 `ui.chat`。
   - UI 挂载时把 `agent.output` 替换为 DOM 实现（`ui.chat`）；卸载即回退 headless 空实现。

2. **通用能力注册表 `agent.extensions`（`Map<string, unknown>`）**
   - 核心不硬引用 UI 的形状。UI 挂载时注册两项能力：
     - `'ui'` → `ui.chat`：UI 渲染能力（`ui.chat.finalizeLast` 直接用 `src/tools/marked.ts` 的 `renderMarkdown` 渲染助手消息 / 思考）；`marked` 已作为**独立工具文件**常驻 `src/tools/`（见 §12.5），**不接管** UI 渲染（无 `setMarkdownRenderer`/`resetMarkdownRenderer`），工具离线 / 卸载不影响默认渲染。
     - `'approval'` → `ui.requestApproval`：人类确认闸（HITL）。
   - 工具 / 核心经 `agent.extensions` **发现**能力，而非 `import` 或硬编码 `agent.ui`。

3. **审批闸 `requestApproval`（executor 核心函数）**
   - `executor.ts` 不再 `import { ui }`；改为导出核心 `requestApproval`（`withHooks`，可被 `orchestrate` 钩子接管），内部经 `ctx.agent.extensions.get('approval')` 委托给 UI；**headless 未挂载则自动放行**并记录。

### 11.2 headless 行为对照

| 能力 | UI 挂载时 | headless（UI 未挂载） |
|---|---|---|
| 输出 | `ui.chat` DOM 渲染 | 空实现（无副作用，引擎照常跑 LLM / 工具） |
| markdown 渲染 | ui 直接用 `renderMarkdown`（默认渲染器） | 同左（marked 工具即便离线也不影响默认渲染） |
| 确认闸 | UI 弹确认气泡 | 自动放行（自动化场景） |

### 11.3 UI 作为 tool（已实现）：关闭界面 = 禁用 ui 工具，经确认闸、可逆

UI 已实现为内置 tool（`name: 'ui'`）：由 `agent.ts` 定义 `uiTool`（含 `register`/`unregister` 钩子）并经 `extraBuiltinTools` 注入枚举；`executor` 不 `import` UI，保持解耦。`uiTool` 不带 `call`，故不进 LLM 工具清单，但 `allToolStates` 会列出它（可在 ⚙ 面板开关）。

> **规划（2026-07-21）**：UI 在概念上即 `chat_ui`（见 §2.1/§2.2），计划正式命名为系统 tool `chat_ui`（当前代码名仍为 `ui`，仅改名、职责不变），作为独立、可逆的系统级 tool 常驻。今晚仅更新本文档记录该规划，**不改动代码**（代码重构另行排期）。

- **注册即挂载**：`uiTool.register` 设 `agent.output = ui.chat`、向 `agent.extensions` 注册 `'ui'`/`'approval'`、挂载 DOM；`agent.init()` 启动期把 `uiTool` 加入 `bootList` 默认注册。
- **关闭界面 = 禁用 ui 工具**：⚙ 清单取消勾选 → `executor.setEnabled('ui', false)` → 因 `name==='ui'` 且为禁用，**必经 `requestApproval` 确认闸**（UI 弹确认；headless 自动放行）。用户拒绝则什么都不做（面板 `onchange` 把复选框还原为实际状态），确认才 `unregister`：卸载 DOM + 还原 headless（`output` 回空实现、清空 `extensions` 的 `ui`/`approval`）。禁用状态写入 `config.disabledTools` 黑名单持久化，重载后 `init` 自动剔除、保持关闭。
- **可逆、不永久销毁**：UI 卸载后核心照常 headless 运行。`agent.ts` 建了一个**持久化最小启动器** `#miniagent-launcher`（独立于已卸载的 UI，始终存在），点击即 `executor.setEnabled('ui', true)` 重新挂载（**无需确认、安全**）。这是"关闭后可重新启用"的 humane 入口。
- **禁止 `agent.ui` 硬引用**：`ui` 已加入 `executor` 的 `RESERVED`，工具注册不会把 `ui` 挂成 `agent.ui` 属性；UI 能力只经 `agent.extensions` 发现。

> 设计铁律：UI 是工具清单里一个**可逆**的 tool，关闭只是禁用它（有确认、可重开），**绝不**做"一次性 `root.remove()` 后无重开入口"的永久销毁式关闭——否则不人道。

---

## 12. 模块契约与职责（实现级）

> 本节是 §1–§11 设计哲学在源码层的落地契约，逐项对应 `src/` 各模块。架构决策与用户偏好见 §15，已知技术债见 §16。

### 12.1 withHooks 钩子工厂（`src/core/withHooks.ts`）
- `withHooks(fn, thisArg?)` 把**普通函数**包成"可 hook 的普通函数"：外在签名不变，调用方仍 `fn(...args)` 正常调（无 `.call()`、非 class 实例）。`thisArg` 透传给 `fn.apply(thisArg, ...)`，使被包函数体内 `this` 指向传入的局部上下文（各模块在包时传入自身：`llm`/`executor`/`agent`/`ui`），调用方可经 `this` 快速访问该上下文并进行相关操作。
- 插槽：`beforeExe` / `afterExe` 为**数组**（编排方 `push`/`insert`/`splice` 精准控序）；单值赋值自动包成数组。`aroundExe`/`onError` 单插槽已弃用（简化版无）。
- 钩子为 **leaf HookedFunction**（自身不再展开 before/after，避免嵌套）。
- 钩子上下文 `opts = { args, result }`：before 改 `opts.args`、after 读 `opts.result`。**只读 `opts.args`**，无 `meta`/`context`/`around`/`catch`/`skip`/`replace` 等逃逸口（用户选定"基础函数内处理"，withHooks 保持骨感）。
- 返回值**严格跟随 base**：async→Promise、sync→原值、生成器直接返回生成器（仅 before 钩子生效）。
- "替换过程"= 编排阶段把基础函数用 `withHooks` 重新包一层并赋值（组合级替换，如 `agent.sendMessage = withHooks(base)`），而非 per-call skip。base 只留最小核心流程，插入/替换全交钩子。
- 所有"过程"方法（`sendMessage` / `llm.chat` / `llm.streamChat` / `executor.run`）都用 withHooks 包裹，全系统统一可 hook。

### 12.2 llm 模块（`src/core/llm.ts`）
- 无状态对象，只持 `config` 属性 + 标准方法 `chat` / `streamChat`，均为 HookedFunction 实例；历史在 `agent.messages`，llm 不持有。
- 接口（2026-07-21 重构）：`streamChat(body: ChatRequestBody)` / `chat(body)` 直接接收**完整请求体**；`ChatRequestBody = { messages, stream?, tools?: ApiTool[], tool_choice?, model?, [k]: any }`；`ApiTool = { type:'function', function:{ name, description, inputSchema } }`。
- 内部只从 `getConfig()` 取 `apiKey`/`baseURL`（传输层）；`body.messages` 保底空数组、`body.stream` 锁 `true`（SSE 要求）；**不再**内部拼 model/温度/合并 baseRequestBody（构建移到调用方 `agent.engine`）。
- SSE 解析：按 `\n` 切物理行；`reasoning_content`/`reasoning` 增量累积 `reasoningContent` 并 yield `{ reasoning }`；`tool_calls` 按 `index` 累积（缺 index 时分配到下一空槽 `Object.keys(acc).length`，防多工具合并）；`usage`/`model`/`finish_reason` 末尾捕获。
- 首类 `cancel()`：`llm._abort = new AbortController()`，signal 透传 gmFetch；`llm.cancel()` abort 在途。流式 `return` 完整 `ChatResult`（含 `toolCalls/reasoningContent/finishReason/usage/model`）——调用方以 `streamChat` 迭代器 `r.value`（done 时）为权威结果，勿在调用方另起并行累加器（曾因双累加器漂移修复：agent.ts 改手动迭代器消费 return 值）。
- 参数补齐：`temperature`/`max_tokens`/`reasoning_effort` 仅当调用方显式给才下发；响应补齐 `reasoningContent/finishReason/usage/model`。

### 12.3 executor 模块（`src/core/executor.ts`）
- `ToolDef = { name, author?, description, inputSchema, deps?, riskLevel?, call?, register?, unregister? }`；`DepRef = { name, author?, version? }`；**唯一标识 = `name+author`**。
- `register`/`unregister` 触发 `tool.register`/`tool.unregister`（同名先 unregister 再 register）；`registerAll` 先拓扑排序再注册（循环依赖→整体拒绝）；单 `register` 校验依赖（缺失→拒绝，author 不符→警告）。
- 注册挂 `agent[name]` + `agent.tools`（Map）；`list(includeAll)` 默认返回有 `call` 的（进 LLM 清单），`list(true)` 全量；枚举/存储键/面板输出按**名称字母序**（确定性一致）。
- `run` 注入 `RunCtx = { storage, executor, agent, this, console }`；确认闸 `riskAtLeast(tool.riskLevel, APPROVAL_RISK_LEVEL)`。
- **运行时代码编译（沙箱）集中化（2026-07-21）**：所有 `new Function` 动态编译（工具 `code`/`register`/`unregister` 重建、`code_run` 自我执行、`orchestrate` 用户钩子）统一走 executor 顶层 `createSandboxFn`（`compileFn` 编译函数表达式、`compileBody` 编译函数体），禁止在调用链路散落裸 `new Function`；统一强制 `"use strict"` 且仅注入显式形参（ctx/opts/agent…），沙箱边界只在一处定义，便于审计加固。
- `requestApproval`（executor 导出核心函数，withHooks）：内部经 `ctx.agent.extensions.get('approval')` 委托 UI；headless 未挂载→**自动放行**并记录。所有原 `ui.requestApproval(...)` 调用改为 `requestApproval(..., ctx.agent)`。
- `SYS_AUTHOR = 'sys'`（默认 author）；`executor` 导出 `extraBuiltinTools`（UI 注入枚举用，不 import UI）。
- **默认工具（6 个）**：
  - `gm_storage`（`action` get/set/list/del；`del`=high 确认闸；`set` 支持 `/update true` 合并写）
  - `code_run`（high 确认闸；经顶层沙箱 `compileBody(['ctx'], code)` 执行，return 值回显）
  - `tool_manager`（`action` register/remove/list/export/export_cmd/list_disabled/delete；`register` 默认停用 `enabled=true` 才立即注册；`/libs` 参数=安装期从 CDN fetch 库源码内联进 code 见 §13；`export`=raw 自注册 IIFE、`export_cmd`=手动安装命令、`list_disabled`=列启用=false 的自编排工具；`delete`=经确认闸删除，`remove` 为其别名）
  - `orchestrate`（5 action：view/update/setRequestBody/addHook/removeHook；后四 high；view 返回系统提示+7 钩子目标运行期数组+工具清单+引擎；addHook/removeHook 热插拔用户钩子存 `hooks:<id>`，`rehydrateHooks` 重建）
  - `session`（无 codeGenTool；**惰性创建**：register 仅装钩子、首条真实对话才建 `session:<id>`+扁平 `sessions` 索引；`action` info/save/list/create/switch/remove；会话 id 状态与 `flushSession` 落盘逻辑现定义于本工具文件 `src/tools/session.ts`，executor 核心不再持有）
  - `marked`（独立工具文件 `src/tools/marked.ts`，特殊例外见 §12.5；`call(text)` 把 markdown 渲染为 HTML，纯渲染、无副作用；ui 默认渲染器 `renderMarkdown` 亦出自此文件）
- **引擎动态请求体（设计铁律）**：`baseRequestBody`（`config.ts` `getBaseRequestBody/setBaseRequestBody`，存扁平键 `baseRequestBody`）每轮合并进 streamChat 请求体（model 可被子覆盖，messages/stream 运行期填充；显式 `opts.temperature/maxTokens/reasoningEffort` 优先）；`orchestrate.view` 的 `engine = { endpoint:{model,baseURL}(来自扁平 config 键) + baseRequestBody }`，`setRequestBody` 热更新模板（无需重载）。**`config`=连哪个（baseURL/apiKey/model 端点），`baseRequestBody`=怎么问（温度/推理强度/厂商扩展/可覆盖 model），二者分离且引擎参数必须可经编排动态查看与编辑。**
- 工具 `/libs` 自包含机制：`resolveLibUrls(spec)`（完整 URL 原样；别名 `marked`/`dompurify`→jsDelivr；默认 spec→`https://cdn.jsdelivr.net/npm/<spec>`）返回 `{jsdelivr,unpkg,cdnjs}` 三源数组；安装期 `fetchLibText`（fetch 优先→`GM_xmlhttpRequest` 兜底）逐库取源码，任一失败→中断安装；内联成 IIFE `(function(){ <libs> \n return (<userCode>); })()` 存 `desc.code`，`new Function('"use strict"; return (' + code + ');')` 编译——工具自此自包含离线可用（"用内容替换自己"）。

### 12.4 storage 模块（`src/core/storage.ts`）
- 命名空间 API：`get/set/del/keys(ns, key?)`；`realKey`：空 ns → 扁平键（如 `config` / `baseRequestBody` / `sessions`），非空 → `ns:key`（如 `session:<id>` / `tools:name`）。
- 分区：扁平键 `config` / `baseRequestBody` / `sessions`（无 ns，用户在 Tampermonkey 数值里可直接编辑）/ 命名空间 `session` / `tools` / `code` / `memory`。
- `listToolDefs()` 读 `tools` 全量（系统真相源）；`get` 真泛型。
- `set` 保留 `withHooks(...)` 包装作扩展点（曾经 `bus.emit` 广播，bus 已删，不再挂钩子）。

### 12.5 ui 模块（`src/ui/ui.ts`）+ marked 渲染（独立工具文件 `src/tools/marked.ts`）
- v4 玻璃**方框**无圆角浅色字（不挂背景板/标题栏；`--glass:rgba(18,26,44,.52)`、`--text:#eef2ff`、品牌 `#378DDD`、风险 high 橙 `#fb923c`）；气泡区 `mask-image` 顶部渐隐。
- **可插拔组件（概念上的 tool/adapter），核心绝不 import UI**（`agent` 装配层除外，见 §0.2）。方法（`ui.chat` / `ui.panel` / `ui.tools` / `ui.requestApproval`）：
  - `ui.chat`: `mount/append/updateLast/setToolHTML/finalizeLast/setRunning/send/setInput/refreshAutocomplete/acceptAutocomplete`
  - `ui.panel`: `toggle/setCollapsed/isCollapsed`
  - `ui.tools`: `toggle/open/close/refresh`（⚙ 面板 `allToolStates` + `setEnabled`）
  - `ui.requestApproval`: withHooks 确认闸
  - `mount()` 时把 `ui.chat` 设给 `agent.output`、向 `agent.extensions` 注册 `'ui'`(渲染)/`'approval'`(确认闸)。
- Trusted Types 兼容：所有 `innerHTML` 赋值必须走 `setHTML(el, html)`（建一次性 `createPolicy('miniagent', {createHTML:(s)=>s})`），勿裸赋。
- **markdown 渲染（特殊例外，2026-07-21）**：`src/tools/marked.ts` 是**独立工具文件**，不跟随 `chat_ui`（UI 解耦），理由有二：① 其源码经油猴 `@require` 注入、运行时作为隔离世界全局消费；② markdown 是 LLM 界长期基本格式，应作为基础能力常驻。它有两个出口：`renderMarkdown(src)`（ui 默认渲染器 `finalizeLast` 直接 import 使用）与 `markedTool`（注册为系统工具 `name:'marked'`，可被 LLM / 用户命令 `/marked` 调用把 markdown 渲染为 HTML）。**`marked` 不接管 UI 渲染**（无 `setMarkdownRenderer`/`resetMarkdownRenderer`），ui 始终直接用 `renderMarkdown`，工具离线 / 卸载不影响默认渲染。渲染库（marked+DOMPurify）加载见 §13.1，运行期无下载。

### 12.6 agent 模块（`src/agent.ts`）
- 全局单例 `globalThis.agent`；**解耦铁律**：引擎/`sendMessage`/`handleToolCommand` 只写 `agent.output`（OutputSink 契约，默认 headless 空实现），绝不直连 ui；核心经 `agent.extensions`（Map 通用能力表）发现 UI 能力，不硬引用 `agent.ui`。
- 队列引擎（engine）：两队列 `messageQueue`/`toolCallQueue` + SENTINEL 驱动；`running = messageQueue.length || toolCallQueue.length`（peek 不弹，在途期间队列非空，派生正确）。
- `init()`：`migrateFlatToNs` → `getConfig`（含 `disabledTools` 黑名单）→ `executor.attachAgent` → `registerAll(bootList 剔除黑名单)` → `rehydrateTools` → `rehydrateHooks`。
- `orchestrateSystemPrompt` 走 `sendMessage.beforeExe` 幂等钩子；运行态按钮 `sendMessage.beforeExe setRunning(true)` + engine.finally `setRunning(false)`。
- `mount()` = 唯一 UI 接入点（设 output + 注册 extensions）；仅 dev 分支挂 `unsafeWindow.agent`（`__BUILD_BRANCH__==='dev'` 守卫），发布分支不挂。
- `uiTool`（定义于此）：`register` 挂载 DOM+接 output/extensions、`unregister` 卸载+还原 headless，经 `extraBuiltinTools` 注入枚举；持久化最小启动器 `#miniagent-launcher`（UI 卸载后重开入口，独立于已卸载 UI）。
- `parseToolCommand()` / `handleToolCommand()`：解析 `/tool /param value /flag` 语法，绕过 LLM 直接调 `executor.run`（`/` 开头→工具命令；apiKey 空→提示配置；否则正常 sendMessage）。

### 12.7 config 模块（`src/model/config.ts`）
- `AppConfig`（含 `disabledTools?: string[]` 黑名单、`apiKey`/`baseURL`/`model`）；`getConfig/saveConfig`。
- `SYS_AUTHOR`、`RiskLevel` + `APPROVAL_RISK_LEVEL='high'` + `riskAtLeast()`。
- `getBaseRequestBody/setBaseRequestBody`、`getSystemPrompt`（读扁平 `config.systemPrompt`，单一真相源）。`orchestrate.update` 经 `saveConfig({ systemPrompt })` 写入同一 blob；首次运行由 `init()` 用源码种子 `SYSTEM_PROMPT` 写入 config，**运行期不再回退源码常量**（消除"源码 + config"双源定义分歧）。
- `SYSTEM_PROMPT`：工具说明同步（gm_storage/tool_manager/orchestrate/session/code_run）；明确"code_run 由系统自动弹确认框，你无需文字确认，直接调用"（避免双重确认）。

## 13. 外部库加载策略（最终方案）

**分层二分**：按"库是核心系统功能还是工具自带代码"选择加载通道，二者不混用。

### 13.1 核心系统功能 → 油猴 `@require`（油猴管缓存）
- **适用对象**：`marked` / `DOMPurify` 等**系统级渲染/基础库**（固定、编译期可知、被核心代码直接 import）。
- **加载方式**：在 `vite-plugin-monkey` 的 `userscript` 配置里声明 `@require`，URL 走官方 CDN（见 §13.4）。油猴首次下载后随脚本缓存，脚本版本递增时自动随更新重新拉取——**缓存完全由 Tampermonkey 管理，核心代码不自己 fetch、不自己维护缓存**。
- **引用**：脚本世界内直接引用库暴露的全局名（`marked` / `DOMPurify`），由 `@require` 编译期注入 userscript 全局作用域，运行期直接消费，无运行时下载。
- **落地**：`vite.config.ts` 的 `userscript.require` 数组增条目；核心模块（如 `tools/marked.ts` 的 markdown 渲染接管）改为消费 `@require` 注入的全局，移除运行时下载分支。

### 13.2 纯 JS 代码工具 → `new Function` 自包含（运行时沙箱）

- **适用对象**：工具**自带的可执行 `code`**（含 `/libs` 安装期从 CDN fetch 并内联进 code 的库、agent 生成的临时脚本）。这类代码运行期才确定，不适合写死进 `@require`，故走运行时自包含。

- **通用管线（设计思路）：download → replace → install**
  1. **download（下载）**：安装期 `fetchLibText` 经外国 CDN 链（jsDelivr→unpkg→cdnjs，fetch 优先、GM_xmlhttpRequest 兜底）逐库拉取源码；任一库失败即中断安装。
  2. **replace（替换，按需、非必做）**：若库源码引用 `window`/`self`（典型 UMD 包），将其 `replace(/\bwindow\b/g, 'globalThis')` 换成脚本世界 globalThis，使其在隔离世界可解析。**大部分纯 JS 库不引用 `window`，故这步常省略**——不要为不需要的库硬做替换。
  3. **install（安装）**：把库源码包进 IIFE `(function(){ <libs> \n return (<userCode>); })()` 内联进工具 `code`，经 `new Function('"use strict"; return (' + code + ');')` 编译；工具自此**自包含、离线可用**（"用内容替换自己"）。

- **当前落地**：`executor.ts` 的 `tool_manager` `/libs` 已做 download + install；replace 为可选（实测多数库不需要，故默认不做 window 替换，仅在确需时补）。`compileFn`（`call`/`register`/`unregister` 共用）与 `exportToolToJs` 的 `buildFn` 用同一 `new Function` 编译表达式，导出片段同样自包含、可独立重注册。

- **优势**：轻量、无持久化、不污染页面 main world、不增存储；工具完全自包含、离线可用。

### 13.3 下载与通道约束
- **下载（仅 13.2 纯 JS 工具用）**：复用 executor 的 `fetchLibText`（`fetch` 优先 → `GM_xmlhttpRequest` 兜底；jsDelivr 带 `ACAO:*` 跨域 GET 不受 @connect 限制，比 GM_xmlhttpRequest 稳）。
- **`vite.config.ts` grant 不含 `GM_addElement`**：`<script src>` 注入把库挂到页面 main world，与脚本隔离世界 globalThis 不互通，已废弃。

### 13.4 CDN 链（全外国，移除国内镜像）
- `jsDelivr → unpkg → cdnjs` 依次兜底，任一成功即返回，全失败才 reject。核心 `@require` 与纯 JS 工具 `/libs` 安装链共用此链。
- **版本同步维护点**：核心 `@require`（`vite.config.ts` 的 `userscript.require` 数组，如 `marked@12`/`dompurify@3`）与纯 JS 工具安装期 `executor.ts` 的 `KNOWN_LIBS`（同版本号）是**两处手写、用途不同、不合并**——前者给编译期核心库、后者给工具安装期 `/libs`；升版本需手动同步两处，避免漂移。
- ⚠️ 历史误判已作废："new Function 不能加载 UMD 库" 是误判（根因是跨世界边界，非 new Function 本身）；纯 JS 工具通道用脚本世界 new Function（replace 按需，见 §13.2）。核心系统库则整体迁到 `@require`，不再走运行时下载。

## 14. 构建与发布

- `vite.config.ts`：纯原生 TS + `vite-plugin-monkey`；`__BUILD_BRANCH__` 守卫 `unsafeWindow` grant（dev 含、发布分支无）；`@version` 用 package.json base + 秒级时间戳 `YYYYMMDDHHmmss`（Tampermonkey 按 `.` 分段比较，每次 build 必递增）；`updateURL`/`downloadURL` 固定 `http://localhost:4173/miniagent.user.js`（无 git 分支魔法）。
- `package.json` scripts：`dev` / `build` / `typecheck` / `test`（`= vite build && vite preview`，preview `port:4173, host:true`）。油猴点"检查更新"从 localhost 拉，version 递增即更新。
- **`@noframes` 保留（iframe 去重）**：`userscript.noframes` 用于**防止页面内多个 iframe 各自加载一份插件实例**（避免重复实例化与互相干扰），是有意保留项，并非用于"修复" `runtime.lastError`。
- **已撤销**：为"修" Tampermonkey/Chrome MV3 `runtime.lastError` 环境报错而加的 `stripXmlHttpGrant()` / `GM_addValueChangeListener` 跨标签推送——均证伪（与本脚本无关，见 §17），已还原。

## 15. 设计铁律与用户偏好（务必遵守，避免重蹈覆辙）

1. **保持 OOP 范式**，不重写成 React/langchain/antd（曾从 2.29MB 框架版砍成 9KB 原生 TS，不再回退）。
2. **核心绝不 import UI 模块**，也不得硬编码 `agent.ui`；UI 能力只经 `agent.extensions.get('KEY')` 发现。核心可无 UI headless 运行。
3. **UI 是工具清单里一个可逆的 tool**；关闭=在 ⚙ 清单禁用 `ui`（必经确认闸），**绝不**做"一次性 `root.remove()` 后无重开入口"的永久销毁式关闭（不人道）。
4. **重大设计先确认再动手**：用户只说"关闭 UI 是风险操作要确认"时，勿自作主张实现成永久销毁、且未确认就提交。先对齐"关闭形态"再写码。
5. **外部库用外国 CDN**（jsDelivr/unpkg/cdnjs），不引入国内镜像。
6. **不要在项目代码里反复改 GM grant / 注入策略去"修" Tampermonkey/Chrome MV3 的环境报错**（`Unchecked runtime.lastError: ... Receiving end does not exist.` 是官方已知 issue #1083，与本脚本逻辑无关）。真要修的是独立的"部分页面工具（⚙ 面板）不显示"现象。
7. 顶层禁写死业务装配副作用（系统提示/工具清单/运行态/权限走 `sendMessage.beforeExe` 等钩子）；bootstrap（seed、UI mount）可留顶层。base 只留最小核心流程。
8. 工具面闸门=用户确认（任何工具含 sys/第三方经确认可替换/删除）；`SYS_AUTHOR` 仅作默认值，非编辑限制。systool 替换：同名先 unregister 再 register；`rehydrateTools` 持久化覆盖硬编码。

## 16. 已知技术债与阶段3待办

- **已修复**（2026-07-21）：流式工具调用 3 脆弱点——①双累加器冗余（agent.ts 改手动迭代器消费 `streamChat` return 值）；②缺 `index` 多工具合并（`tc.index ?? Object.keys(acc).length`）；③推理未写回历史（`ChatMessage` 加 `reasoning_content`，推送 assistant 带 `reasoning_content`）。
- **待办（阶段3 可选）**：① `max-iter` 工具循环防护（用户定"暂不加"）；② `inputSchema` 参数校验（文档 §9 三护栏之一，run() 未校验）；③ 安装期 AI 审查代码分支（§6）；④ 上下文/权限管理（CallCtx 仅 TODO 占位，不进运行时）；⑤ system/control 消息类型与 turn 原子性（§4 队列已实现，消息类型枚举未全做）。
- 取消/停止：`cancel()` 仅中断 LLM 流，code_run 确认等待期间点"停止"无效（已知小问题，未处理）。

## 17. 关键纠错与教训（历史记录，避免重复踩坑）

- **"✕ 永久销毁关闭 UI"被推翻**：曾实现 UI 右上角 ✕ 确认后 `root.remove()` 卸载无重开入口，违背"UI 是可逆 tool"意图 → `git revert` 后改为 UI-as-tool（§11.3 / §15.3）。
- **"new Function 不能加载 UMD 库"为误判**：根因是脚本隔离世界 globalThis 与页面 main world 不互通（跨世界边界），非 new Function 不行；最终脚本世界 new Function（replace 按需，见 §13.2）。
- **"runtime.lastError 是脚本导致"证伪**：用户明确非本脚本导致（Tampermonkey/Chrome MV3 环境问题）。`stripXmlHttpGrant` / 跨标签总线（`GM_addValueChangeListener` 推送）等推测性"修复"已撤销还原。**`@noframes` 不在撤销之列**——它本就不是为修该报错而生，而是 iframe 去重（防页面内多 iframe 各加载一份插件），有意保留（见 §0.4 / §14）。
- **"sys 作者守卫"反转**：曾限制仅 `sys` 作者工具可经 tool_manager 编辑/删除；用户要求"所有工具均可经用户确认后更新" → 闸门从 author 改为用户确认（§15.8）。
- **依赖与工具契约/注册流/三视图/确认机制缠死**：改依赖管理不止 2 文件，需全量对齐（保持 OOP）。
