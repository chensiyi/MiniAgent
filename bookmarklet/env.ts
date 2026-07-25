// bookmarklet 环境的 `$` 垫片：把油猴 GM_* 映射到 iframe（CDN 固定源）的浏览器能力。
// host.html 让本脚本跑在 CDN 源里，故此处的 localStorage / document 都是 iframe 自身（CDN 固定源），
// 天然实现跨站统一持久化（无需额外 hub 页）。

const NS = 'miniagent:';

export function GM_setValue(key: string, value: unknown): void {
  localStorage.setItem(NS + key, JSON.stringify(value));
}

export function GM_getValue(key: string, defaultValue?: unknown): unknown {
  const raw = localStorage.getItem(NS + key);
  if (raw === null) return defaultValue;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function GM_deleteValue(key: string): void {
  localStorage.removeItem(NS + key);
}

export function GM_listValues(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(NS)) out.push(k.slice(NS.length));
  }
  return out;
}

export function GM_addStyle(css: string): void {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}
