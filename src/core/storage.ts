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

// ============================================================
// 内存对象级别 storage：Map<string, any> + CRUD。纯内存、与环境无关
// （不引入任何 GM_* / 浏览器 API）。
// 持久化由环境层工具（油猴 gm_storage、浏览器标签 ls_storage 等）透明完成：它们在自身
// register 时把外部存储一次性镜像进本 Map，并装上 storageSet/storageDelete 的 before 钩子
// 把写回落到外部存储。调用方照常使用 get/set/del/keys，无需关心环境。
// ============================================================

const NS_SEP = ':';

// 空 ns → 扁平键（无前缀），如 config；非空 → `${ns}:${key}`（如 default:xxx / tools:name）。
// 这样 config 存为扁平键 `config`，用户在 Tampermonkey 数值里一眼可见、直接编辑。
function realKey(ns: string, key: string): string {
  return ns ? `${ns}${NS_SEP}${key}` : key;
}

// 由 storage.set 的原始入参推导最终「键 + 值」（兼容 ns/key 双参与扁平单键两种调用）。
// 既供 storage.set 内部使用，也供 gm_storage 的落盘 before 钩子复用——保证内存键与落盘键完全一致。
export function resolveSet(
  nsOrKey: string,
  keyOrValue: unknown,
  value?: unknown,
): { key: string; val: unknown } {
  // 2 参 = (key, value) 扁平键；3 参 = (ns, key, value) 命名空间键。
  if (arguments.length <= 2 || value === undefined) return { key: nsOrKey, val: keyOrValue };
  return { key: realKey(nsOrKey, String(keyOrValue)), val: value };
}

// 由 storage.del 的原始入参推导最终「键」（兼容 ns/key 双参与扁平单键）。
export function resolveDel(nsOrKey: string, key?: string): string {
  return arguments.length <= 1 || key === undefined ? nsOrKey : realKey(nsOrKey, String(key));
}

class Storage {
  private mem = new Map<string, unknown>();

  // 读取：内存优先；缺失返回 fallback。
  // 1 参 = 仅 key（ns 默认 ''，扁平键，如 config）；2 参 = (ns, key)（命名空间键）。
  get<T = unknown>(nsOrKey: string, keyOrFallback?: T | string, fallback?: T): T {
    let key: string;
    let fb: T | undefined;
    if (arguments.length === 1) {
      key = nsOrKey;
      fb = keyOrFallback as T;
    } else {
      key = realKey(nsOrKey, keyOrFallback as string);
      fb = fallback;
    }
    return this.mem.has(key) ? (this.mem.get(key) as T) : (fb as T);
  }

  // 写入：仅写内存。落盘由 gm_storage 的 before 钩子负责（不在本文件）。
  // 2 参 = (key, value) 扁平键；3 参 = (ns, key, value) 命名空间键。
  set(nsOrKey: string, keyOrValue: unknown, value?: unknown): void {
    const { key, val } = resolveSet(nsOrKey, keyOrValue, value);
    this.mem.set(key, val);
  }

  // 删除：仅删内存。落盘清除由 gm_storage 的 before 钩子负责。
  // 1 参 = 仅 key（扁平键）；2 参 = (ns, key) 命名空间键。
  del(nsOrKey: string, key?: string): void {
    this.mem.delete(resolveDel(nsOrKey, key));
  }

  // 列出子键：不传 ns 返回全部原始键（含前缀）；传 ns 去前缀返回该分区子键。
  keys(ns?: string): string[] {
    const all = [...this.mem.keys()];
    if (!ns) return all;
    const prefix = `${ns}${NS_SEP}`;
    return all.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  // 列出 tools 命名空间下全部工具描述符（系统真相源），供 boot 重建 / chat_ui 开关使用
  listToolDefs(): ToolDesc[] {
    return this.keys(NS.TOOLS)
      .map((k) => this.get<ToolDesc>('tools', k))
      .filter((d): d is ToolDesc => !!d);
  }
}

// 全局唯一内存存储实例，供 agent / ctx / 工具共用（同一引用，落盘钩子对其方法生效）。
export const storage = new Storage();
