import type { ToolDef, DepRef, ToolDesc } from '../core/executor';
import { buildToolFromDesc } from '../core/sandbox';
import {
  executor,
  resolveToolDesc,
  resolveLibUrls,
  fetchLibText,
  b64Encode,
} from '../core/executor';
import { SYS_AUTHOR } from '../core/keys';
import { storage, NS } from '../core/storage';

// ---- 工具导出（序列化）能力：从持久化/运行期描述符生成可重注册的 JS / 安装命令 ----
// 这类"导出/序列化"辅助属于 tool_manager 的导出特性，不属 executor 基础注册能力
// （2026-07-22 从 executor 迁入；与基础能力 register/unregister/list/delete/setEnabled 分离）。

// 把多行 JSON 续行缩进到统一 pad，便于原样嵌进对象字面量（仅影响缩进，不改语义）。
function indentBlock(s: string, pad: string): string {
  return s.split('\n').map((l, i) => (i === 0 ? l : pad + l)).join('\n');
}

// 把一个工具定义/描述符导出为可直接注册的 JS 源码（控制台粘贴即用）。
// 导出一个自包含 IIFE 片段 —— 用 new Function 把持久化的源码串编译回函数
//   （call/register/unregister；含安装期内联的库 IIFE），再 executor.register + 持久化到 tools 命名空间，
//   使其重载后仍能自动重建。自编排工具（含内联库）因此真正"可独立重注册"。
function exportToolToJs(desc: ToolDesc): string {
  const header = [
    `// MiniAgent 工具导出：${desc.name}`,
    '// 复制以下代码到浏览器控制台（agent 需在作用域，如 globalThis.agent）执行即可注册并持久化该工具。',
    '// 自编排工具含安装期内联依赖库（/libs），导出即自包含、可独立重注册；重载按描述符自动重建。',
  ].join('\n');
  const parts: string[] = [];
  parts.push('(function () {');
  parts.push('  const agent = globalThis.agent;');
  parts.push('  const executor = agent && agent.executor;');
  parts.push('  const storage = agent && agent.storage;');
  parts.push('  if (!executor) { console.error("[MiniAgent] 导出注册失败：agent.executor 不可用"); return; }');
  // 把持久化"源码串"编译回函数（call/register/unregister 皆为可重编译文本，含内联库 IIFE）
  parts.push("  const buildFn = (src) => src ? new Function('\"use strict\"; return (' + src + ');')() : undefined;");
  parts.push('  const desc = {');
  parts.push(`    name: ${JSON.stringify(desc.name)},`);
  parts.push(`    author: ${JSON.stringify(desc.author ?? SYS_AUTHOR)},`);
  parts.push(`    description: ${JSON.stringify(desc.description)},`);
  parts.push(`    parameters: ${indentBlock(JSON.stringify(desc.parameters ?? {}, null, 2), '    ')},`);
  if (desc.deps && desc.deps.length) parts.push(`    deps: ${indentBlock(JSON.stringify(desc.deps, null, 2), '    ')},`);
  if (desc.riskLevel) parts.push(`    riskLevel: ${JSON.stringify(desc.riskLevel)},`);
  parts.push(`    code: ${desc.code},`);
  if (desc.register) parts.push(`    register: ${desc.register},`);
  if (desc.unregister) parts.push(`    unregister: ${desc.unregister},`);
  parts.push(`    enabled: ${desc.enabled === false ? 'false' : 'true'},`);
  parts.push('  };');
  parts.push('  const tool = { ...desc, call: buildFn(desc.code), register: buildFn(desc.register), unregister: buildFn(desc.unregister) };');
  parts.push('  executor.register(tool);'); // 注册（含依赖校验/同名替换）
  parts.push(`  if (storage) storage.set(${JSON.stringify(NS.TOOLS)}, desc.name, desc);`); // 持久化（含内联库源码，重载自动重建）
  parts.push('  console.log("[MiniAgent] 已注册并持久化工具:", desc.name);');
  parts.push('})();');
  return header + '\n' + parts.join('\n');
}

// 把一个工具描述符导出为"手动安装命令"格式：/tool_manager /action register /name ... /code ...
// 与 parseToolCommand（agent.ts）的解析规则严格对齐：
//   - /code 值经 base64 编码（b64: 前缀）输出，字符集不含空格，含引号/斜杠/换行均安全；
//     彻底解耦"未加引号值读到行尾"的脆弱约定（见 b64Decode / parseToolCommand）。
//   - 对象/数组值（parameters/deps）用紧凑 JSON（无多余空格），解析器识别 {…}/[…] 走 JSON.parse；
//   - description 用双引号包裹（读到匹配引号）。
// 说明：命令格式无法可靠承载多个函数体，含 register/unregister 安装钩子的工具请改用 export（raw JS）。
function exportToolToCmd(desc: ToolDesc): string | { error: string } {
  if (desc.register || desc.unregister) {
    return { error: `工具 ${desc.name} 含 register/unregister 安装钩子，命令格式无法承载多个函数体；请改用 export（raw JS）导出。` };
  }
  const parts: string[] = ['/tool_manager', '/action', 'register'];
  parts.push('/name', desc.name);
  if (desc.author && desc.author !== SYS_AUTHOR) parts.push('/author', desc.author);
  if (desc.riskLevel) parts.push('/riskLevel', desc.riskLevel);
  parts.push('/enabled', desc.enabled === false ? 'false' : 'true');
  parts.push('/parameters', JSON.stringify(desc.parameters ?? { type: 'object', properties: {} }));
  if (desc.deps && desc.deps.length) parts.push('/deps', JSON.stringify(desc.deps));
  parts.push('/description', '"' + desc.description + '"');
  // /code 经 base64 编码（b64: 前缀）输出：彻底解耦"必须放最后读到行尾"的脆弱约定，
  // 引号/斜杠/换行均安全；解析端（agent.ts parseToolCommand）识别 b64: 前缀解码，无前缀则回退原行尾逻辑（向后兼容）。
  parts.push('/code', 'b64:' + b64Encode(desc.code));
  return parts.join(' ');
}

// ============================================================
// 工具生命周期管理器（2026-07-25 从 executor 迁入）
// 内核 executor 只做哑注册表；预装宇宙 / bootstrap / 启停 / 重建 全部收归本模块。
// 设计（遵循用户定调的 boot(baseTools, allTools) 两列表模型）：
//  - 依赖关系只活在工具自身的 deps 图（hooks ← gm_storage ← ui），由 registerAll 内部拓扑序处理，不另设优先级层；
//  - baseTools：基础能力（hooks / 存储），始终先注册（须在读取 disabledTools 前建立存储/配置镜像），不可经开关关闭；
//  - allTools：完整预装（默认工具 + 环境层工具 ui），按 disabledTools 黑名单过滤后注册；
//  - bootstrap：先注册 baseTools（去重）→ 镜像外部存储后才读 disabledTools → 再按黑名单过滤注册 allTools → 重建用户工具；
//  - getStates：以 baseTools+allTools 宇宙 + 用户描述符为真相源构建完整清单（已注册=启用）。
// ============================================================

// 预装宇宙（宿主层经 definePreset 注入）：拆分为 baseTools（基础能力，始终先注册）与 allTools（完整预装，按黑名单过滤）。
let baseTools: ToolDef[] = [];
let allTools: ToolDef[] = [];

// 取已绑定 agent（executor 暴露，避免循环依赖）。
function getAgent() {
  return executor.getAgent();
}

// 宿主层注入预装宇宙（dev 按 boot(baseTools, allTools) 两列表拼装后调用一次）。
export function definePreset(base: ToolDef[], all: ToolDef[]): void {
  baseTools = base;
  allTools = all;
}

// 重建自管理工具：读 tools 命名空间全部描述符 → 过滤启用项 → 构造 ToolDef → registerAll（拓扑序）。
// 注册即重建：重建逻辑天然写在各工具的 register 里。
// 同时尊重 disabledTools 黑名单（§3：黑名单内的工具即便描述符 enabled=true 也不进 boot）。
function rehydrate(): void {
  const agentRef = getAgent();
  const disabled = new Set(agentRef?.config.disabledTools ?? []);
  const descs = storage.listToolDefs();
  const tools: ToolDef[] = [];
  for (const desc of descs) {
    if (desc.enabled === false || disabled.has(desc.name)) continue; // §3：关闭项不进 boot
    try {
      tools.push(buildToolFromDesc(desc));
    } catch (e) {
      console.warn('[MiniAgent] 重建工具失败:', desc.name, e);
    }
  }
  const { registered, rejected } = executor.registerAll(tools);
  if (rejected.length) console.warn('[MiniAgent] 部分工具未注册（依赖缺失/循环）:', rejected);
  else console.log('[MiniAgent] 重建工具:', registered);
}

// 启动编排：先注册 baseTools（去重）→ 镜像外部存储后才读 disabledTools → 再按黑名单过滤注册 allTools → 重建用户工具。
// 关键时序：disabledTools 必须等 gm_storage 把 GM_* 镜像进内存后才读，否则刷新后黑名单失效。
// 仅用工具自身的 deps 拓扑（hooks ← gm_storage ← ui），不再有人为优先级层。
export function bootstrap(): void {
  const registeredNames = new Set(executor.list(true).map((t) => t.name));
  // ① baseTools：基础能力始终先注册（建立存储/配置镜像，须在读取 disabledTools 之前）；已注册的去重跳过。
  executor.registerAll(baseTools.filter((t) => !registeredNames.has(t.name)));
  const agentRef = getAgent();
  const disabled = new Set(agentRef?.config.disabledTools ?? []); // ② 镜像后才读配置（否则刷新后黑名单失效）
  // ③ allTools：按 disabledTools 黑名单过滤（已注册/禁用的跳过），拓扑序注册。
  executor.registerAll(allTools.filter((t) => !disabled.has(t.name) && !registeredNames.has(t.name)));
  rehydrate(); // ④ 重建用户保存的自编排工具（同样尊重 disabledTools）
}

// 完整工具清单（含启用态），供 UI 启停面板渲染。以 baseTools+allTools 宇宙 + 用户描述符为真相源：
// 已注册=启用；预装中未注册=关闭（可重新启用）；用户描述符中未在预装的=自管理工具。
export function getStates(): { name: string; author?: string; enabled: boolean; builtin: boolean; description?: string }[] {
  const registeredNames = new Set(executor.list(true).map((t) => t.name));
  const universe = new Map<string, { name: string; author?: string; description?: string; builtin: boolean }>();
  for (const t of [...baseTools, ...allTools]) {
    universe.set(t.name, { name: t.name, author: t.author, description: t.description, builtin: true });
  }
  for (const desc of storage.listToolDefs()) {
    if (!universe.has(desc.name)) {
      universe.set(desc.name, { name: desc.name, author: desc.author, description: desc.description, builtin: false });
    }
  }
  const states: { name: string; author?: string; enabled: boolean; builtin: boolean; description?: string }[] = [];
  for (const u of universe.values()) {
    states.push({ name: u.name, author: u.author, enabled: registeredNames.has(u.name), builtin: u.builtin, description: u.description });
  }
  return states.sort((a, b) => a.name.localeCompare(b.name));
}

// 启停：自管理工具改 tools:<name>.enabled 并持久化；内置工具改 config.disabledTools 黑名单并持久化；均即时 register/unregister。
// 关闭 UI 是风险操作：须经确认闸；baseTools（基础能力）拒绝关闭（始终保持在线，否则存储/钩子根基崩塌）。
export async function setEnabled(name: string, enabled: boolean): Promise<void> {
  const bt = [...baseTools, ...allTools].find((t) => t.name === name);
  if (baseTools.some((t) => t.name === name)) {
    console.warn('[MiniAgent] 基础工具不可关闭（始终保持在线）:', name);
    return;
  }
  if (!enabled && name === 'ui') {
    const ok = await executor.requestApproval({ name: 'ui.disable（关闭界面）', riskLevel: 'high' }, getAgent() ?? undefined);
    if (!ok) return;
  }
  const desc = storage.get<ToolDesc>('tools', name);
  if (desc) {
    desc.enabled = enabled;
    storage.set(NS.TOOLS, name, desc);
  } else {
    const set = new Set(getAgent()?.config.disabledTools ?? []);
    if (enabled) set.delete(name);
    else set.add(name);
    const a = getAgent();
    if (a) { a.config.disabledTools = [...set]; } // setter 触发 gm_storage 落盘钩子
  }
  if (enabled) {
    if (desc) {
      try {
        executor.register(buildToolFromDesc(desc));
      } catch (e) {
        console.warn('[MiniAgent] 重注册失败:', name, e);
      }
    } else if (bt) {
      executor.register(bt);
    }
  } else {
    executor.unregister(name);
  }
}

// 删除工具：经用户确认闸后，移除持久化描述符并注销运行期注册；
// 内置（sys）工具无 tools 命名空间描述符，删除后追加到 disabledTools 黑名单，重载不回注（避免"删了又回来"）。
// remove / delete 两个 action 共用此实现，语义一致。
export async function deleteTool(name: string): Promise<string> {
  const agentRef = getAgent();
  const confirmed = await executor.requestApproval({ name: `tool_manager.delete(${name})`, riskLevel: 'high' }, agentRef ?? undefined);
  if (!confirmed) return '已取消';
  const persisted = storage.get<ToolDesc>('tools', name);
  if (persisted) {
    storage.del(NS.TOOLS, name); // 移除持久化（自管理工具真相源）
  } else {
    // 内置工具：无 tools 命名空间描述符 → 追加黑名单，重载不回注
    const set = new Set(agentRef?.config.disabledTools ?? []);
    set.add(name);
    if (agentRef) { agentRef.config.disabledTools = [...set]; } // setter 触发 gm_storage 落盘钩子
  }
  executor.unregister(name); // 移除运行期注册（含还原其 register/unregister 编排）
  return `已删除工具 ${name}`;
}

// 统一管理器对象（宿主层 / UI 经 MiniAgent.toolManager 调用）。
export const toolManager = {
  definePreset,
  bootstrap,
  getStates,
  setEnabled,
  deleteTool,
  rehydrate,
};

// 5) 统一的工具自编排管理（整合原 tool_register/tool_remove/tool_list）
//    action 区分操作：register=注册/创建 / remove=删除 / list=枚举。
export const toolManagerTool: ToolDef = {
  name: 'tool_manager',
  author: 'sys',
  description: '统一的工具自编排管理。action 取值：register=注册/创建新工具（持久化到 tools 命名空间，重载按依赖拓扑自动重建；code 为 call 源码，register 可选为安装源码；默认停用，enabled=true 立即启用）；remove/delete=删除工具（移除持久化并注销；内置工具删除后加入黑名单，重载不回注）；list=枚举当前所有已注册工具（含无 call 的系统原语，默认全量；传 all=false 仅列可被 LLM 调用的工具），供查看完整能力面；export=导出工具为可直接注册的 raw JS 代码（控制台粘贴即用）；export_cmd=导出工具为手动安装命令（/tool_manager /action register …，聊天输入框粘贴即用；含 register/unregister 安装钩子的工具不支持，请改用 export）。注：自编排工具导出自包含（含 /libs 内联库）；内置（sys）工具导出的 call 来自函数反编译，可能引用模块内部状态，仅作查看/参考，不保证可独立运行；list_disabled=列出所有已停用的自编排工具。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['register', 'remove', 'delete', 'list', 'export', 'export_cmd', 'list_disabled'],
        description: '操作类型：register=创建/注册新工具（持久化到 tools 命名空间，重载按依赖拓扑自动重建；默认停用，enabled=true 立即启用）；remove/delete=删除工具（注销并移除持久化；内置工具删除后加入黑名单，重载不回注）；list=枚举当前所有已注册工具（含无 call 的系统原语，默认全量；传 all=false 仅列可被 LLM 调用的工具）；export=导出工具为 raw JS 代码（控制台粘贴即用）；export_cmd=导出工具为手动安装命令（/tool_manager /action register …，输入框粘贴即用；含安装钩子的工具不支持）；两者内置（sys）工具的 call 均来自函数反编译，可能引用模块内部状态，仅作查看/参考；list_disabled=列出所有已停用（未启用）的自编排工具。',
      },
      name: { type: 'string', description: '工具名（register/remove/delete/export/export_cmd 必需）。按 name 匹配（注册时与 author 组合成唯一标识）。' },
      author: { type: 'string', description: `可选作者名（默认 "${SYS_AUTHOR}"；与 name 组合唯一；覆盖既有工具即替换，需用户确认）。` },
      description: { type: 'string', description: '工具说明（register 必需），会展示给 LLM 作为该工具的能力描述。' },
      parameters: {
        type: 'object',
        description: '新工具的参数声明（JSON Schema，register 必需）。格式如 { type:"object", properties: { 参数名: { type, description, ... } }, required: ["参数名"], additionalProperties:false }，会直接传给 LLM 决定如何调用（strict 模式：required 必须列全部属性）。',
      },
      deps: { type: 'array', description: '可选前置依赖，元素形如 { name, author?, version? }；按 name 匹配，author 不符仅警告、缺失则拒绝注册。' },
      riskLevel: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: '可选风险级别：low=无摩擦；medium=中等；high=执行/删除等破坏性操作前弹确认框；critical=最高风险。默认 low。',
      },
      code: { type: 'string', description: 'call 源码（register 必需），签名为 (args, ctx) => string，返回字符串作为工具观察结果回灌 LLM。' },
      register: { type: 'string', description: '可选：安装/重建源码 (ctx) => void（register 用），在工具注册时执行（如挂载钩子、注入编排），重载会自动重建。' },
      libs: { type: 'string', description: '可选：安装期要内联进工具自身的外部 JS 库，逗号分隔。形如 marked / dompurify（别名）/ marked@12/marked.min.js（CDN 路径）/ 完整 URL。默认外国 CDN 链（jsDelivr / unpkg / cdnjs）；每库在安装期 fetch 源码并内联进 code（工具自此自包含、离线可用）。任一库下载失败则中断安装。' },
      enabled: { type: 'boolean', description: '可选：注册后是否立即启用（进 LLM 工具清单、可被调用）。默认 false（注册后处于停用状态，可在聊天 ⚙ 工具面板或 setEnabled 开启）；传 true 则注册后立即启用。' },
      all: { type: 'boolean', description: 'list 动作专用：是否枚举全量工具。默认 true（=全量，含无 call 的系统原语）；传 false 则仅列出可被 LLM 调用的工具（typeof call===\'function\'）。' },
    },
    required: ['action'],
  },
  call: async (args, ctx) => {
    const action = String(args.action ?? '');
    switch (action) {
      case 'register': {
        const name = String(args.name ?? '');
        if (!name) return '参数 name 缺失';
        const authorArg = args.author ? String(args.author) : SYS_AUTHOR;
        const enabled = args.enabled === true; // 默认停用（§3：关闭项留 ns、不注册）
        // 安装期依赖库 fetch + 内联（"用内容替换自己"）：默认 jsDelivr，失败则中断安装并提示
        const libsSpec = args.libs ? String(args.libs) : '';
        const codeRaw = String(args.code ?? '');
        if (!codeRaw.trim()) return '参数 code 缺失（register 必需，call 源码）';
        let code = codeRaw;
        if (libsSpec) {
          const specs = libsSpec.split(',').map((s) => s.trim()).filter(Boolean);
          const sources: string[] = [];
          for (const spec of specs) {
            const urls = resolveLibUrls(spec);
            try {
              const src = await fetchLibText(urls);
              sources.push('// === 内联依赖库: ' + spec + ' @ ' + urls[0] + ' ===\n' + src);
            } catch (e) {
              return `依赖库下载失败（${spec} → ${urls.join(' | ')}）：${e instanceof Error ? e.message : e}\n可改用完整 URL 或可用外国镜像（如 https://unpkg.com/...）。`;
            }
          }
          if (sources.length && code.trim()) {
            // 包成 IIFE 表达式：库源码在 IIFE 作用域内执行（UMD 走 globalThis 兜底挂载），返回真正的 call 箭头
            code = '(function(){\n' + sources.join('\n') + '\nreturn (' + code + ');\n})()';
          }
        }
        const desc: ToolDesc = {
          name,
          author: authorArg,
          description: String(args.description ?? ''),
          parameters: (args.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
          deps: (args.deps as DepRef[]) ?? undefined,
          riskLevel: (args.riskLevel as ToolDesc['riskLevel']) ?? undefined,
          code, // 已内联依赖库源码（安装期 fetch 结果）
          register: args.register ? String(args.register) : undefined,
          enabled,
        };
        let tool: ToolDef;
        try {
          tool = buildToolFromDesc(desc);
        } catch (e) {
          return `工具代码编译失败: ${e instanceof Error ? e.message : String(e)}`;
        }
        // 经用户确认后更新（用户 2026-07-20："所有工具均可经用户确认后更新"）。
        // 闸门=用户确认，author 不再作为编辑限制；同名则先注销旧再注册新 → systool 可被用户替换。
        // 确认框展示用户原始 code（不含内联库源码，避免冗长）
        const confirmed = await executor.requestApproval({ name: `tool_manager.register(${name})`, code: String(args.code ?? ''), riskLevel: 'high' }, ctx.agent);
        if (!confirmed) return '已取消';
        ctx.storage.set(NS.TOOLS, name, desc); // 持久化（真相源，含内联库）
        // 默认停用：仅持久化、不进运行期注册表（不进 LLM 清单、不可调用）；enabled=true 才注册（含依赖校验；同名则替换）
        if (!enabled) return `已创建工具 ${name}（依赖已内联，已持久化；当前为停用状态，可在 ⚙ 工具面板或 setEnabled 开启）`;
        const ok = ctx.executor.register(tool);
        return ok ? `已创建工具 ${name}（依赖已内联，已持久化 + 已启用）` : `工具 ${name} 已持久化，但注册被拒（依赖缺失或 author 冲突），仍处于停用状态`;
      }
      case 'remove':
      case 'delete': {
        const name = String(args.name ?? '');
        if (!name) return '参数 name 缺失';
        return deleteTool(name);
      }
      case 'list': {
        const all = ctx.executor.list(args.all !== false); // 默认全量（true）
        return JSON.stringify(
          all.map((t) => ({
            name: t.name,
            author: t.author ?? SYS_AUTHOR,
            description: t.description,
            deps: t.deps ?? [],
            riskLevel: t.riskLevel ?? 'low',
            call: typeof t.call === 'function',
            register: typeof t.register === 'function',
          })),
        );
      }
      case 'list_disabled': {
        // 列出持久化（tools 命名空间）中处于停用状态的工具：register 默认停用（enabled=false），或经 setEnabled(false) 关闭。
        const disabled = ctx.storage.listToolDefs().filter((d) => d.enabled === false);
        if (disabled.length === 0) return '当前没有停用的工具';
        return JSON.stringify(
          disabled.map((d) => ({
            name: d.name,
            author: d.author ?? SYS_AUTHOR,
            description: d.description,
            deps: d.deps ?? [],
            riskLevel: d.riskLevel ?? 'low',
          })),
        );
      }
      case 'export': {
        const name = String(args.name ?? '');
        if (!name) return '参数 name 缺失';
        const desc = resolveToolDesc(name);
        if (!desc || !desc.code) return `未找到可导出的工具: ${name}`;
        // 默认导出 raw JS（控制台粘贴即用），以 markdown 代码块包裹便于复制。
        return '```js\n' + exportToolToJs(desc) + '\n```';
      }
      case 'export_cmd': {
        const name = String(args.name ?? '');
        if (!name) return '参数 name 缺失';
        const desc = resolveToolDesc(name);
        if (!desc || !desc.code) return `未找到可导出的工具: ${name}`;
        // 导出手动安装命令（聊天/输入框粘贴即用），与 parseToolCommand 解析规则对齐。
        const cmd = exportToolToCmd(desc);
        if (typeof cmd !== 'string') return cmd.error;
        return '```\n' + cmd + '\n```';
      }
      default:
        return `未知 action: ${action}（支持 register/remove/delete/list/export/export_cmd/list_disabled）`;
    }
  },
};
