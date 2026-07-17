// model 层：本期仅类型与接口占位，不实现（后续阶段）
// 关键依赖：@sec-ant/gm-fetch（把 GM_xmlhttpRequest 包成 fetch，支持流式）

export type Provider = 'openai' | 'openrouter' | 'lmstudio' | 'custom';

export interface ModelConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
}

export interface ModelClient {
  // 后续由 @langchain/openai 的 ChatOpenAI 实现，注入 @sec-ant/gm-fetch 的 fetch
  invoke(prompt: string): Promise<string>;
}

// TODO(后续阶段): 实现 createModel(cfg: ModelConfig): ModelClient
//   - 用 @sec-ant/gm-fetch 产出 fetch 适配器
//   - 传给 ChatOpenAI({ model: cfg.model, apiKey: cfg.apiKey, configuration: { fetch } })
export function createModel(_cfg: ModelConfig): ModelClient {
  throw new Error('model 层尚未实现（见设计稿 §3 延后项）');
}
