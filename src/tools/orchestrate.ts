import type { ToolDef } from '../core/executor';
import { executor } from '../core/executor';
import { compileHook } from '../core/sandbox';
import { storage } from '../core/storage';
import { NS } from '../core/storage';
import { getSystemPrompt } from '../model/config';
import { installHook, uninstallHookById, uninstallHookByName, resolveHookTarget, getHookedTarget, listHookedTargetNames, type HookFn } from '../tools/hooks';

// 6) 系统编排管理：查看并热更新运行期"编排"（钩子 + 系统提示 + 工具面）。带 call → 进 LLM 清单，自我组织闭环。
//    钩子目标 = 被 hooks 工具 wrapHook 包、带 beforeExe/afterExe 数组的函数。存储独立于 config：每钩子存 hooks:<id>。
export const orchestrateTool: ToolDef = {
  name: 'orchestrate',
  author: 'sys',
  description:
    '系统编排管理：查看并热更新当前智能体的"编排"（运行期钩子 + 系统提示 + 引擎请求体 + 工具面）。action 取值 view（查看实时编排快照：系统提示 + 各钩子目标 sendMessage/engine/run/chat/requestApproval/storageSet 的运行期钩子清单（含 name 与 id）+ 工具清单 + 引擎（endpoint 的 model/baseURL，来自扁平 config 键））/ update（改写系统提示并热生效，需传 systemPrompt）/ addHook（热挂接用户钩子，需传 name/target/phase/code；code 为钩子体，签名 (opts, agent, storage, executor, console)，可经 opts.args 改写请求体（chat.before 里改 opts.args[0].messages/.tools/.model/温度等即可在请求发出前编辑完整 ChatRequestBody））/ removeHook（移除用户钩子，需传 hookId 或 name；按 name 移除所有同名用户钩子）。update/addHook/removeHook 执行前均弹确认框。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'update', 'addHook', 'removeHook'],
        description: 'view=查看快照(默认)；update=改写系统提示；addHook=挂接用户钩子；removeHook=移除用户钩子',
      },
      systemPrompt: { type: 'string', description: 'update 时用的新系统提示全文' },
      name: { type: 'string', description: 'addHook 时钩子显示名；removeHook 时按名移除（移除所有同名用户钩子）。与 hookId 二选一' },
      target: {
        type: 'string',
        enum: ['sendMessage', 'engine', 'run', 'chat', 'requestApproval', 'storageSet'],
        description: 'addHook 时挂接到哪个钩子目标',
      },
      phase: { type: 'string', enum: ['before', 'after'], description: 'addHook 时 before/after 阶段（默认 before）' },
      code: {
        type: 'string',
        description: 'addHook 时的钩子体源码。会被包成 (opts, agent, storage, executor, console) => void：可通过改写 opts.args 影响行为（如 chat.before 里改 opts.args[0].messages / .tools / .model / 温度等，即可在请求发出前编辑完整请求体 ChatRequestBody）；agent/storage/executor/console 为运行时上下文。示例："console.log(opts.args);"。',
      },
      hookId: { type: 'string', description: 'removeHook 时目标钩子 id（与 name 二选一）' },
    },
  },
  call: async (args, ctx) => {
    const action = String(args.action ?? 'view');
    if (action === 'view') {
      const hooksSnap: Record<string, { before: { name: string; id: string | null }[]; after: { name: string; id: string | null }[] }> = {};
      for (const t of listHookedTargetNames()) {
        const fn = getHookedTarget(t, ctx.agent, ctx.executor);
        // 懒包裹下，某些目标可能从未被挂钩（仍是原始函数，无 beforeExe/afterExe）→ 视为空列表，不报错。
        const hooked = fn && (fn as unknown as { __hooked?: boolean }).__hooked ? fn : null;
        // 每个钩子带 name + id（user 钩子有 id，core 钩子也有稳定 id + 可读名）——便于编排查看与按名/按 id 排序
        const describe = (f: any): { name: string; id: string | null } => {
          if (f.__userHook) return { name: String(f.__name ?? 'userHook'), id: (f.__hookId as string) ?? null };
          if (f.__coreHook) return { name: String(f.__name ?? 'system'), id: (f.__hookId as string) ?? null };
          return { name: '(core)', id: null };
        };
        hooksSnap[t] = {
          before: hooked ? hooked.beforeExe.map(describe) : [],
          after: hooked ? hooked.afterExe.map(describe) : [],
        };
      }
      const cfg = ctx.agent.config;
      return JSON.stringify(
        {
          systemPrompt: getSystemPrompt(cfg),
          hooks: hooksSnap,
          tools: executor.list(true).map((t) => ({ name: t.name, author: t.author, hasCall: typeof t.call === 'function' })),
          engine: {
            endpoint: { model: cfg.model, baseURL: cfg.baseURL },
          },
        },
        null,
        2,
      );
    }
    if (action === 'update') {
      const ok = await executor.requestApproval({ name: 'orchestrate.update', riskLevel: 'high', code: String(args.systemPrompt ?? '') }, ctx.agent);
      if (!ok) return '已取消';
      const sp = String(args.systemPrompt ?? '');
      if (!sp) return 'systemPrompt 不能为空';
      ctx.agent.config.systemPrompt = sp; // 改内存
      storage.set('config', ctx.agent.config); // 持久化：系统提示随每次 chat 请求从 agent.config 重建，下次请求即生效
      return '已更新系统提示（下次 chat 请求即生效，系统提示随请求从 config 重建）';
    }
    if (action === 'addHook') {
      const codeStr = String(args.code ?? '');
      const ok = await executor.requestApproval({ name: 'orchestrate.addHook', riskLevel: 'high', code: codeStr }, ctx.agent);
      if (!ok) return '已取消';
      const target = String(args.target ?? '');
      if (!resolveHookTarget(target, ctx.agent, ctx.executor)) return `未知 target: ${args.target}`;
      const phase = String(args.phase ?? 'before');
      if (phase !== 'before' && phase !== 'after') return 'phase 必须为 before/after';
      const name = String(args.name ?? 'userHook');
      const id = 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      let wrapped: ((opts: any) => void) & Record<string, unknown>;
      try {
        wrapped = compileHook(codeStr, name, ctx.agent);
      } catch (e) {
        return `钩子代码编译失败: ${e instanceof Error ? e.message : String(e)}`;
      }
      // installHook 按名解析 + 懒包裹 + 登记（toolName='orchestrate'，便于 removeHook / 卸载编排时一次性清理）+ 持久化
      installHook(target, (phase === 'after' ? 'after' : 'before'), wrapped as HookFn, {
        id,
        name,
        toolName: 'orchestrate',
        core: false,
        agentRef: ctx.agent,
        execRef: ctx.executor,
      });
      storage.set(NS.HOOKS, id, { id, name, target, phase, code: codeStr });
      return `已挂接用户钩子 ${name} → ${target}.${phase}（id=${id}），刷新不丢`;
    }
    if (action === 'removeHook') {
      const id = String(args.hookId ?? '');
      const name = String(args.name ?? '');
      if (!id && !name) return 'removeHook 需提供 hookId 或 name（按 name 移除所有同名用户钩子）';
      const ok = await executor.requestApproval({ name: 'orchestrate.removeHook', riskLevel: 'high', code: id || name }, ctx.agent);
      if (!ok) return '已取消';
      // 回收：经集中式钩子 API 按 id / 名移除（同时清持久化；core 钩子经 __userHook 过滤不在此移除）
      let removed = 0;
      if (id) removed += uninstallHookById(id) ? 1 : 0;
      else if (name) removed += uninstallHookByName(name);
      return removed ? `已移除 ${removed} 个钩子（id=${id || '-'} name=${name || '-'}）` : `未找到匹配钩子（id=${id || '-'} name=${name || '-'}）`;
    }
    return `未知 action: ${action}（支持 view/update/addHook/removeHook）`;
  },
};
