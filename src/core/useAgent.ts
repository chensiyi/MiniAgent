import { useCallback, useState } from 'react';
import type { ChatMessage, ToolCall } from '../view';
import { createRuntime } from './runtime';
import type { ToolCallResult } from './runtime';

// React hook：编排主要业务动作，串 view 与 core
export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [running, setRunning] = useState(false);

  const send = useCallback(async (text: string) => {
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setRunning(true);

    // TODO(后续阶段): 接入 model 层（@sec-ant/gm-fetch + provider）后替换此占位逻辑
    try {
      const runtime = createRuntime();
      const reply = await runtime.run(text);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: reply.text }]);
      if (reply.toolCalls?.length) {
        setToolCalls((prev) => [
          ...prev,
          ...reply.toolCalls!.map(
            (t: ToolCallResult): ToolCall => ({ ...t, status: t.status as 'done' | 'error' }),
          ),
        ]);
      }
    } finally {
      setRunning(false);
    }
  }, []);

  return { messages, toolCalls, running, send };
}
