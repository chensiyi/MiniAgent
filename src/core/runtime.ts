import { buildAgent } from './agent';

export interface ToolCallResult {
  id: string;
  toolName: string;
  status: 'done' | 'error';
  result?: string;
}

export interface RuntimeReply {
  text: string;
  toolCalls?: ToolCallResult[];
}

// 运行时自组织占位：后续接入 langchain agent executor + tools + memory
export function createRuntime() {
  buildAgent(); // 占位，暂不调用真实 LLM
  return {
    async run(input: string): Promise<RuntimeReply> {
      // TODO(后续阶段): 真实 agent loop（消费 model 层）在此实现
      return {
        text: '(骨架占位) 已收到：' + input + ' —— 接入 model 层后即可真实应答。',
      };
    },
  };
}
