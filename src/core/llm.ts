import gmFetch from '@sec-ant/gm-fetch';
import { getConfig } from '../model/config';
import { withHooks } from './withHooks';

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  // 工具循环所需的元数据（OpenAI 规范）
  tool_calls?: ToolCallLite[];
  tool_call_id?: string;
  name?: string;
}

// 流式输出的一个分片：文本增量 / 思考链增量 / 工具调用增量 / 结束标记
export interface ChatChunk {
  delta?: string;
  reasoning?: string; // 思考链增量（reasoning_content / reasoning）
  toolCall?: { index: number; id?: string; name?: string; arguments?: string };
  done?: boolean;
}

// 工具调用（已解析、参数已合并）
export interface ToolCallLite {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// 喂给 API 的工具声明（OpenAI tool schema 子集）
export interface ToolLite {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// 请求参数（对齐 webagentcli ProviderAPIServices 的 request）
export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolLite[];
  signal?: AbortSignal; // 调用方自带中止（保留）
  temperature?: number; // NEW
  maxTokens?: number; // NEW → max_tokens
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | string; // NEW → reasoning_effort
}

// 返回结果（对齐 StandardResponse：content / reasoning_content / toolCalls / finishReason / usage / model）
export interface ChatResult {
  content: string;
  toolCalls: ToolCallLite[];
  reasoningContent?: string; // 思考链
  finishReason?: string | null;
  usage?: any;
  model?: string;
}

const decoder = new TextDecoder();

// llmObj：对外统一入口。streamChat 为 async generator（withHooks 包成 asyncGenerator，仅 before 钩子）；chat 收集为完整结果。
export const llm = {
  _abort: null as AbortController | null,

  // 首类取消：中断在途请求（停止按钮调用）
  cancel(): void {
    this._abort?.abort();
    this._abort = null;
  },

  // 核心：流式调用 /chat/completions。逐行解析 SSE，yield 文本/思考/工具增量；结束 return 完整 ChatResult。
  streamChat: withHooks(async function* (opts: ChatOptions): AsyncGenerator<ChatChunk> {
    const { apiKey, model, baseURL } = getConfig();
    if (!apiKey) throw new Error('未配置 API Key：请在 src/model/config.ts 填写 apiKey');

    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      stream: true,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, inputSchema: t.inputSchema },
      }));
      body.tool_choice = 'auto';
    }
    // 仅当显式提供才下发（不猜测推理模型）
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts.reasoningEffort != null) body.reasoning_effort = opts.reasoningEffort;

    // 内部 AbortController：支持 llm.cancel()；外部 signal 优先
    llm._abort = new AbortController();
    const signal = opts.signal ?? llm._abort.signal;

    const res = await gmFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM 请求失败 (${res.status}): ${text.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('响应不可流式读取（gm-fetch 未返回 ReadableStream）');

    let buf = '';
    let content = '';
    let reasoningContent = '';
    let finishReason: string | null = null;
    let usage: any = undefined;
    let modelResp: string | undefined = undefined;
    const acc: Record<number, { id: string; name: string; args: string }> = {};

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') {
          yield { done: true };
          continue;
        }
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.model) modelResp = json.model;
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          yield { delta: delta.content };
        }
        // 思考链（reasoning_content 或 reasoning）
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) {
          reasoningContent += reasoning;
          yield { reasoning };
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls as any[]) {
            const i = tc.index ?? 0;
            acc[i] ??= { id: '', name: '', args: '' };
            if (tc.id) acc[i].id = tc.id;
            if (tc.function?.name) acc[i].name = tc.function.name;
            if (tc.function?.arguments) acc[i].args += tc.function.arguments;
            yield {
              toolCall: {
                index: i,
                id: tc.id,
                name: tc.function?.name,
                arguments: tc.function?.arguments,
              },
            };
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }

    const toolCalls: ToolCallLite[] = Object.values(acc).map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: t.args },
    }));

    // 完整结果由 return 提供（for await 会丢弃，chat() 用手动迭代器捕获）
    return { content, reasoningContent, toolCalls, finishReason, usage, model: modelResp } as ChatResult;
  }),

  // 收集完整结果：手动驱动迭代器以捕获 return 的完整 ChatResult（含 reasoningContent/finishReason/usage/model）
  chat: withHooks(async (opts: ChatOptions): Promise<ChatResult> => {
    const it = llm.streamChat(opts);
    let r = await it.next();
    while (!r.done) r = await it.next();
    return (r.value ?? { content: '', toolCalls: [] }) as ChatResult;
  }),
};
