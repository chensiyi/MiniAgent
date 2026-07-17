import { Tag } from 'antd';

export interface ToolCardProps {
  id: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  result?: string;
}

const statusColor: Record<string, string> = {
  running: 'processing',
  done: 'success',
  error: 'error',
};

export default function ToolCard({ toolName, status, result }: ToolCardProps) {
  return (
    <div
      style={{
        width: '100%',
        padding: '6px 10px',
        border: '1px solid #f0f0f0',
        borderRadius: 8,
        background: '#fafafa',
      }}
    >
      <Tag color={statusColor[status]}>{toolName}</Tag>
      <span style={{ fontSize: 12, color: '#888' }}>{status}</span>
      {result && (
        <div style={{ marginTop: 4, fontSize: 12, color: '#555', whiteSpace: 'pre-wrap' }}>{result}</div>
      )}
    </div>
  );
}
