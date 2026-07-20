// userScript 世界总线：基于 GM_setValue + GM_addValueChangeListener 的跨标签页 / 跨脚本实例事件总线。
// 一个实例 emit，所有页面所有实例都能听到（remote=true 表示来自其它标签页/脚本实例）。
// 单通道键 __ma_bus__ 承载全部事件：emit 写 {event, payload, seq}，listener 解析后按 event 分发本地订阅者。
// seq 递增保证连续同事件也能触发值变化。payload 须可序列化（跨 GM 存储传输）。
// 无 GM_addValueChangeListener 时降级为进程内分发（同标签页仍可用）。

import { GM_setValue, GM_addValueChangeListener } from '$';

type Handler = (payload: unknown, remote: boolean) => void;

const CHANNEL = '__ma_bus__';
const subs = new Map<string, Set<Handler>>();
let seq = 0;

// 跨脚本监听：通道键变化 → 解析消息 → 按 event 分发本地订阅者（remote 区分来源）
const hasCross = typeof GM_addValueChangeListener === 'function';
if (hasCross) {
  GM_addValueChangeListener(CHANNEL, (_name, _oldV, newV, remote) => {
    if (!newV || typeof newV !== 'object') return;
    const msg = newV as { event: string; payload: unknown };
    const set = subs.get(msg.event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(msg.payload, !!remote); } catch (e) { console.error('[bus] handler error on', msg.event, e); }
    }
  });
}

// 降级路径：无跨脚本能力时同标签页直接分发
function localEmit(event: string, payload: unknown): void {
  const set = subs.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(payload, false); } catch (e) { console.error('[bus] handler error on', event, e); }
  }
}

export const bus = {
  on(event: string, fn: Handler): void {
    if (!subs.has(event)) subs.set(event, new Set());
    subs.get(event)!.add(fn);
  },
  off(event: string, fn: Handler): void {
    subs.get(event)?.delete(fn);
  },
  emit(event: string, payload?: unknown): void {
    if (hasCross) {
      GM_setValue(CHANNEL, { event, payload, seq: ++seq }); // 写键 → 所有实例 listener 收到（本标签页 remote=false）
    } else {
      localEmit(event, payload);
    }
  },
};
