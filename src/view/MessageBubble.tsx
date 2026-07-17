import { Typography } from 'antd';

export interface MessageBubbleProps {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export default function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '80%',
          padding: '8px 12px',
          borderRadius: 12,
          background: isUser ? '#1677ff' : '#f0f0f0',
          color: isUser ? '#fff' : 'rgba(0,0,0,0.88)',
          wordBreak: 'break-word',
        }}
      >
        <Typography.Text style={{ color: isUser ? '#fff' : 'inherit', whiteSpace: 'pre-wrap' }}>
          {content}
        </Typography.Text>
      </div>
    </div>
  );
}
