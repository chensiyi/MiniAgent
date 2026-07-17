import { GM_getValue, GM_setValue } from '$';

// 单一配置原型：基础必要变量（主题风格 + api 标准），一块 blob 存、一次读出反序列化
export interface AppConfig {
  theme: 'light' | 'dark';
  apiKey: string;
  model: string;
  baseURL: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'light',
  apiKey: '',
  model: 'gpt-4o-mini',
  baseURL: 'https://api.openai.com/v1',
};

const KEY = 'config';

export function getConfig(): AppConfig {
  const raw = GM_getValue<string>(KEY, '');
  const saved = raw ? JSON.parse(raw) : {};
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(patch: Partial<AppConfig>): void {
  GM_setValue(KEY, JSON.stringify({ ...getConfig(), ...patch }));
}
