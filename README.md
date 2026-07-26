# MiniAgent

把「大模型自编排 + 轻量工具注册」直接注入任意网页的 userScript（Tampermonkey / Violentmonkey）。

> 纯原生 TypeScript + 手写 DOM，无框架、无内联 CDN、无 Service Worker。运行时仅依赖 `@sec-ant/gm-fetch`。
> 架构：OOP 内核 + `withHooks` 钩子编排；能力 = 注册工具，内核极小。

> 本项目以 **tampermonkey 分支为主分支**（油猴版）。另有 **bookmarklet 分支** 提供「拖书签即用、无需装扩展」的轻量形态（功能相同，但存储按站点分区、无跨站统一）。

## 1. 它能做什么

- **注入任意网页**：安装后在右下角常驻一个 AI 浮窗，随时唤起。
- **大模型自编排**：把 LLM 的推理 + 原生 tool_call 直接变成应用，不套框架。
- **工具即能力**：记忆、抓取、DOM 操作、JS 执行……一切都是「注册一个 tool」，核心代码不动。
- **人工确认闸**：高风险工具（如执行代码）走确定性确认（HITL），由规则判定风险，不交给模型猜。
- **跨站统一存储**：工具开关与配置经 `GM_setValue` 持久化，装一次处处生效。

## 2. 设计哲学

- **组合优先**：整合大模型自身智能，直接产出应用。
- **内核极小**：Agent 只是工具注册器；其余一切都是注册上去的 tool。
- **低耦合 / 可插拔**：新能力 = 注册一个新 tool。
- **不被规范绑架**：不引入 graph DSL、不堆治理栈；唯一强制的是工具契约。

## 3. 技术栈

- 原生 TypeScript + 手写 DOM（无 React / Ant Design / langchain.js）
- `@sec-ant/gm-fetch` —— 把 `GM_xmlhttpRequest` 包成标准 `fetch`（流式），绕 CORS 直连 LLM
- vite-plugin-monkey —— 构建成 `.user.js`；核心运行库（basement）经 `@require` 引入，markdown 渲染用 marked / DOMPurify

## 4. 安装

1. 浏览器装好 **Tampermonkey** 或 **Violentmonkey** 扩展。
2. 打开安装文件 [`dist/miniagent.user.js`](dist/miniagent.user.js)（或项目 Release / jsDelivr 上的 `miniagent.user.js`）。
3. 扩展提示「是否安装」→ 确认。脚本会自动从 jsDelivr 拉取核心并启用更新检查。

> 不想装扩展？可用 **bookmarklet 分支** 的「拖书签即用」形态（功能相同，但存储按站点分区、无跨站统一）。

## 5. 使用

- **唤起**：在任意网页点开右下角浮窗，直接对话。
- **配置**：首次在浮窗内设置 LLM provider 与 API key（存于本机扩展存储）。
- **工具面板**：浮窗内的开关面板可启用 / 关闭工具；关闭仅不加载，配置仍保留。
- **@ 命令**：在输入框用 `@工具名` 触发指定工具（如 `@run_js` 执行一次性 JS）。

## 6. 开发

```bash
npm install
npm run dev       # monkey dev server，改代码自动重装脚本
npm run build     # 产出 dist/miniagent.user.js，导入 Tampermonkey 即用
npm run typecheck # tsc --noEmit
```

```
MiniAgent/
├── package.json / tsconfig.json / vite.config.ts
├── src/
│   ├── core/        # withHooks / llm / executor / storage —— 编排原语与内核
│   ├── ui/          # ui.ts —— 原生 DOM 组件（气泡/输入/确认/工具面板）
│   ├── model/       # config.ts —— 配置（provider/key/riskLevel/disabledTools）
│   └── agent.ts     # 全局单例 + 队列引擎 + init() boot
└── docs/
    ├── ARCHITECTURE.md   # 架构权威说明（注册器、消息队列、工具契约、安全姿态）
    └── ui-design.html    # UI 设计原型
```

## 7. 深入阅读

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 架构权威说明（注册器、消息队列主循环、工具契约、安全姿态）
- [`docs/ui-design.html`](docs/ui-design.html) —— UI 设计原型
