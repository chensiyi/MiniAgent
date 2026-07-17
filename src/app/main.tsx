import { createRoot } from 'react-dom/client';
import 'dayjs'; // 触发 externalGlobals 生成 dayjs 的 @require（antd UMD 需要全局 dayjs）
import App from './App';

// 挂容器 div 做页内浮窗隔离，再挂载 React 根
function mount() {
  const rootId = 'miniagent-root';
  let container = document.getElementById(rootId);
  if (!container) {
    container = document.createElement('div');
    container.id = rootId;
    container.style.position = 'fixed';
    container.style.right = '24px';
    container.style.bottom = '24px';
    container.style.zIndex = '2147483647';
    container.style.width = '380px';
    document.body.appendChild(container);
  }
  createRoot(container).render(<App />);
}

mount();
