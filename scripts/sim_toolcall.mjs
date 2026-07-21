// 仿真：还原 llm.ts 的 SSE 解析（含新 index 兜底逻辑）
// 目标：验证「思考/推理内容」与「content」与工具调用参数交错时工具调用能完整拼装，
//       且缺失 index 的多个工具调用不会被错误合并到 0 号槽。

// 还原 llm.ts streamChat 的解析（与新逻辑一致）
function parseSSE(sse) {
  let buf = '';
  let content = '';
  let reasoning = '';
  const acc = {};
  const feed = (valueStr) => {
    buf += valueStr;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (!delta) continue;
      if (delta.content) content += delta.content;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) reasoning += r;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          // 新逻辑：缺失 index 时分配到下一空槽，而非强并到 0
          let i = tc.index;
          if (i == null) i = Object.keys(acc).length;
          acc[i] ??= { id: '', name: '', args: '' };
          if (tc.id) acc[i].id = tc.id;
          if (tc.function?.name) acc[i].name = tc.function.name;
          if (tc.function?.arguments) acc[i].args += tc.function.arguments;
        }
      }
    }
  };
  // 切成不连续物理 chunk 再喂（含把一行从中间切断）
  const cuts = [12, 57, 130, 200, 260, 340, 430, 500, 600, sse.length];
  let i = 0;
  for (const c of cuts) { feed(sse.slice(i, c)); i = c; }
  feed('');
  const toolCalls = Object.values(acc).map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } }));
  return { content, reasoning, toolCalls };
}

const line = (obj) => 'data: ' + JSON.stringify(obj) + '\n';

// 工厂：构造 SSE 事件
const reasoningEv = (txt) => line({ choices: [{ delta: { reasoning_content: txt }, finish_reason: null }] });
const contentEv = (txt) => line({ choices: [{ delta: { content: txt }, finish_reason: null }] });
// 工具调用事件：index 可为 undefined（缺 index 场景）；args 为参数字符串片段
const toolEv = (index, id, name, args) => {
  const call = { function: { name, arguments: args } };
  if (id != null) call.id = id;
  if (index != null) call.index = index;
  return line({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] });
};
const finishEv = () => line({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
const done = () => 'data: [DONE]\n';

let allOk = true;
const run = (title, sse, assert) => {
  const res = parseSSE(sse);
  console.log('\n=== ' + title + ' ===');
  console.log('content   =', JSON.stringify(res.content));
  console.log('reasoning =', JSON.stringify(res.reasoning));
  console.log('toolCalls =', JSON.stringify(res.toolCalls));
  for (const [name, pass] of assert(res)) { console.log((pass ? '✅' : '❌') + ' ' + name); if (!pass) allOk = false; }
};

// ---- 场景1：标准流（index 完整），推理与 content 与工具参数交错 ----
const sse1 =
  reasoningEv('让我先想一下…') +
  reasoningEv('需要查下工具。') +
  contentEv('好的，我来调用工具。') +
  toolEv(0, 'call_1', 'gm_storage', '{"act') +
  reasoningEv('（参数还没拼完）') +
  toolEv(0, null, null, 'ion":"get","key') +
  toolEv(0, null, null, '":"foo"}') +
  toolEv(1, 'call_2', 'tool_manager', '{"action":"list"}') +
  finishEv() +
  done();
run('标准流：推理/content/工具参数交错', sse1, (r) => ([
  ['content 完整', r.content === '好的，我来调用工具。'],
  ['reasoning 完整', r.reasoning === '让我先想一下…需要查下工具。（参数还没拼完）'],
  ['工具数=2', r.toolCalls.length === 2],
  ['call_1 名', r.toolCalls[0]?.function?.name === 'gm_storage'],
  ['call_1 参数可解析', (() => { try { return JSON.parse(r.toolCalls[0].function.arguments).action === 'get'; } catch { return false; } })()],
  ['call_2 名', r.toolCalls[1]?.function?.name === 'tool_manager'],
  ['call_2 参数完整', r.toolCalls[1]?.function?.arguments === '{"action":"list"}'],
]));

// ---- 场景2：缺失 index 的多个工具调用（非兼容端风险点）----
const sse2 =
  toolEv(null, 'a', 'gm_storage', '{"x":1}') +
  toolEv(null, 'b', 'tool_manager', '{"y":2}') +
  finishEv() +
  done();
run('缺 index 的多个工具调用（不应合并到 0 号）', sse2, (r) => ([
  ['工具数=2（未合并）', r.toolCalls.length === 2],
  ['槽0 名=gm_storage', r.toolCalls[0]?.function?.name === 'gm_storage'],
  ['槽1 名=tool_manager', r.toolCalls[1]?.function?.name === 'tool_manager'],
  ['槽0 参数', r.toolCalls[0]?.function?.arguments === '{"x":1}'],
  ['槽1 参数', r.toolCalls[1]?.function?.arguments === '{"y":2}'],
]));

console.log(allOk ? '\n✅ 全部通过：工具调用在交错流与缺 index 场景下均完整加载。' : '\n❌ 存在异常！');
process.exit(allOk ? 0 : 1);
