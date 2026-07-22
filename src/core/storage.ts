import { GM_getValue, GM_setValue, GM_deleteValue, GM_listValues } from '$';
import type { ToolDesc } from './executor';

// 存储键集中定义（单一真相源），与逻辑存储层同处此文件（keys 本就只服务于 storage，故合并于此）。
// 内核所有 storage 读写一律引用本文件常量，禁止在业务逻辑里散落硬编码字符串。
//
// 分类：
//  - NS_FLAT         ：扁平键命名空间（空串），realKey('', key) === key
//  - NS.*            ：命名空间（ns:key 形式，如 tools:<name> / hooks:<id> / session:<id> / memory:<key> / code:<key>）
//  - FLAT.*          ：扁平键（无 ns 前缀：config / sessions）；用户在 Tampermonkey 数值(Values)里可直接看到并编辑
//  - OVERVIEW_NS     ：gm_storage list 无 ns 参数时列出的命名空间清单
//  - LEGACY.*        ：旧 default: 命名空间下的键，仅供一次性迁移读取，新代码禁止写入

// 扁平键命名空间（空字符串）
export const NS_FLAT = '';

// 命名空间
export const NS = {
  TOOLS: 'tools',
  HOOKS: 'hooks',
  SESSION: 'session',
  MEMORY: 'memory',
  CODE: 'code',
} as const;

// 扁平键（无 ns 前缀）
export const FLAT = {
  CONFIG: 'config',
  SESSIONS: 'sessions',
} as const;

// gm_storage list 概览要列出的命名空间
export const OVERVIEW_NS: string[] = [NS.SESSION, NS.TOOLS, NS.CODE, NS.MEMORY];

// 历史遗留键（旧 default: 命名空间）。值为 { ns, key }，仅供迁移读取。
export const LEGACY = {
  CONFIG: { ns: 'default', key: 'config' },
  SESSIONS: { ns: 'default', key: 'sessions' },
} as const;

// 逻辑存储层：薄封装 Tampermonkey GM_*，自动 JSON 序列化/反序列化。
// 存储按"命名空间"分区：realKey 空 ns → 扁平键（如 config），非空 → `${ns}:${key}`（如 default:xxx / session:<id> / tools:<name>）。
// set 由 hooks 工具在注册时经 wrapHook 包裹（保留扩展钩子能力，运行期带 beforeExe/afterExe）；get/del/keys 为基础操作无需钩子。

const NS_SEP = ':';

// 空 ns → 扁平键（无前缀），如 config；非空 → `${ns}:${key}`（如 default:xxx / tools:name）。
// 这样 config 存为扁平键 `config`，用户在 Tampermonkey 数值里一眼可见、直接编辑（2026-07-21，回退到最初无 ns 设计）。
function realKey(ns: string, key: string): string {
  return ns ? `${ns}${NS_SEP}${key}` : key;
}

export const storage = {
  // 读取：JSON 反序列化；非 JSON 原样返回；缺失返回 fallback。
  // ns 省略时默认 ''（扁平键，如 config）：storage.get('config')。
  // 1 参 = 仅 key（ns 默认 ''）；2/3 参 = (ns, key[, fallback])（兼容既有 storage.get(ns, key)）。
  get<T = unknown>(nsOrKey: string, keyOrFallback?: T | string, fallback?: T): T {
    let ns: string, key: string, fb: T | undefined;
    if (arguments.length === 1) { ns = ''; key = nsOrKey; fb = keyOrFallback as T; }
    else { ns = nsOrKey; key = keyOrFallback as string; fb = fallback; }
    const raw = GM_getValue<string>(realKey(ns, key), undefined as unknown as string);
    if (raw === undefined || raw === null) return fb as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  },

  // 写入：ns 省略时默认 ''（扁平键，如 config）：storage.set('config', agent.config)。
  // string 原样存，其余 JSON 序列化。afterExe 广播 storage:changed（由 hooks 工具 wrapHook 包裹后生效，替换本属性即可）。
  set(nsOrKey: string, keyOrValue: unknown, value?: unknown): void {
    if (arguments.length === 2) {
      GM_setValue(nsOrKey, typeof keyOrValue === 'string' ? keyOrValue : JSON.stringify(keyOrValue));
    } else {
      GM_setValue(realKey(nsOrKey, keyOrValue as string), typeof value === 'string' ? value : JSON.stringify(value));
    }
  },

  // 删除：ns 省略时默认 ''（扁平键，如 config）：storage.del('config')。
  del(nsOrKey: string, key?: string): void {
    if (arguments.length === 1) GM_deleteValue(nsOrKey);
    else GM_deleteValue(realKey(nsOrKey, key as string));
  },

  // 列出某命名空间下的子键（去前缀）；不传 ns 则返回全部原始键（含前缀）
  keys(ns?: string): string[] {
    const all: string[] = GM_listValues();
    if (!ns) return all;
    const prefix = `${ns}${NS_SEP}`;
    return all.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  },

  // 列出 tools 命名空间下全部工具描述符（系统真相源），供 boot 重建 / chat_ui 开关使用
  listToolDefs(): ToolDesc[] {
    return storage.keys(NS.TOOLS)
      .map((k) => storage.get<ToolDesc>('tools', k))
      .filter((d): d is ToolDesc => !!d);
  },
};
