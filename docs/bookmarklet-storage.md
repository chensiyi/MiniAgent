# 书签分支存储设计（bookmarklet-storage）

> 本文档固化书签分支（bookmarklet）的存储实现，重点说明「以特殊方式加载插件」所依赖的存储后端、插件持久化 schema 与启动期加载路径。
> 配套架构见 `docs/ARCHITECTURE.md`；书签分支专属装配见 `bookmarklet/bootstrap.ts`、`bookmarklet/env.ts`、`bookmarklet/host.html`。

## 0. 一句话结论

书签分支的存储后端 = **iframe 固定 host 的 `localStorage`**（由 `bookmarklet/env.ts` 把 `GM_*` 垫片到它）；插件以源码字符串形式存进 `tools:<name>` 命名空间，落盘完全由 `gm_storage` 工具透明完成；启动期由 basement 的 `rehydrate` 读回、用 `createSandboxFn` 把源码字符串编译成函数并注册。整条链路在现有 `gm_storage` + basement `rehydrate` 上**直接继承**，书签分支无需自造存储层。

## 1. 存储后端机制（已实现，不改动）

### 1.1 iframe 固定 host

- `vite.config.ts` 构建时把 `host.html` 部署到 GitHub Pages（`https://chensiyi.github.io/MiniAgent/host.html`），这是**固定 URL**。
- 书签的 `javascript:` 加载器（`dist/bookmarklet.url.txt`）向页面注入一个 `<iframe src=该 host.html>`。
- 由于 `host.html` 内 `<script src="…jsdelivr…/bookmarklet.js">` 在其自身文档上下文执行，**脚本运行时的 `location.origin` = `https://chensiyi.github.io`**，与用户当前浏览的站点无关。
- ⚠️ **但跨源 iframe 的 `localStorage` 受浏览器 Storage Partitioning 约束**：现代浏览器（Chrome/Edge/Firefox/Safari）默认按 `(嵌入站点 embedder, iframe 源)` 二元组对 iframe 存储**分区**。iframe 源虽固定为 `github.io`，但「在 a.com 打开」与「在 b.com 打开」属于不同嵌入站点 → 落到**不同存储分区**。因此书签分支的状态（工具开关、插件）**按网页相互独立，并不跨站共享**。这是浏览器隐私设计，本分支**有意尊重、不绕过**（详见 §8）。

### 1.2 `GM_*` 垫片 → iframe localStorage

`bookmarklet/env.ts` 把油猴虚拟模块 `$` 映射为本分支垫片，用 iframe 自身 `localStorage` 实现 `GM_*`：

```ts
const NS = 'miniagent:';
export function GM_setValue(key, value) { localStorage.setItem(NS + key, JSON.stringify(value)); }
export function GM_getValue(key, def)  { /* 解析 JSON，空返回 def */ }
export function GM_deleteValue(key)    { localStorage.removeItem(NS + key); }
export function GM_listValues()        { /* 遍历 localStorage，回收集 NS 前缀的键 */ }
```

### 1.3 `gm_storage` 落盘钩子（零改动复用）

`src/tools/gm_storage.ts` 是 dev / bookmarklet 共用工具，其 `register` 在启动期做两件事：

1. **镜像**：`for (const k of GM_listValues()) agent.storage.set('', k, JSON.parse(raw))`——把 localStorage 一次性读入内核内存 `Map`（幂等，`mirrored` 标志守护）。
2. **落盘钩子**：`hooks.installHook('storageSet'/'storageDelete', 'before', …)` 包裹 `agent.storage.set/del`，使其透明写回 `GM_*`。

其它工具只管读写 `agent.storage`，完全不感知运行环境。书签分支因 `$` 已别名到 `env.ts`，**该工具逐字复用**。

## 2. 插件持久化 schema

插件（用户/LLM 运行期经 `tool_manager` 创建的 tool）以如下结构存于 `tools:` 命名空间（与 GM 分支一致，复用 `storage.listToolDefs()` 作为真相源）：

```ts
type StoredPlugin = {
  name: string;
  author: string;                       // 组合唯一标识 = name + author
  description?: string;
  parameters?: Record<string, unknown>; // 发给模型的 JSON Schema
  deps?: { name: string; author?: string }[];
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  // 函数以源码字符串保存（不可 JSON 序列化函数，故存文本、加载时编译）
  call?: string;          // ToolDef.call 的源码字符串
  register?: string | null;
  unregister?: string | null;
  enabled: boolean;       // 关闭=不进 boot 注册集（对齐 config.disabledTools 语义）
  version?: string;
  updatedAt: number;
};
```

- **存键**：`tools:<name>`（`resolveSet` 把 `ns:key` 统一成 `tools:<name>`，与 `gm_storage` 落盘键完全一致）。
- **写入方**：`tool_manager` 的 `register` action（basement 内）在用户/LLM 安装插件时生成该记录并 `storage.set('tools', name, def)`；落盘经 §1.3 钩子写入 iframe localStorage。
- **启用态**：以记录内 `enabled` 字段为准；关闭的插件定义**保留在 `tools:`**（不清存储），仅不进入启动注册集。

## 3. 特殊加载路径（启动期 rehydrate）

「特殊方式加载插件」= 无安装期 `@require`，插件在运行期从存储读取源码字符串、编译、注册。该路径由 basement 的 `toolManager.bootstrap()` 内含的 `rehydrate()` 完成：

```
toolManager.bootstrap()
  ├─ registerAll(baseTools)        // gm_storage 先 register → 镜像 localStorage→内存 Map
  ├─ 读 config.disabledTools       // 须在镜像后读（见 ARCHITECTURE §5 / 记忆坑位）
  ├─ 过滤注册 allTools             // 按 disabledTools 黑名单
  └─ rehydrate()                   // 读 storage.listToolDefs()
        └─ 对每个 enabled 记录：
              call/register/unregister 源码字符串
                ──createSandboxFn──▶ 真实函数
                ──agent.register(toolDef)──▶ 挂载到 Agent、进 LLM tool_call 清单
```

- **编译收口**：所有 `new Function` 集中在 basement 顶层 `createSandboxFn`（`compileFn`/`compileBody`），强制 `"use strict"`、仅注入显式形参（`ctx`/`opts`/`agent`…），符合 `ARCHITECTURE §12.3` 安全铁律。书签分支不另起散落的 `new Function`。
- **幂等**：`rehydrate` 重注册前同名先 `unregister`，可安全重复调用。
- **隔离**：代码跑在 iframe 自有 JS 上下文；沙箱边界只在 `createSandboxFn` 一处定义，便于审计。

`bookmarklet/bootstrap.ts` 当前调用顺序：

```ts
toolManager.definePreset([gmStorageTool, hooksTool!], [gmStorageTool, ...defaultTools, uiTool]);
await toolManager.bootstrap(); // 内含镜像 + rehydrate，插件随之加载
```

即插件加载已自动发生，无需书签分支额外代码。

## 4. 启动期数据流

```
[书签 javascript:] ──▶ 注入 <iframe src=host.html>
        │
        ▼
host.html（固定 host）
  ├─ <script> basement.js（@basement 全局）
  ├─ <script> marked / DOMPurify（@require 全局）
  └─ <script> bookmarklet.js
        │
        ▼
bootstrap.ts main()
  ├─ definePreset(...)
  ├─ toolManager.bootstrap()
  │     ├─ gm_storage.register → GM_listValues() 读 iframe localStorage
  │     │                         → 镜像进 agent.storage（内存 Map）
  │     └─ rehydrate() → listToolDefs() → 编译+注册 enabled 插件
  └─ 验证：GM_setValue/GetValue 在固定 iframe 源内读写（注意跨站分区，见 §8）
```

## 5. 约束与取舍（本次设计拍板）

| 项 | 决定 | 理由 |
|---|---|---|
| 存储后端 | iframe 固定 host 的 `localStorage`（~5MB，同步） | 已实现于 `env.ts`；**按网页分区独立、不跨站共享**（Storage Partitioning，见 §8） |
| 是否引入 IndexedDB | **否** | 不过度设计；5MB 够用，后续不够再扩 |
| 插件目录 / 市场 | **不做** | 复用 `tool_manager` 最小闭环：用户/LLM 创建 → 存 `tools:` → boot rehydrate |
| 插件源码来源 | 仅内联存 `tools:`（无 `sourceUrl` 运行期拉取） | 无网络依赖、最简；与 GM 分支路径完全一致 |
| 新存储层代码 | **无** | `gm_storage` + basement `rehydrate` 已覆盖，不发散 |

## 6. 风险与边界

- **配额**：localStorage 约 5MB。带内联库的插件（§13.2 `/libs`）可能偏大；若触顶，`GM_setValue` 抛错 → before 钩子抛错 → `storage.set` 被跳过（不写内存），需在 UI/安装流程提示。监测到体积增长再考虑 IndexedDB。
- **清端丢失**：用户清除 `github.io` 站点的 localStorage 会丢失全部插件/配置。备份靠 `tool_manager` 的 `export`（raw 自注册 IIFE）导出；建议文档化「导出即备份」。
- **安全**：`new Function` 编译用户/LLM 插件源码，所有编译收口 `createSandboxFn`；安装期建议保留 AI 审查代码分支（§6）或用户确认闸（install 走确认），避免来源不明代码直跑。
- **跨源隔离**：iframe 与宿主页不同源，宿主页 JS 无法读 iframe localStorage，天然隔离；但 iframe 内脚本与 `github.io` 同源，隔离靠沙箱形参而非跨域。

## 7. 与 GM/dev 分支的一致性

- 存储契约（键、schema、`listToolDefs` 真相源、`enabled` 语义）与 GM 分支**逐字一致**，仅后端从「Tampermonkey `GM_*`」换成「iframe `localStorage`」。
- `gm_storage.ts` 单一实现跨分支复用（靠 `$` 别名切换后端），**不fork存储逻辑**。
- 启动编排（definePreset → bootstrap → rehydrate）三分支（basement/dev/bookmarklet）共用同一套 basement API。

## 8. 跨站存储分区（设计取舍：尊重浏览器）

### 8.1 现象
在站点 A 点书签配置好工具开关、装好插件，切到站点 B 再点书签，状态是「全新」的——需要重新设置。这**不是 bug**，是浏览器强制行为。

### 8.2 机制：Storage Partitioning
现代浏览器对**第三方（跨源）iframe** 的存储（localStorage / IndexedDB / cookies 等）按 `(嵌入站点 embedder, iframe 源)` 二元组**分区**：
- iframe 源固定 = `github.io`（host 部署点）；
- 嵌入站点 = 用户当前浏览页的站点（a.com / b.com / …）各不相同；
→ 每个嵌入站点一份独立分区，互不连通。

因此「固定 iframe 源」并不能带来跨站统一：分区键里**嵌入站点是变量**。早先设想的「用固定 host 让存储跨站统一」在分区规则下不成立——这正是 §1.1 结论修订的原因。

### 8.3 为什么不绕过
- **回到宿主页主世界注入 UI（直写宿主 localStorage）**：仍按宿主站点分区（a.com 与 b.com 不同），且会污染宿主页存储、并受宿主 CSP `script-src` 拦截，更糟。
- **parent ↔ iframe 桥接转发存储**：parent 自身 localStorage 同样受其所在站点分区，桥接只是把分区从「iframe 分区」换成「parent 分区」，照样每站独立（此路已实测验证无效，代码已回退）。
- **后端同步**：需自建服务器，违背书签分支「零后端、纯前端」的轻量定位。

→ 本分支**有意尊重浏览器分区设计**，不引入任何绕过手段。

### 8.4 跨站统一的正确方案：油猴版
Tampermonkey / Violentmonkey 的 `GM_setValue` 是**脚本级存储**，不随网页源分区——同一脚本在所有站点共享一份配置。因此「设一次、全站通用」天然是油猴版（dev / tampermonkey 分支）的能力，而非书签分支。

### 8.5 选型建议
| 分支 | 安装成本 | 跨站配置 | 适用 |
|---|---|---|---|
| 书签版 | 免安装（拖书签） | 每站独立 | 临时/偶尔使用、不想装插件 |
| 油猴版 | 装一次插件 | 自动统一 | 长期固定使用、需配置跨站共享 |

> 书签版 storage 工具 `description` 中已加一句跨站提示，运行时用户也能直接看到。
