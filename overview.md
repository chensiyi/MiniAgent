# 重构交付概述：sandbox.ts 抽取 + 钩子机制收口到 hooks

## 目标
按 sandbox 方案，把用户代码编译器家族抽成独立模块 `src/core/sandbox.ts`，并顺势把钩子重建逻辑 `rehydrateHooks` 收进 `src/tools/hooks.ts`，让钩子系统的「编译 + 安装 + 重建」全部归 hooks 工具所有，executor 不再持有任何钩子机制代码。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/core/sandbox.ts`（新） | 迁入 `createSandboxFn` / `compileFn` / `compileBody` / `buildToolFromDesc` / `compileHook` + `SANDBOX_HEADER`。运行时仅依赖叶子 `storage`，对 `executor` 仅 `import type`（擦除后无运行期循环）。`compileHook` 改经 `agentRef.executor` 注入 executor，不再运行时引核心。 |
| `src/core/executor.ts` | 删除上述编译器家族 + `compileHook` 定义 + `rehydrateHooks` 方法与接口声明（约 -70 行）；导入改为 `hooksTool, uninstallToolHooks`（去 `installHook`/`HookFn`），新增 `buildToolFromDesc` 从 `./sandbox` 导入。executor 不再含钩子机制代码。 |
| `src/tools/hooks.ts` | 新增 `import { compileHook } from '../core/sandbox'`；新增导出 `rehydrateHooks(agentRef)`（读 `NS.HOOKS` 描述符 → `compileHook` 编译 → `installHook` 挂接，`execRef` 用 `agentRef.executor`）。 |
| `src/tools/code_run.ts` | `compileBody` 改从 `../core/sandbox` 导入。 |
| `src/tools/orchestrate.ts` | `compileHook` 改从 `../core/sandbox` 导入（保留 `executor` 从 `../core/executor`）。 |
| `src/tools/tool_manager.ts` | `buildToolFromDesc` 改从 `../core/sandbox` 导入。 |
| `src/agent.ts` | 新增 `import { rehydrateHooks } from './tools/hooks'`；调用处 `executor.rehydrateHooks(agent)` → `rehydrateHooks(agent)`。 |

## 依赖方向（关键：无运行期循环）
```
executor ──▶ hooks ──▶ sandbox ──▶ storage   (单向)
   │            │
   └────────────┘  (hooks→executor 仅类型导入，运行时擦除)
```
- executor → hooks（运行时值：`hooksTool`/`uninstallToolHooks`）
- hooks → sandbox（运行时值：`compileHook`）；hooks → executor（仅 `import type`）
- sandbox → executor（仅 `import type`）；sandbox → storage（运行时值）
- 无运行期回边 → 无循环依赖。

## 验证
- `npm run typecheck` → **exit 0**（无类型错误、`noUnusedLocals` 无未用导入）
- `npm run build` → **exit 0**（17 modules transformed，无循环/解析错误）

## 效果
- 钩子机制（wrap / install / uninstall + 编译 + 重建）**全部归 hooks 工具**，符合「钩子相关该在 hookTool 里」的直觉。
- 沙箱编译器独立成可一处审计的模块，边界清晰。
- `executor.ts` 进一步瘦身（移除 ~70 行钩子/编译器代码）。

## 备注
- 未顺手处理的上轮遗留项：executor.ts L11-13 那句「requestApproval 已由 hooks 工具经 wrapHook 包裹」仍是**过时注释**（实际委托 `extensions.get('approval')`，见 P0-2）。如需可单独修。
- 行为完全不变，纯结构重排。
