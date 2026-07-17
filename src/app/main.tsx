import { createRoot } from 'react-dom/client';
import App from './App';

// 挂容器 div 做页内浮窗隔离，再挂载 React 根
function mount() {
  const rootId = 'miniagent-root';
  let container = document.getElementById(rootId);
  if (!container) {
    container = document.createElement('div');
    container.id = rootId;
    container.style.position = 'fixed';
    container.style.top = '0';
    container.style.right = '0';
    container.style.zIndex = '2147483647';
    container.style.width = '400px';
    container.style.height = '100vh';
    // 隔离宿主页面样式对浮窗的影响
    container.style.all = 'initial';
    document.body.appendChild(container);
  }
  createRoot(container).render(<App />);
}

mount();
