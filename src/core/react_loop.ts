
// ============ 类型（保持与 agent.engine 契约一致） ============
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  // 稳定消息 id：气泡与调用一一对应（ReActLoop 写入 assistant 消息时对齐气泡 id）
  id?: string;
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
  turn?: number; // ReAct 轮次（step 索引）：调用方可据此为每一轮创建独立气泡，避免多轮内容混在同一气泡导致顺序错乱 / 互相覆盖
  mid?: string; // 本轮助手消息 + 气泡共享的稳定 id（ReActLoop 每轮生成），做到「每个消息一个 id，气泡与消息对齐」
}

// 工具调用（已解析、参数已合并）
export interface ToolCallLite {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// 请求体里的 tools 字段格式（API 包装形态，对齐 OpenAI 工具标准）
export interface ApiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    // strict 模式（structured outputs）：仅当 required 覆盖全部 properties 时为 true（由调用方动态判定，见 agent.ts）。
    // 单用途工具（如 run_js/marked）required 列全属性 → strict:true；action 类工具 required 仅列通用必填 → strict:false（允许可选参数）。
    strict: boolean;
    parameters: Record<string, unknown>;
  };
}

// 请求体：调用方（agent.engine）依据 config 构建并传入 chat。含 messages / stream / tools，以及模型参数（model /
// temperature / max_tokens / reasoning_effort 及厂商扩展字段 top_p / response_format …）。编排钩子（chat.before）
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

// llm 运行依赖（由 agent 在调用时传入，llm 不反向依赖 agent）
export interface LlmDeps {
  apiKey: string;
  baseURL?: string;
}

// 稳定消息 id 生成器（时间序 + 自增序号，避免碰撞；导出供 agent 给 user 消息也打 id）
let _msgSeq = 0;
export function genMsgId(): string {
  return `m${Date.now().toString(36)}${(++_msgSeq).toString(36)}`;
}

// ============ 最小 SSE 解析（吸收 openai SDK streaming.mjs 思路，零依赖） ============
// 关键点：① 用 TextDecoder({stream:true}) 增量解码，跨 chunk 的 UTF-8 多字节不会截断；
//         ② 按 \n 切行并保留末尾半行；③ SSEParser 跨行累积 event/data，遇空行聚合出一个事件。

class SSEParser {
  private event: string | null = null;
  private data: string[] = [];
  // 返回 null 表示尚未聚合完整事件；返回 {event,data} 表示该事件已就绪
  push(line: string): { event: string | null; data: string } | null {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      if (!this.event && this.data.length === 0) return null;
      const sse = { event: this.event, data: this.data.join('\n') };
      this.event = null;
      this.data = [];
      return sse;
    }
    if (line.startsWith(':')) return null; // SSE 注释行，忽略
    const idx = line.indexOf(':');
    if (idx === -1) return null;
    const field = line.slice(0, idx);
    let value = line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    return null;
  }
}

// 从响应体流逐个产出 SSE 事件（已切行 + 聚合；不含 [DONE]/JSON 解析，交给消费方）
async function* sseMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; data: string }> {
  const td = new TextDecoder();
  let buf = '';
  const reader = body.getReader();
  const parser = new SSEParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += td.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const ev = parser.push(line);
        if (ev) yield ev;
      }
    }
    buf += td.decode(); // flush 残留半行
    if (buf) {
      const ev = parser.push(buf);
      if (ev) yield ev;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已结束 */
    }
  }
}

// ============ llm 对象（chat 为流式唯一入口；由 hooks 工具在注册时经 wrapHook 包裹） ============
export const llm = {
  _abort: null as AbortController | null,

  // 首类取消：中断在途请求（停止按钮调用）
  cancel(): void {
    this._abort?.abort();
    this._abort = null;
  },

  // 核心：流式调用 /chat/completions。零依赖自实现 SSE（基于 openai SDK 的解析思路），逐 yield 文本/思考/工具增量；
  // 结束 return 完整 ChatResult。入参 body 为已构建的请求体（agent.engine 组装，系统提示预置为 messages[0]）；
  // deps 由 agent 传入（apiKey/baseURL），llm 不反向依赖 agent。
  chat: async function* (body: ChatRequestBody, deps: LlmDeps): AsyncGenerator<ChatChunk> {
    if (!deps.apiKey) {
      throw new Error(
        '未配置 API Key：请输入 /gm_storage /action set /key config /update true /value {"apiKey":"你的Key","baseURL":"https://openrouter.ai/api/v1","model":"openrouter/free"}',
      );
    }

    // 内部 AbortController：支持 llm.cancel()
    llm._abort = new AbortController();
    const signal = llm._abort.signal;

    const base = (deps.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = `${base}/chat/completions`;
    // 锁定 stream:true；默认请求 usage（部分厂商需 stream_options 才回传 usage）
    const params = {
      ...body,
      stream: true,
      stream_options: (body as Record<string, unknown>).stream_options ?? { include_usage: true },
    };

    // stream 开始：记录本轮请求目标（与 engine 的「LLM 返回」日志交叉对照）
    console.log('[MiniAgent.LLM] 🌐 开始流式请求', {
      url,
      model: params.model,
      messages: Array.isArray((params as Record<string, unknown>).messages) ? (params.messages as unknown[]).length : 0,
      tools: Array.isArray((params as Record<string, unknown>).tools) ? (params.tools as unknown[]).length : 0,
    });

    const resp: any = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(params),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM 请求失败 ${resp.status}: ${String(text).slice(0, 300)}`);
    }
    if (!resp.body) throw new Error('LLM 响应无 body 流');

    // 聚合状态
    let content = '';
    let reasoningContent = '';
    let finishReason: string | null = null;
    let usage: any = undefined;
    let modelResp: string | undefined = undefined;
    const acc: Record<number, { id: string; name: string; args: string }> = {};

    try {
      for await (const ev of sseMessages(resp.body as ReadableStream<Uint8Array>)) {
        if (ev.data === '[DONE]') break;
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch {
          console.error('[MiniAgent.LLM] 无法解析 SSE data:', ev.data);
          continue;
        }
        if (data && data.error) {
          throw new Error(`LLM 错误: ${data.error.message ?? JSON.stringify(data.error)}`);
        }
        if (data.model) modelResp = data.model;
        if (data.usage) usage = data.usage;
        const choice = data.choices?.[0];
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
          for (const tc of delta.tool_calls) {
            // 缺失 index 时分配到下一空槽（而非强并到 0），避免多个工具调用被错误合并
            let i = tc.index as number | undefined;
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
    } catch (e) {
      // 取消：静默退出，返回已聚合的部分结果（与 SDK 行为一致）
      if (e instanceof Error && e.name === 'AbortError') {
        return buildResult(content, reasoningContent, acc, finishReason, usage, modelResp);
      }
      throw e;
    }

    return buildResult(content, reasoningContent, acc, finishReason, usage, modelResp);
  },
};

// 把聚合状态收成 ChatResult（消除引擎内累加器与 return 值双重累积的漂移）
function buildResult(
  content: string,
  reasoningContent: string,
  acc: Record<number, { id: string; name: string; args: string }>,
  finishReason: string | null,
  usage: any,
  modelResp: string | undefined,
): ChatResult {
  const toolCalls: ToolCallLite[] = Object.values(acc).map((t) => ({
    id: t.id,
    type: 'function',
    function: { name: t.name, arguments: t.args },
  }));
  return { content, reasoningContent, toolCalls, finishReason, usage, model: modelResp };
}

// ============ ReAct 循环封装：把"chat → 执行工具 → 再 chat"收进本模块，引擎只做侵入式改造 ============
// 调用方只需提供：历史 messages、可用 tools、executeTool（执行工具并返回 tool 结果消息）、onChunk（流式 UI 钩子）。
// 内部循环：调 chat 流式 → 无 tool_calls 即结束 return；有则 executeTool → 把结果追加入 messages → 再 chat，直到 maxSteps。
export async function* ReActLoop(opts: {
  messages: ChatMessage[]; // 历史（会被原地追加 assistant / tool 消息）
  tools: ApiTool[];
  systemPrompt?: string;
  model: string;
  deps: LlmDeps;
  maxSteps?: number;
  onChunk?: (c: ChatChunk) => void; // 流式增量钩子（UI 更新等侵入逻辑）
  executeTool: (calls: ToolCallLite[]) => Promise<ChatMessage[]>; // 工具执行器：返回 tool 结果消息
  extraBody?: Record<string, unknown>; // 厂商扩展字段透传（如 reasoning_effort 等），合并进请求体
}): AsyncGenerator<ChatChunk, ChatResult> {
  const max = opts.maxSteps ?? 8;
  for (let step = 0; step < max; step++) {
    const turnMid = genMsgId(); // 本轮助手消息 + 气泡共享的稳定 id（气泡与消息对齐）
    const body: ChatRequestBody = {
      model: opts.model,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
        ...opts.messages,
      ],
      stream: true,
      ...(opts.tools.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
      ...(opts.extraBody ?? {}),
    };
    const result = await driveChat(body, opts.deps, opts.onChunk, step, turnMid);
    // 写回 assistant 消息（含 tool_calls，供下一轮工具循环保留上下文）；id 对齐本轮气泡
    opts.messages.push({
      role: 'assistant',
      content: result.content,
      id: turnMid,
      reasoning_content: result.reasoningContent || undefined,
      tool_calls: result.toolCalls.length ? result.toolCalls : undefined,
    });
    opts.onChunk?.({ done: true, turn: step, mid: turnMid });
    if (!result.toolCalls.length) return result;
    const toolMsgs = await opts.executeTool(result.toolCalls);
    for (const m of toolMsgs) opts.messages.push(m);
  }
  // 超过 maxSteps 保护：返回空结果，由调用方决定后续（通常不应发生）
  return { content: '', toolCalls: [], reasoningContent: undefined, finishReason: 'max_steps', usage: undefined, model: undefined };
}

// 手动驱动 chat 生成器，转发分片给 onChunk，并捕获 return 的 ChatResult（for await 会丢弃 return）。
// turn/mid 透传到每个分片，供调用方按轮次（turn）创建独立气泡、并以 mid 对齐助手消息 id。
async function driveChat(
  body: ChatRequestBody,
  deps: LlmDeps,
  onChunk?: (c: ChatChunk) => void,
  turn?: number,
  mid?: string,
): Promise<ChatResult> {
  const it = llm.chat(body, deps);
  let r = await it.next();
  while (!r.done) {
    onChunk?.({ ...(r.value as ChatChunk), turn, mid });
    r = await it.next();
  }
  return (r.value ?? { content: '', toolCalls: [] }) as ChatResult;
}
