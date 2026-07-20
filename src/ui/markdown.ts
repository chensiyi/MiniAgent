// 极简 markdown 渲染器（纯原生 TS，零依赖）
// 支持：代码块/标题/引用/有序无序列表/分隔线/行内代码/加粗/斜体/链接
// 顺序：先 HTML 转义防 XSS → 块级解析 → 行内替换。返回 HTML 字符串（经 ui.setHTML 赋值走 Trusted Types）

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 行内替换（在已转义文本上操作，& < > 已安全）
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMarkdown(md: string): string {
  if (!md) return '';
  const lines = esc(md).split('\n');
  const out: string[] = [];
  let i = 0, inUL = false, inOL = false;
  const close = (): void => { if (inUL) { out.push('</ul>'); inUL = false; } if (inOL) { out.push('</ol>'); inOL = false; } };

  while (i < lines.length) {
    const line = lines[i];
    // 代码块 ```lang ... ```
    if (line.startsWith('```')) {
      close();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
      i++;
      out.push(`<pre class="ma-md-pre"><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { close(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^---+\s*$/.test(line)) { close(); out.push('<hr>'); i++; continue; }
    if (line.startsWith('&gt; ')) { close(); out.push(`<blockquote>${inline(line.slice(5))}</blockquote>`); i++; continue; }
    if (/^[-*]\s+/.test(line)) { if (!inUL) { close(); out.push('<ul>'); inUL = true; } out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`); i++; continue; }
    if (/^\d+\.\s+/.test(line)) { if (!inOL) { close(); out.push('<ol>'); inOL = true; } out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ''))}</li>`); i++; continue; }
    if (!line.trim()) { close(); i++; continue; }
    close();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  close();
  return out.join('');
}
