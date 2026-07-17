// api 层：本期仅接口占位，不实现（后续阶段）

export interface ProviderApiClient {
  listModels(): Promise<string[]>;
  // 其他 provider API（如 OpenRouter 模型目录）后续补充
}

// TODO(后续阶段): 实现基于 @sec-ant/gm-fetch 的 provider API 客户端
export function createApiClient(_provider: string): ProviderApiClient {
  throw new Error('api 层尚未实现（见设计稿 §3 延后项）');
}
