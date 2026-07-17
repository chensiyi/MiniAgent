import React from 'react';
import { Card, Input, Button, List, Space } from 'antd';
import MessageBubble from './MessageBubble';
import ToolCard from './ToolCard';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  result?: string;
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  toolCalls: ToolCall[];
  onSend: (text: string) => void;
  running: boolean;
}

export default function ChatPanel({ messages, toolCalls, onSend, running }: ChatPanelProps) {
  const [input, setInput] = React.useState('');

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
      style={{ height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 0 }}
      styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 } }}
    >
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
    </Card>
  );
}
