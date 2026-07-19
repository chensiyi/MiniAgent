import { GM_getValue, GM_setValue, GM_deleteValue, GM_listValues } from '$';
import { withHooks } from './withHooks';
import { bus } from './bus';

// 逻辑存储层：薄封装 Tampermonkey GM_*，自动 JSON 序列化/反序列化。
// 存储按"命名空间"分区：realKey = `${ns}:${key}`（如 default:config / session:<id> / tools:<name>）。
// 仅 set 包 withHooks（afterExe 广播 storage:changed，供订阅）；get/del/keys 为基础操作无需钩子。

const NS_SEP = ':';

function realKey(ns: string, key: string): string {
  return `${ns}${NS_SEP}${key}`;
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

  // 一次性迁移：把旧的扁平 key 搬到命名空间（仅首个版本遗留的 config）。
  migrateFlatToNs(flatKey: string, ns: string, nsKey: string): void {
    const raw = GM_getValue<string>(flatKey, undefined as unknown as string);
    if (raw === undefined) return; // 旧键不存在，无需迁移
    const cur = GM_getValue<string>(realKey(ns, nsKey), undefined as unknown as string);
    if (cur === undefined) GM_setValue(realKey(ns, nsKey), raw); // 仅当新键缺失才搬
    GM_deleteValue(flatKey);
  },
};

storage.set.afterExe.push(() => {
  bus.emit('storage:changed');
});
