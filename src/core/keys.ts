// 存储键集中定义（单一真相源）。
// 内核所有 storage 读写一律引用本文件常量，禁止在业务逻辑里散落硬编码字符串。
//
// 分类：
//  - NS_FLAT         ：扁平键命名空间（空串），realKey('', key) === key
//  - NS.*            ：命名空间（ns:key 形式，如 tools:<name> / hooks:<id> / session:<id> / memory:<key> / code:<key>）
//  - FLAT.*          ：扁平键（无 ns 前缀：config / baseRequestBody / sessions）；用户在 Tampermonkey 数值(Values)里可直接看到并编辑
//  - OVERVIEW_NS     ：gm_storage list 无 ns 参数时列出的命名空间清单
//  - LEGACY.*        ：旧 default: 命名空间下的键，仅供一次性迁移读取，新代码禁止写入

// 扁平键命名空间（空字符串）
export const NS_FLAT = '';

// 命名空间
export const NS = {
  TOOLS: 'tools',
  HOOKS: 'hooks',
  SESSION: 'session',
  MEMORY: 'memory',
  CODE: 'code',
} as const;

// 扁平键（无 ns 前缀）
export const FLAT = {
  CONFIG: 'config',
  BASE_REQUEST_BODY: 'baseRequestBody',
  SESSIONS: 'sessions',
} as const;

// gm_storage list 概览要列出的命名空间
export const OVERVIEW_NS: string[] = [NS.SESSION, NS.TOOLS, NS.CODE, NS.MEMORY];

// 历史遗留键（旧 default: 命名空间）。值为 { ns, key }，仅供迁移读取。
export const LEGACY = {
  CONFIG: { ns: 'default', key: 'config' },
  BASE_REQUEST_BODY: { ns: 'default', key: 'baseRequestBody' },
  SESSIONS: { ns: 'default', key: 'sessions' },
} as const;
