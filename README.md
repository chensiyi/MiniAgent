# MiniAgent

把「会自己调用工具的 AI 助手」装进任意网页。

MiniAgent 是一个 Tampermonkey / Violentmonkey 用户脚本：安装后，任意网页右下角常驻一个 AI 浮窗。你只用对话，模型自己决定调用哪个工具——查资料、跑代码、记笔记、操作页面——一切能力都是可插拔的「工具」。内核极小，扩展无限。

- 纯前端、无后端：对话与 API Key 只存在你本地，不经过任何中转服务器
- 自带 LLM 直连：支持任意 OpenAI 兼容端点（OpenAI / OpenRouter / DeepSeek / 本地 Ollama…）
- 工具即能力：新功能 = 注册一个 tool，内核代码纹丝不动

---

## 它能帮你做什么

不用切出当前页面，随手就能让 AI 干活：

- 选中一段外文，让它翻译并解释；读完一篇长文，让它总结要点
- 让它在当前页面跑一段 JS，批量改 DOM、抓数据、自动填表
- 把灵感、待办、某个页面的上下文存进跨站笔记，下次换站也能取回
- 把重复操作封装成工具，之后用一句话触发，甚至让模型自己造工具

你只管说人话，模型自己编排该调哪个工具、按什么顺序——不套框架，不写流程。

---

## 核心特性

- **任意网页注入浮窗**：右下角常驻玻璃态面板，流式输出、思考过程可折叠、Markdown 本地渲染。
- **工具即能力**：记忆、存储、界面、钩子……一切都是「注册一个 tool」。预装宇宙随内核演进，完整清单可在浮窗内查看。
- **让模型自己造工具**：内置工具自编排能力，模型可在运行时注册 / 删除 / 列举工具，能力随用随长。
- **人工确认闸（HITL）**：执行代码、删除存储等高风险动作走确定性确认气泡，风险由规则判定，不交给模型猜。
- **跨站统一存储**：工具开关与数据经 `GM_setValue` 落盘，装一次处处生效。
- **界面可关、核心不挂**：关闭浮窗界面后，内核仍以 headless 方式运行，并保留「启用界面」入口，随时可逆。
- **斜杠命令 + 自动补全**：输入框用 `/工具名 /参数 值` 精确触发工具，工具名与参数都有补全提示。

---

## 3 步上手

1. **装扩展**：浏览器装好 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. **装脚本**：见下方「安装」章节（GreasyFork 或 jsDelivr 二选一）。
3. **配 Key 并对话**：首次在浮窗里配置你的 LLM API Key，然后直接对话。

---

## 安装

### 方式一 · GreasyFork（推荐）

前往 GreasyFork 搜索 **MiniAgent** 安装。GreasyFork 负责合规托管与自动更新，是最省心的渠道。
（脚本页直链待发布后补入此处。）

### 方式二 · jsDelivr 直链（备用）

点击即触发扩展安装：[`miniagent.user.js`](https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@tampermonkey0.2.2/dist/miniagent.user.js)

> 该直链指向当前发布的稳定版 tag。若想用最新合规构建，请走 GreasyFork 或仓库 tag。

不想装扩展？见下方「Bookmarklet 变体」。

---

## 关于 API Key（为什么需要自备）

MiniAgent 是**纯前端脚本，没有后端服务器**。它直接用你提供的 API Key 调用大模型，Key 只存在你浏览器扩展的本地存储（`GM_setValue`）里，不经过任何我方服务器。这意味着：

- **隐私可控**：你的对话与 Key 不经第三方中转；
- **额度自选**：用你自己的额度——OpenRouter 的免费模型、DeepSeek、甚至本机跑的 Ollama 都行；
- **端点任选**：支持任意 OpenAI 兼容 API。

你需要准备一个 OpenAI 兼容端点的 API Key（OpenAI / OpenRouter / DeepSeek / 自建…）。

### 配置方式

**方式 A · 浮窗命令（最简单）**

在浮窗输入框执行：

```
/gm_storage set /ns "" /key config /update true /value {"apiKey":"你的Key","baseURL":"https://openrouter.ai/api/v1","model":"openrouter/auto"}
```

**方式 B · 扩展仪表盘**

打开 Tampermonkey 仪表盘 → 找到 MiniAgent → 「数值」→ 编辑 `config` 键，写入同样的 JSON。

未配置 Key 时，浮窗会给出上述提示，不会静默失败。

---

## 日常使用

- **唤起**：在任意网页点开右下角浮窗，直接对话。
- **工具面板**：点浮窗内的 ⚙ 打开工具开关面板，启用 / 关闭工具；关闭仅不加载，配置仍保留。
- **斜杠命令**：用 `/工具名 /参数 值` 精确触发某个工具（如让模型执行一次性 JS），输入时有工具名与参数补全。
- **确认闸**：遇到高风险操作，浮窗会弹出「允许 / 拒绝」，由你拍板。

---

## 工具即能力（可扩展）

MiniAgent 的核心信念：**一切能力都是注册上去的 tool，内核只是工具注册器**。

随脚本预装的环境工具包括：

| 工具 | 作用 |
|---|---|
| `ui` | 浮窗界面（可关闭；关闭后核心仍 headless 运行） |
| `gm_storage` | 跨站持久化存储（记忆 / 配置 / 工具定义 / 代码） |
| `hooks` | 内核钩子（before / after 包裹，扩展点） |
| `tool_manager` | 工具自编排：让模型在运行时注册 / 删除 / 列举工具 |
| `chat` | 大模型交互循环（驱动 LLM、产出文本与 tool_call） |

预装宇宙随 `basement` 内核版本演进，浮窗 ⚙ 面板里的清单永远是最全的真相源。

---

## Bookmarklet 变体（免扩展）

项目另有 **bookmarklet 分支**：把书签拖进书签栏，点一下即在当前页注入 MiniAgent，无需安装扩展。存储按站点分区，无跨站统一。适合不方便装扩展的环境。

---

## 架构速览（开发者）

MiniAgent 分三层，环境无关核心与宿主胶水分层清晰：

| 层 | 形态 | 职责 |
|---|---|---|
| **basement** | IIFE 全局（`MiniAgent`） | 环境无关核心：Agent 注册器、LLM 循环、存储、钩子、工具自编排。经 `@require` 引入 |
| **tampermonkey** | 油猴薄壳（本分支，主分支） | 消费 basement 全局，注入 GM_* 环境层工具（`ui` / `gm_storage`），编排启动 |
| **bookmarklet** | 书签薄壳 | 同上，但走书签注入、存储按站点分区 |

完整架构、设计哲学、工具契约与安全姿态统一在 `basement` 分支维护，本分支不重复：

- [ARCHITECTURE.md](https://github.com/chensiyi/MiniAgent/blob/basement/docs/ARCHITECTURE.md)
- [UI 设计原型](https://github.com/chensiyi/MiniAgent/blob/basement/docs/ui-design.html)

### 技术栈

- 原生 TypeScript + 手写 DOM（无 React / 无框架）
- `@sec-ant/gm-fetch`：把 `GM_xmlhttpRequest` 包成标准 `fetch`（流式），绕 CORS 直连 LLM
- marked + DOMPurify：本地 Markdown 渲染（编译期 `@require` 注入，运行期无下载）
- vite-plugin-monkey：构建成 `.user.js`

### 仓库结构

```
MiniAgent/
├── package.json / tsconfig.json / vite.config.ts
└── src/
    ├── agent.ts          # 启动编排：注入 preset、bootstrap、暴露全局单例
    ├── basement.d.ts     # basement 全局契约声明（@require 引入）
    ├── monkey.d.ts       # 油猴 GM_* 类型声明
    └── tools/
        ├── ui.ts         # 浮窗 UI 工具（气泡 / 输入 / 确认闸 / 工具面板）
        └── gm_storage.ts # 跨站持久化工具（GM_* 透明落盘）
```

> basement 核心源码位于独立的 `basement` 分支，以 IIFE 形式产出 `dist/miniagent-basement.js`，由宿主经 `@require` 引入，本分支不打包任何核心源码。

---

## 开发

```bash
npm install
npm run dev        # monkey dev server，改代码自动重装脚本
npm run build      # 产出压缩版 dist/miniagent.user.js（供 jsDelivr 分发）
npm run build:raw  # 产出非压缩版（供 GreasyFork 发布，符合「可读明文」要求）
npm run typecheck  # tsc --noEmit
```

- `build` 为压缩构建，用于 jsDelivr 自动更新分发；
- `build:raw` 为非压缩构建，用于提交 GreasyFork（平台要求脚本为可读明文，不得混淆）。

---

## 开发计划

MiniAgent 下一步沿「可信 + 生态」两条主线推进——在治理侧补齐风险等级检查、AI 代码审查与更细粒度的权限审核开关，让第三方工具「装得放心」；在生态侧制定工具开发规范并建设工具集市，让工具「写得标准、找得到、装得上」；同时重做浮窗 UI，把上述能力以更直观的方式呈现给用户。

---

## 许可证

Apache-2.0 © 2026 chensiyi
