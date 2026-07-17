// model 配置：GM 存储键的默认值与类型（SettingsModal 写、core/llm 读，单一来源）
export interface ModelSettings {
  apiKey: string;
  model: string;
  baseURL: string;
}

export const DEFAULT_SETTINGS: ModelSettings = {
  apiKey: '',
  model: 'gpt-4o-mini',
  baseURL: 'https://api.openai.com/v1',
};
