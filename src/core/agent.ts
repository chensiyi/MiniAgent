// langchain.js 编排占位（本期不调用真实 LLM，避免拉 node 依赖导致打包/运行失败）
// 后续：import { ChatOpenAI } from '@langchain/openai'; 配合 @sec-ant/gm-fetch 的 fetch 直连 LLM
import type { BaseLanguageModel } from '@langchain/core/language_models/base';

export interface AgentOptions {
  model?: BaseLanguageModel; // 占位：model 层接上后注入
}

// 用 @langchain/core 构建 ReAct agent（tools / memory）—— 后续阶段实现
export function buildAgent(_opts: AgentOptions = {}) {
  return {
    async invoke(_prompt: string): Promise<string> {
      // TODO(后续阶段): 真实调用 model（model 层接上后）
      return '';
    },
  };
}
