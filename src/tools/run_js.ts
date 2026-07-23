import type { ToolDef } from '../core/executor';
import { compileBody } from '../core/sandbox';

// 4) 运行代码：自我开发执行入口，经人工确认闸（executor.run base 内）
export const runJsTool: ToolDef = {
  name: 'run_js',
  author: 'sys',
  riskLevel: 'high',
  description: '执行JS代码。危险操作，执行前会请求用户确认。',
  // strict 模式（OpenAI 工具标准）：required 列出全部属性 + additionalProperties:false，模型被约束到该 schema。
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '要执行的 JS 源码。会以 new Function(\'ctx\', ...) 方式运行：函数体内可通过参数 ctx 访问运行时上下文（ctx.storage 存储 / ctx.executor 注册器 / ctx.agent 单例 / ctx.console 沙箱打印）。return 的值将作为执行结果回显。执行前会请求用户确认。',
      },
    },
    required: ['code'],
    additionalProperties: false,
  },
  call: (args, ctx) => {
    const code = args.code as string;
    if (!code || code.length === 0) return '没有可执行的代码';
    try {
      // 经顶层沙箱规范编译（统一 "use strict" + 仅注入 ctx），不再散落裸 new Function
      const fn = compileBody(['ctx'], code);
      const result = fn(ctx);
      return `执行成功 → ${result === undefined ? '(无返回值)' : JSON.stringify(result)}`;
    } catch (e) {
      return `执行异常: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};
