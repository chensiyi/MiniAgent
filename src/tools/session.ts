import type { ToolDef, AgentLike } from '../core/executor';
import { storage, NS, FLAT, NS_FLAT } from '../core/storage';
import type { ChatMessage } from '../core/llm';
import { installHook, type HookFn } from '../tools/hooks';

// ============================================================
// §1 会话 id 与运行状态
// 当前 running 会话 id 是本工具的模块级状态（唯一可变源），executor 不再持有。
// genSessionId 优先 crypto.randomUUID，退化到时间戳+随机。
// ============================================================

// ---- 会话 id 生成（crypto.randomUUID 优先，退化到时间戳+随机）----
export function genSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* secure context 不可用，走退化方案 */
  }
  return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// 当前 running 会话 id（模块级状态；重注册/切换时更新，避免 stale-id 持续写盘）
let currentSessionId = '';

export function getCurrentSessionId(): string {
  return currentSessionId;
}
export function setCurrentSessionId(id: string): void {
  currentSessionId = id;
}

// ============================================================
// §2 落盘（session 工具自持）
// flushSession 惰性建记录 + 写索引；register 钩子与 call 多处复用。
// ============================================================

// 扁平 sessions 索引的 upsert / remove（原在 create/switch/remove 重复 4 次，现统一）
function indexUpsert(st: typeof storage, id: string): void {
  const idx = st.get<string[]>(NS_FLAT, FLAT.SESSIONS) ?? [];
  if (!idx.includes(id)) { idx.push(id); st.set(NS_FLAT, FLAT.SESSIONS, idx); }
}
function indexRemove(st: typeof storage, id: string): void {
  const idx = st.get<string[]>(NS_FLAT, FLAT.SESSIONS) ?? [];
  const ni = idx.filter((x) => x !== id);
  if (ni.length !== idx.length) st.set(NS_FLAT, FLAT.SESSIONS, ni);
}

// 把当前 running 会话的消息落盘（惰性建记录 + 写索引）。register 钩子与 call 多处复用。
export function flushSession(agent: AgentLike, st: typeof storage): void {
  const id = currentSessionId;
  if (!id) return;
  const cur = st.get<{ id: string; createdAt: number; messages: ChatMessage[] }>(NS.SESSION, id);
  if (!cur) {
    indexUpsert(st, id);
    st.set(NS.SESSION, id, { id, createdAt: Date.now(), messages: [...agent.messages] });
  } else {
    st.set(NS.SESSION, id, { ...cur, messages: [...agent.messages] });
  }
}

// ============================================================
// §3 工具描述符
// ============================================================

// 9) 会话管理：注册后自动把对话消息落盘到 session 命名空间（session:<id>），并在扁平键 sessions 建索引。
//    register = 安装/重建入口：生成 sessionId、向 agent.sendMessage 挂载 afterExe 钩子（经 installHook）。
//    注意【惰性创建】：注册时不再立即写空记录，而是首次真实对话（afterExe 触发）才创建
//    session:<id> 记录并写入扁平 sessions 索引——避免每次页面刷新都产生空会话污染存储。
//    幂等：installHook 同 id 重注册就地替换，不累积；unregister 经 uninstallToolHooks('session') 一次性清理。
//    支持 action：info / save / list / create / switch / remove（详见 inputSchema）。
//    会话 id 状态与落盘逻辑现由本工具自持（见 §1/§2），executor 核心不再持有。
export const sessionTool: ToolDef = {
  name: 'session',
  author: 'sys',
  description:
    '会话管理：注册后自动把对话消息落盘到 session 命名空间（session:<id>），并在扁平 sessions 建索引。' +
    'action：info=查看当前会话(默认)；save=立即落盘；list=列出全部会话；create=开新会话并清空上下文；' +
    'switch=切换到指定会话(id必填)；remove=删除指定会话(id必填，删当前则自动开新会话)。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['info', 'save', 'list', 'create', 'switch', 'remove'],
        description: 'info=当前会话信息(默认); save=立即落盘; list=列出全部会话; create=开新会话; switch=切换会话(id必填); remove=删除会话(id必填)',
      },
      id: { type: 'string', description: 'switch / remove 的目标会话 id' },
    },
  },
  register: (ctx) => {
    const id = genSessionId();
    setCurrentSessionId(id);
    ctx.agent.sessionId = id;
    // 注册时【不】立即落盘空记录：改为首次真实对话时惰性创建（见下方 persist 钩子），
    // 避免每次页面刷新都无条件新建一条空会话、污染 session 命名空间与扁平 sessions 索引。
    // 安装自动落盘钩子（installHook 懒包裹 + 幂等：同 id 重注册就地替换，避免累积/泄漏）；
    // 登记 toolName='session'，卸载时 uninstallToolHooks('session') 一次性清理。
    // persist 逻辑与 flushSession 等价，直接复用落盘函数。
    const persist = () => flushSession(ctx.agent, ctx.storage);
    installHook('sendMessage', 'after', persist as HookFn, {
      id: 'sys-session-persist',
      name: '会话落盘',
      toolName: 'session',
      core: true,
      agentRef: ctx.agent,
      execRef: ctx.executor,
    });
  },
  call: (args, ctx) => {
    const action = String(args.action ?? 'info');

    // list：列出全部会话（标注 current）
    if (action === 'list') {
      const idx = ctx.storage.get<string[]>(NS_FLAT, FLAT.SESSIONS) ?? [];
      const list = idx.map((sid) => {
        const rec = ctx.storage.get<{ createdAt?: number; messages?: unknown[] }>(NS.SESSION, sid);
        return { id: sid, current: sid === getCurrentSessionId(), createdAt: rec?.createdAt ?? null, messageCount: rec?.messages?.length ?? 0 };
      });
      return JSON.stringify(list);
    }

    // create：先保存当前会话，再开新会话并清空上下文
    if (action === 'create') {
      flushSession(ctx.agent, ctx.storage);
      const newId = genSessionId();
      setCurrentSessionId(newId);
      ctx.agent.sessionId = newId;
      ctx.agent.messages = [];
      indexUpsert(ctx.storage, newId);
      ctx.storage.set(NS.SESSION, newId, { id: newId, createdAt: Date.now(), messages: [] });
      return `已创建新会话 ${newId}（上下文已清空，旧会话已保存）`;
    }

    // switch：先保存当前，再加载目标会话消息到运行上下文
    if (action === 'switch') {
      const target = String(args.id ?? '');
      if (!target) return '参数 id 缺失（要切换到的会话 id）';
      const rec = ctx.storage.get<{ messages?: unknown[] }>(NS.SESSION, target);
      if (!rec) return `会话不存在: ${target}`;
      flushSession(ctx.agent, ctx.storage);
      setCurrentSessionId(target);
      ctx.agent.sessionId = target;
      ctx.agent.messages = (rec.messages ?? []) as any[];
      return `已切换到会话 ${target}（${rec.messages?.length ?? 0} 条消息）`;
    }

    // remove：删除目标会话；若删的是当前会话则自动开新会话
    if (action === 'remove') {
      const target = String(args.id ?? '');
      if (!target) return '参数 id 缺失（要删除的会话 id）';
      const rec = ctx.storage.get(NS.SESSION, target);
      if (!rec) return `会话不存在: ${target}`;
      ctx.storage.del(NS.SESSION, target);
      indexRemove(ctx.storage, target);
      if (target === getCurrentSessionId()) {
        const newId = genSessionId();
        setCurrentSessionId(newId);
        ctx.agent.sessionId = newId;
        ctx.agent.messages = [];
        indexUpsert(ctx.storage, newId);
        ctx.storage.set(NS.SESSION, newId, { id: newId, createdAt: Date.now(), messages: [] });
        return `已删除当前会话 ${target}，并开启新会话 ${newId}`;
      }
      return `已删除会话 ${target}`;
    }

    // info / save 需要当前会话
    const id = ctx.agent.sessionId;
    if (!id) return '会话未初始化';
    if (action === 'save') {
      flushSession(ctx.agent, ctx.storage);
      return `已落盘会话 ${id}（${ctx.agent.messages.length} 条消息）`;
    }
    // 默认 info
    const stored = ctx.storage.get(NS.SESSION, id);
    return JSON.stringify({ id, messageCount: ctx.agent.messages.length, persisted: !!stored });
  },
};
