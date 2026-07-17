import { useCallback, useState } from 'react';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { ChatMessage, ToolCall } from '../view/types';
import { createLLM, hasApiKey } from './llm';

// React 思路编排：把输入 → LLM 流式应答直接串进消息状态（本期纯对话，tools 留后续阶段）
export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolCalls] = useState<ToolCall[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (text: string) => {
      if (!hasApiKey()) {
        setError('未配置 API Key，请点右上角「设置」填入');
        return;
      }
      setError(null);

      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text };
      const assistantId = crypto.randomUUID();
      const history = [...messages, userMsg].map((m) =>
        m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content),
      );

      setMessages((prev) => [...prev, userMsg, { id: assistantId, role: 'assistant', content: '' }]);
      setRunning(true);
      try {
        const stream = await createLLM().stream(history);
        let acc = '';
        for await (const chunk of stream) {
          acc += typeof chunk.content === 'string' ? chunk.content : '';
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: acc } : m)));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: '⚠️ ' + msg } : m)));
      } finally {
        setRunning(false);
      }
    },
    [messages],
  );

  return { messages, toolCalls, running, error, send };
}
