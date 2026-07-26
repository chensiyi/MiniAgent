/// <reference path="../basement.d.ts" />

// 独立环境（bookmarklet 分支）：直接读写 iframe 的 localStorage，GM_* 垫片（env.ts / $ 别名）已彻底移除。
// 命名空间前缀与旧 env.ts 保持一致（miniagent:），使既有持久化数据可无缝沿用。
const { agent } = MiniAgent;
// hooks 经 agent.tools.get('hooks') 取回；存为模块级变量供 register / unregister 共用。
let hooks: HooksTool | undefined;

const NS_PREFIX = 'miniagent:'; // 落盘键前缀（与旧 bookmarklet/env.ts 同源，保证数据兼容）
const FLAT = '';

// ---- 直接落盘到 localStorage（独立环境，无 GM_* 依赖） ----
function lsSet(key: string, val: unknown): void {
  // 配额超限等异常照常上抛：before 钩子抛错 → base（内存写入）被跳过（hooks 契约）。
  localStorage.setItem(NS_PREFIX + key, JSON.stringify(val));
}
function lsGet(key: string): unknown {
  const raw = localStorage.getItem(NS_PREFIX + key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function lsDel(key: string): void {
  localStorage.removeItem(NS_PREFIX + key);
}
function lsList(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(NS_PREFIX)) out.push(k.slice(NS_PREFIX.length));
  }
  return out;
}

// 由 storage.set / storage.del 原始入参推导最终键（兼容 分区:键 双参与扁平单键两种调用，供落盘钩子使用）。
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

// 模块级幂等标志：localStorage → 内存 Map 镜像只需做一次（register 可能被多次调用）。
let mirrored = false;

// 落盘能力（核心职责）：storage 本身是「内存 Map + CRUD」，不含任何环境写入；
// 本工具在 register 时把 localStorage 一次性镜像进内存 Map，并包裹 storage.set / storage.del
// 装上 localStorage 落盘 before 钩子，使一切 storage 写操作透明落盘——其它工具只管读 storage，无需关心运行环境。
// 本工具仅负责「镜像 + 落盘」，不触发任何核心启动（启动由 dev 经 tool_manager.bootstrap 统一编排）。
// before 阶段落盘：若 localStorage 写入抛错（如配额超限），base（内存写入）被跳过，原方法不执行
// （hooks 契约：before 钩子抛错 → 不执行 base，见 hooks.ts wrapHook）。
export const storageTool: ToolDef = {
  name: 'storage',
  author: 'sys',
  deps: [{ name: 'hooks', author: 'sys' }], // 依赖 hooks（已 IIFE 注册的内核）；拓扑序保证 hooks 先于本工具
  description: '统一的持久存储管理（仅操作顶层扁平键，无命名空间概念）。action 取值：get=读取键；set=写入键（update=true 时合并已有对象）；list=列出所有顶层键；del=删除键（不可恢复，删除前会请求确认）。用于记忆、配置、状态管理。底层 storage 为内存 Map，本工具经 before 钩子透明落盘到 localStorage（独立环境，无 GM_* 依赖），其它工具无需关心环境。注意：会话等分区数据由各自的专用工具（如 session）管理，请勿用本工具删除分区内部键（如 sessions/config）。跨站提示：本书签版的存储位于固定 CDN 源 iframe 内的 localStorage；浏览器会对【跨源 iframe 的存储按嵌入站点分区】，因此在不同网页上的状态（如工具开关）相互独立、并不跨站共享。需要跨站统一请使用油猴版。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'list', 'del'],
        description: '操作类型：get=读取某个键的值；set=写入/更新某个键；list=列出当前命名空间（memory）下的所有键；del=删除某个键（不可恢复，删除前会请求用户确认）。',
      },
      key: { type: 'string', description: '键名。get/set/del 必需；list 不需要。' },
      value: {
        type: 'string',
        description: '要保存的值（set 必需）。会原样写入存储；get 时以 JSON 字符串形式返回，因此对象/数组等复杂值建议先 JSON 序列化后传入。',
      },
      update: {
        type: 'boolean',
        description: '仅 set 生效。为 true 时进入合并模式：先读取已有值，再把传入的值（对象）浅合并进去，而非整条覆盖。',
      },
    },
    required: ['action'],
  },
  // 注册 = 安装落盘机制：确保内存镜像就绪 + 取回 hooks + 包裹 storage.set/del + 装 localStorage 落盘 before 钩子。
  // 本工具只负责「镜像 + 落盘」，不触发任何核心启动（启动由 dev 经 tool_manager.bootstrap 统一编排）。
  register(ctx): void {
    // 启动期把 localStorage 一次性镜像进内存 Map（幂等；纯内存 Storage 不含 load，由环境层在此完成）。
    // 兼容旧 GM 双编码数据：若读出的是字符串且仍是合法 JSON，再解一层以还原对象（过渡期一次性自愈）。
    if (!mirrored) {
      for (const k of lsList()) {
        let v = lsGet(k);
        if (v === undefined || v === null) continue;
        if (typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch {
            /* 非 JSON 字符串，原样保留 */
          }
        }
        agent.storage.set('', k, v);
      }
      mirrored = true;
    }
    // hooks 已由 basement IIFE 注册（环境无关内核），此处经标准接口取回即可（无需顶层取、无需 boot）。
    hooks = agent.tools.get('hooks') as unknown as HooksTool;
    // 落盘钩子（before 阶段）：先写 localStorage，再执行 base（内存写入）。
    // 落盘失败（localStorage 抛错）→ before 抛错 → base 被跳过（见 hooks 契约）。
    hooks.installHook('storageSet', 'before', (opts) => {
      const { key, val } = resolveSet(opts.args[0] as string, opts.args[1], opts.args[2]);
      lsSet(key, val);
    }, { id: 'sys-ls-persist-set', name: 'localStorage 落盘(set)', toolName: 'storage', core: true, agentRef: ctx.agent, execRef: ctx.executor });
    hooks.installHook('storageDelete', 'before', (opts) => {
      lsDel(resolveDel(opts.args[0] as string, opts.args[1] as string | undefined));
    }, { id: 'sys-ls-persist-del', name: 'localStorage 落盘(del)', toolName: 'storage', core: true, agentRef: ctx.agent, execRef: ctx.executor });
    console.log('[MiniAgent] storage 已挂载落盘钩子（storageSet/storageDelete → localStorage）');
  },
  // 卸载 = 摘除落盘钩子（运行期）；已落盘数据保留在 localStorage，重载可重建。
  unregister(_ctx): void {
    hooks?.uninstallToolHooks('storage');
    console.log('[MiniAgent] storage 已卸载，落盘钩子已摘除');
  },
  call: async (args, ctx) => {
    const action = String(args.action ?? '');
    switch (action) {
      case 'get': {
        const key = String(args.key ?? '');
        if (!key) return '参数 key 缺失';
        const v = ctx.storage.get(FLAT, key);
        return v === undefined ? '(无此键)' : JSON.stringify(v);
      }
      case 'set': {
        const key = String(args.key ?? '');
        if (!key) return '参数 key 缺失';
        if (args.value === undefined) return '参数 value 缺失';
        if (args.update) {
          const existing = ctx.storage.get(FLAT, key) ?? {};
          const incoming = args.value;
          const merged = typeof existing === 'object' && existing && typeof incoming === 'object' && incoming
            ? { ...(existing as Record<string, unknown>), ...(incoming as Record<string, unknown>) }
            : incoming;
          ctx.storage.set(FLAT, key, merged);
          return `已合并保存 ${key}`;
        }
        ctx.storage.set(FLAT, key, args.value);
        return `已保存 ${key}`;
      }
      case 'list': {
        const keys = agent.storage.keys(FLAT).filter((k) => k !== 'sessions').sort((a, b) => a.localeCompare(b));
        return JSON.stringify({ ns: '(flat)', count: keys.length, keys });
      }
      case 'del': {
        const key = String(args.key ?? '');
        if (!key) return '参数 key 缺失';
        const ok = await ctx.executor.requestApproval({ name: `storage:del ${key}`, riskLevel: 'high' }, ctx.agent);
        if (!ok) return '用户拒绝了执行';
        ctx.storage.del(FLAT, key);
        return `已删除 ${key}`;
      }
      default:
        return `未知 action: ${action}（支持 get/set/list/del）`;
    }
  },
};
