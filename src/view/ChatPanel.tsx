import { useState } from 'react';
import { Card, Input, Button, List, Space, Alert } from 'antd';
import MessageBubble from './MessageBubble';
import ToolCard from './ToolCard';
import SettingsModal from './SettingsModal';
import type { ChatMessage, ToolCall } from './types';

export interface ChatPanelProps {
  messages: ChatMessage[];
  toolCalls: ToolCall[];
  onSend: (text: string) => void;
  running: boolean;
  error?: string | null;
}

export default function ChatPanel({ messages, toolCalls, onSend, running, error }: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleSend = () => {
    const t = input.trim();
    if (!t) return;
    onSend(t);
    setInput('');
  };

  const dataSource: (ChatMessage | ToolCall)[] = [...messages, ...toolCalls];

  return (
    <Card
      title="MiniAgent"
      size="small"
      extra={
        <Button type="text" size="small" onClick={() => setSettingsOpen(true)}>
          设置
        </Button>
      }
      style={{ height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 0 }}
      styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 } }}
    >
      {error && <Alert type="error" message={error} banner />}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        <List
          dataSource={dataSource}
          renderItem={(item) => (
            <List.Item style={{ border: 'none', padding: '4px 0' }}>
              {'toolName' in item ? <ToolCard {...item} /> : <MessageBubble {...item} />}
            </List.Item>
          )}
        />
      </div>
      <Space.Compact style={{ width: '100%', padding: 8 }}>
        <Input
          value={input}
          placeholder="输入消息…"
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={handleSend}
          disabled={running}
        />
        <Button type="primary" onClick={handleSend} loading={running}>
          发送
        </Button>
      </Space.Compact>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Card>
  );
}
