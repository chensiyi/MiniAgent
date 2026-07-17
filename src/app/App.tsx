import { ConfigProvider } from 'antd';
import ChatPanel from '../view/ChatPanel';
import { useAgent } from '../core/useAgent';

// 核心 App：组合 view + core，启动 runtime（runtime 在 core 内自组织）
export default function App() {
  const agent = useAgent();
  return (
    <ConfigProvider>
      <div
        style={{
          height: '100%',
          background: '#fff',
          boxShadow: '-2px 0 8px rgba(0,0,0,0.15)',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <ChatPanel
          messages={agent.messages}
          toolCalls={agent.toolCalls}
          onSend={agent.send}
          running={agent.running}
        />
      </div>
    </ConfigProvider>
  );
}
