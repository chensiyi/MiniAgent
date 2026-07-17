import { ChatOpenAI } from '@langchain/openai';
import gmFetch from '@sec-ant/gm-fetch';
import { GM_getValue } from '$';
import { DEFAULT_SETTINGS } from '../model/config';

// 直接构造 ChatOpenAI —— 不做二次包装，仅从 GM 存储组装配置并注入 gmFetch 绕 CORS 直连 LLM
export function createLLM(): ChatOpenAI {
  const baseURL = GM_getValue<string>('baseURL', DEFAULT_SETTINGS.baseURL);
  return new ChatOpenAI({
    apiKey: GM_getValue<string>('apiKey', DEFAULT_SETTINGS.apiKey),
    model: GM_getValue<string>('model', DEFAULT_SETTINGS.model),
    streaming: true,
    configuration: {
      baseURL: baseURL || undefined,
      fetch: gmFetch,
      dangerouslyAllowBrowser: true,
    },
  });
}

export function hasApiKey(): boolean {
  return !!GM_getValue<string>('apiKey', '');
}
