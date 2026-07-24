/// <reference path="../basement.d.ts" />
import { GM_setValue, GM_deleteValue, GM_listValues, GM_getValue } from '$';

// 消费经 @require 引入的 basement 全局（运行时已自动 init）
const agent = MiniAgent.agent;
// 钩子能力统一经标准 tool 接口取回（不再用散装全局 installHook / uninstallToolHooks）
const hooks = agent.tools.get('hooks') as unknown as HooksTool;

// 存储键常量（与 basement/src/core/storage.ts 同源；此处为环境层本地副本，避免跨 @require 导入）
const NS_MEM = 'memory';
const OVERVIEW_NS: string[] = ['session', 'tools', 'code', 'memory'];

// 由 storage.set / storage.del 原始入参推导最终键（兼容 ns/key 双参与扁平单键两种调用）。
// 与 basement 的 resolveSet/resolveDel 保持一致，保证内存键与落盘键完全一致。
function resolveSet(nsOrKey: string, keyOrValue: unknown, value?: unknown): { key: string; val: unknown } {
  if (value === undefined) return { key: nsOrKey, val: keyOrValue };
  const ns = String(nsOrKey);
  const key = String(keyOrValue);
  return { key: ns ? `${ns}:${key}` : key, val: value };
}
function resolveDel(nsOrKey: string, key?: string): string {
  return key === undefined ? nsOrKey : `${nsOrKey}:${key}`;
}

// 模块级幂等标志：GM_* → 内存 Map 镜像只需做一次（register 可能被多次调用）。
let mirrored = false;

// 落盘能力（核心职责）：storage 本身是「内存 Map + CRUD」，不含任何 GM_* 写入；
// 本工具在 register 时把 GM_* 一次性镜像进内存 Map，并包裹 storage.set / storage.del
// 装上 GM 落盘 before 钩子，使一切 storage 写操作透明落盘——其它工具只管读 storage，无需关心运行环境。
// before 阶段落盘：若 GM 写入抛错（如配额超限），base（内存写入）被跳过，原方法不执行
// （hooks 契约：before 钩子抛错 → 不执行 base，见 hooks.ts wrapHook）。
export const gmStorageTool: ToolDef = {
  name: 'gm_storage',
  author: 'sys',
  deps: [{ name: 'hooks', author: 'sys' }],
  description: '统一的持久存储管理（默认 memory 命名空间，可指定其它 ns）。action 取值：get=读取键；set=写入键（update=true 时合并已有对象）；list=列出键（给定 ns 列该分区子键，不给 ns 按 session/tools/code/memory 分区概览）；del=删除键（不可恢复，删除前会请求确认）。用于记忆、配置、状态管理。底层 storage 为内存 Map，本工具经 before 钩子透明落盘到 GM_*，其它工具无需关心环境。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'list', 'del'],
        description: '操作类型：get=读取某个键的值；set=写入/更新某个键；list=列出命名空间下的键（不给 ns 则按 session/tools/code/memory 分区概览）；del=删除某个键（不可恢复，删除前会请求用户确认）。',
      },
      key: { type: 'string', description: '键名。get/set/del 必需；list 不需要。' },
      value: {
        type: 'string',
        description: '要保存的值（set 必需）。会原样写入存储；get 时以 JSON 字符串形式返回，因此对象/数组等复杂值建议先 JSON 序列化后传入。',
      },
      ns: {
        type: 'string',
        description: "可选命名空间（分区）。默认 memory；也可用 session/tools/code 等已有分区，或自定义新分区。",
      },
      update: {
        type: 'boolean',
        description: '仅 set 生效。为 true 时进入合并模式：先读取已有值，再把传入的值（对象）浅合并进去，而非整条覆盖。',
      },
    },
    required: ['action', 'key', 'value', 'ns', 'update'],
    additionalProperties: false,
  },
  // 注册 = 安装落盘机制：确保内存镜像就绪 + 包裹 storage.set/del + 装 GM 落盘 before 钩子。
  register(ctx): void {
    // 启动期把 GM_* 一次性镜像进内存 Map（幂等；纯内存 Storage 不含 load，由环境层在此完成）。
    if (!mirrored) {
      for (const k of GM_listValues()) {
        const raw = GM_getValue<string>(k, undefined as unknown as string);
        if (raw === undefined || raw === null) continue;
        try {
          agent.storage.set('', k, JSON.parse(raw));
        } catch {
          agent.storage.set('', k, raw);
        }
      }
      mirrored = true;
    }
    // 落盘钩子（before 阶段）：先写 GM，再执行 base（内存写入）。
    // 落盘失败（GM 抛错）→ before 抛错 → base 被跳过（见 hooks 契约）。
    hooks.installHook('storageSet', 'before', (opts) => {
      const { key, val } = resolveSet(opts.args[0] as string, opts.args[1], opts.args[2]);
      GM_setValue(key, typeof val === 'string' ? val : JSON.stringify(val));
    }, { id: 'sys-gm-persist-set', name: 'GM 落盘(set)', toolName: 'gm_storage', core: true, agentRef: ctx.agent, execRef: ctx.executor });
    hooks.installHook('storageDelete', 'before', (opts) => {
      GM_deleteValue(resolveDel(opts.args[0] as string, opts.args[1] as string | undefined));
    }, { id: 'sys-gm-persist-del', name: 'GM 落盘(del)', toolName: 'gm_storage', core: true, agentRef: ctx.agent, execRef: ctx.executor });
    console.log('[MiniAgent] gm_storage 已挂载落盘钩子（storageSet/storageDelete → GM_*）');
  },
  // 卸载 = 摘除落盘钩子（运行期）；已落盘数据保留在 GM_*，重载可重建。
  unregister(_ctx): void {
    hooks.uninstallToolHooks('gm_storage');
    console.log('[MiniAgent] gm_storage 已卸载，落盘钩子已摘除');
  },
  call: async (args, ctx) => {
    const action = String(args.action ?? '');
    const ns = String(args.ns ?? NS_MEM);
    switch (action) {
      case 'get': {
        const key = String(args.key ?? '');
        if (!key) return '参数 key 缺失';
        const v = ctx.storage.get(ns, key);
        return v === undefined ? '(无此键)' : JSON.stringify(v);
      }
      case 'set': {
        const key = String(args.key ?? '');
        if (!key) return '参数 key 缺失';
        if (args.value === undefined) return '参数 value 缺失';
        if (args.update) {
          const existing = ctx.storage.get(ns, key) ?? {};
          const incoming = args.value;
          const merged = typeof existing === 'object' && existing && typeof incoming === 'object' && incoming
            ? { ...(existing as Record<string, unknown>), ...(incoming as Record<string, unknown>) }
            : incoming;
          ctx.storage.set(ns, key, merged);
          return `已合并保存 ${ns ? ns + ':' : ''}${key}`;
        }
        ctx.storage.set(ns, key, args.value);
        return `已保存 ${ns ? ns + ':' : ''}${key}`;
      }
      case 'list': {
        if (args.ns) {
          const keys = agent.storage.keys(ns).sort((a, b) => a.localeCompare(b));
          return JSON.stringify({ ns, count: keys.length, keys });
        }
        const overview: Record<string, string[]> = {};
        for (const n of OVERVIEW_NS) overview[n] = agent.storage.keys(n).sort((a, b) => a.localeCompare(b));
        overview.flat = agent.storage.keys().filter((k) => !k.includes(':')).sort((a, b) => a.localeCompare(b));
        return JSON.stringify(overview);
      }
      case 'del': {
        const key = String(args.key ?? '');
        if (!key) return '参数 key 缺失';
        const ok = await ctx.executor.requestApproval({ name: `gm_storage:del ${ns}:${key}`, riskLevel: 'high' }, ctx.agent);
        if (!ok) return '用户拒绝了执行';
        ctx.storage.del(ns, key);
        return `已删除 ${ns}:${key}`;
      }
      default:
        return `未知 action: ${action}（支持 get/set/list/del）`;
    }
  },
};
