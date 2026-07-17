// 视图共享类型（view 组件与 core 编排共用；替代原 view/index.ts barrel 里的类型出口）
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
