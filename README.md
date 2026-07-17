# MiniAgent

一组基于 **React + langchain.js + Ant Design** 的 userScript（Tampermonkey / Violentmonkey）。

> 彻底无 Service Worker / background / sidepanel——一切成熟库优先复用，userScript 只是 delivery 载体。
> 架构演进：v1 薄中转基座(SW) → v2 砍 sidepanel 改管理页 → v3 砍整个扩展层、纯 userScript → **v4 React + langchain.js + Ant Design，骨架优先、成熟库驱动**。

## 技术栈

- **React 18** + **Ant Design 5**（重库走 `@require` 外链 CDN）—— UI
- **langchain.js**（`@langchain/core` + `@langchain/openai`）—— agent 编排（ReAct / tools / memory）
- **@sec-ant/gm-fetch** —— 把 `GM_xmlhttpRequest` 包成标准 `fetch`（支持流式），绕 CORS 直连 LLM
- **vite-plugin-monkey** —— 把 Vite + React 工程构建成 `.user.js`

## 目录（阶段 0 骨架）

```
MiniAgent/
├── package.json / tsconfig.json / vite.config.ts / .gitignore
├── src/
│   ├── app/        # main.tsx(挂容器+createRoot) + App.tsx(组合 view+core)
│   ├── model/      # 【本期仅类型/接口占位】ModelConfig/Provider/createModel( TODO )
│   ├── api/        # 【本期不实现】provider API 客户端接口占位
│   ├── view/       # Ant Design 封装：ChatPanel / MessageBubble / ToolCard
│   └── core/       # langchain 编排骨架 + useAgent hook（业务动作编排）
└── README.md
```

## 开发

```bash
npm install
npm run dev       # monkey dev server，改代码自动重装脚本
                   # （Tampermonkey 里把 Modify CSP → Remove entirely，否则 dev 注入可能被 CSP 拦截）
npm run build     # 产出 dist/MiniAgent.user.js，导入 Tampermonkey 即用
npm run typecheck # tsc --noEmit
```

## 设计文档（开发期位于 webagentcli/docs/，随项目迁出）

- `../docs/agent-runtime-thin-relay-design.md` —— v4 设计稿（架构 / 选型 / 范围）
- `../docs/miniagent-selection-research.md` —— 各分层选型研究（已核实可行性）

## 状态

阶段 0 骨架：UI 可编译运行、langchain 编排接口占位；`model`/`api` 与截图模块延后（详见设计稿 §3）。
