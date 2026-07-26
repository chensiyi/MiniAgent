# MiniAgent · 书签版（bookmarklet）

把 AI Agent 直接注入任意网页的**小书签**，免安装、拖一下 / 复制一下就能用。

> 本分支（`bookmarklet`）是基于 [basement 引擎](#核心版本) 的**定制产品**形态之一：用跨源 iframe 承载 UI、走固定 CDN 源加载，
> 把「大模型自编排 + 轻量工具注册」注入网页。引擎（basement）的实现不在此重复描述，见下方「核心版本」链接。

## 一键安装（添加书签）

➡️ **[🖥️ 打开安装页，直接把按钮拖到书签栏](https://chensiyi.github.io/MiniAgent/)**

（安装页 `https://chensiyi.github.io/MiniAgent/` 上有一个真实的「拖我到书签栏」按钮，从 github.io 页面拖进书签栏即可生效——这是最省事的方式。GitHub 渲染的 `.md` 会剥掉 `javascript:` 链接，所以这一步必须在安装页 HTML 里完成，不能只在 README 里。)

书签的本质，是把下面这段 `javascript:` 启动器放进书签的**地址栏（位置字段）**：

1. 打开启动器文件，**全选复制其中的 `javascript:` 代码**：

➡️ **[📌 获取 MiniAgent 书签](https://cdn.jsdelivr.net/gh/chensiyi/MiniAgent@bookmarklet0.2.1/dist/bookmarklet.url.txt)**

2. 在浏览器书签栏右键「添加网页 / 添加书签」，名称随意，**把刚才复制的代码粘进「地址 / 位置」那一栏**（它是以 `javascript:` 开头的脚本，不是普通网址）。
3. 以后在任意网页点这个书签，即在右下角拉起浮窗。
- 书签启动器走 jsDelivr CDN（按 `vite.config.ts` 的 `bookmarkletVersion` 常量指向 `@bookmarkletX.Y.Z` tag，immutable 不受分支缓存影响）；GitHub Pages 只托管 `host.html` 浮窗宿主页（域名 `chensiyi.github.io/MiniAgent/host.html`），不托管 `dist/`。本地取用：仓库 `dist/bookmarklet.url.txt`。
- ⚠️ 直接把上面的 https 链接拖到书签栏，只会存成一个「打开该文本文件」的普通书签、不会运行。必须按第 2 步把 `javascript:` 代码粘进书签的地址栏才行。

## 使用

1. 在任意网页点一下书签 → 右下角出现浮窗（固定宽、全高、可滚动）。
2. 顶部「▾」折叠 / 展开面板；「⚙」展开工具开关清单。
3. 输入框输入需求，Enter 发送；高风险工具会弹确认闸。
4. 工具开关即时生效，落盘到当前站点。

## 存储与跨站（重要）

书签版的状态（工具开关、插件）**按网页相互独立**，换站需重新设置。原因：跨源 iframe 的 `localStorage`
受浏览器 **Storage Partitioning** 按 `(嵌入站点, iframe 源)` 分区，这是浏览器隐私设计，本分支有意尊重、不绕过。

详见 [docs/bookmarklet-storage.md §8](docs/bookmarklet-storage.md)。需要「设一次、全站通用」请用下方**油猴版**。

## 核心版本

- **油猴版（Tampermonkey / Violentmonkey）**：功能完整的主版本，配置**跨站统一**（脚本级存储 `GM_setValue`）。
  - 分支：`tampermonkey`（油猴线）— [tree/tampermonkey](https://github.com/chensiyi/MiniAgent/tree/tampermonkey)
  - 用户脚本：`dist/miniagent.user.js` — [raw](https://github.com/chensiyi/MiniAgent/raw/tampermonkey/dist/miniagent.user.js)
- **basement 核心库**：引擎内核（IIFE 全局 `MiniAgent`），书签版与油猴版共用同一套 basement。
  - 分支：`basement` — [tree/basement](https://github.com/chensiyi/MiniAgent/tree/basement)

## 目录（本分支）

```
MiniAgent/ (bookmarklet 分支)
├── src/tools/ui.ts                       # 浮窗 UI（右下角、折叠 / 工具面板）
├── src/tools/bookmarklet_local_storage.ts# iframe localStorage 垫片（GM_* → iframe 存储）
├── bookmarklet/                          # env 垫片 / host.html / bootstrap 装配
├── docs/
│   ├── index.template.html               # 安装页模板（@BOOKMARKLET_CODE@ 占位，由构建注入）
│   ├── index.html                        # 构建生成、GitHub Pages 首页（含可拖拽书签按钮）
│   ├── host.html                         # GitHub Pages 托管的固定 host（iframe 源）
│   └── bookmarklet-storage.md            # 存储设计 + 跨站分区说明（§8）
├── vite.config.ts                        # bookmarklet 专用构建（去 monkey 插件）
└── README.md
```

## 发布（发 tag 须把发布内容打包）

jsDelivr 按 git tag 分发 `dist/` 与 `docs/host.html`，而 `dist/` 被 `.gitignore` 忽略，须强制入库才能进 tag：

> ⚠️ 发版前置：先把 `vite.config.ts` 的 `bookmarkletVersion` 常量 bump 成本次 tag 名（如 `bookmarklet0.2.1`），否则 `host.html` 仍指向旧 tag / 浮动分支。

```bash
npm run build                              # 产出 CDN 版 dist/ + 注入生成 docs/index.html（勿用 test 模式）
git add -f dist docs/host.html docs/index.html docs/index.template.html README.md docs/bookmarklet-storage.md scripts
git commit -m "release: vX.Y.Z"
git tag bookmarkletX.Y.Z
git push origin bookmarklet --tags        # jsDelivr @bookmarkletX.Y.Z 即生效，GitHub Pages 同步首页
```

> ⚠️ 工作区 `npm run test` 产出的 `dist/` 指向 `localhost:5174`，**不可直接发版**——发版前务必先 `npm run build` 覆盖。
