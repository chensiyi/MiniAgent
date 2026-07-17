import { ChatOpenAI } from '@langchain/openai';
import gmFetch from '@sec-ant/gm-fetch';
import { getConfig } from '../model/config';

// 直接构造 ChatOpenAI —— 配置一次性从 config blob 取，不做二次包装
export function createLLM(): ChatOpenAI {
  const { apiKey, model, baseURL } = getConfig();
  return new ChatOpenAI({
    apiKey,
    model,
    streaming: true,
    configuration: {
      baseURL: baseURL || undefined,
      fetch: gmFetch,
      dangerouslyAllowBrowser: true,
    },
  });
}
