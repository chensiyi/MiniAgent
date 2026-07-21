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
  // 思考链：写回历史，供后续轮次（含工具循环）保留推理上下文
  reasoning_content?: string;
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

// 请求体里的 tools 字段格式（API 包装形态）
export interface ApiTool {
  type: 'function';
  function: { name: string; description: string; inputSchema: Record<string, unknown> };
}

// 请求体：调用方构建并传入 streamChat。含 messages / stream / tools，以及模型参数（model / temperature /
// max_tokens / reasoning_effort 及厂商扩展字段 top_p / response_format …）。编排钩子（streamChat.before）
// 通过 opts.args[0] 拿到这份请求体并可直接编辑（改 messages / tools / model / 温度等）。
export interface ChatRequestBody {
  messages: ChatMessage[];
  stream?: boolean;
  tools?: ApiTool[];
  tool_choice?: string | Record<string, unknown>;
  model?: string;
  [key: string]: unknown; // 厂商扩展字段（temperature / max_tokens / reasoning_effort / top_p …）
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
  // 入参 body 为已构建的请求体（messages/stream/tools + 模型参数），由调用方组装（含 baseRequestBody 模板
  // 与 config.model 兜底）。before 钩子可在请求发出前编辑 body（messages/tools/model/温度等）。
  streamChat: withHooks(async function* (body: ChatRequestBody): AsyncGenerator<ChatChunk> {
    const { apiKey, baseURL } = getConfig();
    if (!apiKey) throw new Error('未配置 API Key：请输入 /gm_storage /action set /ns default /key config /update true /value {"apiKey":"你的Key","baseURL":"https://openrouter.ai/api/v1","model":"openrouter/free"}');

    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
    // body 已由调用方构建（含 messages/stream/tools + baseRequestBody + config.model 兜底）。
    // 此处仅做必要兜底与锁定：messages 保底空数组、stream 强制 true（SSE 解析要求）。
    body.messages = body.messages ?? [];
    body.stream = true;

    // 内部 AbortController：支持 llm.cancel()
    llm._abort = new AbortController();
    const signal = llm._abort.signal;

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
            // 缺失 index 时分配到下一空槽（而非强并到 0），避免多个工具调用被错误合并
            let i = tc.index;
            if (i == null) i = Object.keys(acc).length;
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
  chat: withHooks(async (body: ChatRequestBody): Promise<ChatResult> => {
    const it = llm.streamChat(body);
    let r = await it.next();
    while (!r.done) r = await it.next();
    return (r.value ?? { content: '', toolCalls: [] }) as ChatResult;
  }),
};

// 迟绑 thisArg：使 streamChat / chat 体内 this 指向 llm（局部上下文），避免在其自身初始化器里引用自身导致 TDZ。
(llm.streamChat as unknown as { __thisArg?: unknown }).__thisArg = llm;
(llm.chat as unknown as { __thisArg?: unknown }).__thisArg = llm;
