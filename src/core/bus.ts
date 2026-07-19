// 极简事件总线：解耦"状态变化 → 多订阅者"。
// 主要服务 storage:changed（存储变更 → ui.storageEditor 刷新），也供未来扩展。

type Handler = (...args: any[]) => void;

class Bus {
  private map = new Map<string, Set<Handler>>();

  on(event: string, fn: Handler): void {
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event)!.add(fn);
  }

  off(event: string, fn: Handler): void {
    this.map.get(event)?.delete(fn);
  }

  emit(event: string, ...args: any[]): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        console.error('[bus] handler error on', event, e);
      }
    }
  }
}

export const bus = new Bus();
