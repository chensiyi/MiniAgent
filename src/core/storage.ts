import { GM_getValue, GM_setValue, GM_deleteValue, GM_listValues } from '$';
import { withHooks } from './withHooks';
import type { ToolDesc } from './executor';
import { NS } from './keys';

// 逻辑存储层：薄封装 Tampermonkey GM_*，自动 JSON 序列化/反序列化。
// 存储按"命名空间"分区：realKey 空 ns → 扁平键（如 config），非空 → `${ns}:${key}`（如 default:xxx / session:<id> / tools:<name>）。
// set 包 withHooks（保留扩展钩子能力）；get/del/keys 为基础操作无需钩子。

const NS_SEP = ':';

// 空 ns → 扁平键（无前缀），如 config；非空 → `${ns}:${key}`（如 default:xxx / tools:name）。
// 这样 config 存为扁平键 `config`，用户在 Tampermonkey 数值里一眼可见、直接编辑（2026-07-21，回退到最初无 ns 设计）。
function realKey(ns: string, key: string): string {
  return ns ? `${ns}${NS_SEP}${key}` : key;
}

export const storage = {
  // 读取：JSON 反序列化；非 JSON 原样返回；缺失返回 fallback。真泛型（修复旧版 TS2558）。
  get<T = unknown>(ns: string, key: string, fallback?: T): T {
    const raw = GM_getValue<string>(realKey(ns, key), undefined as unknown as string);
    if (raw === undefined || raw === null) return fallback as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  },

  // 写入：string 原样存，其余 JSON 序列化。afterExe 广播 storage:changed。
  set: withHooks((ns: string, key: string, value: unknown): void => {
    GM_setValue(realKey(ns, key), typeof value === 'string' ? value : JSON.stringify(value));
  }),

  // 删除：删 realKey
  del(ns: string, key: string): void {
    GM_deleteValue(realKey(ns, key));
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
