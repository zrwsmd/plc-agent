import assert from 'node:assert/strict';
import { projectHistoryForClassifier } from './agent.testbundle.mjs';

// 助手回答在会话里存的是 IndustrialAgentOutput 的裸 JSON。分类器原样吃下它，
// 就会照着这个形状回答，schema 校验必挂，所以喂进去之前要先还原成正文。
const structured = JSON.stringify({
  message: '\n\n当前诗词库共有 13 首。',
  diagnostics: [],
  artifacts: [],
  data: null,
});

const history = [
  { type: 'message', role: 'user', content: '当前有哪些古诗词' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: structured }] },
  { type: 'message', role: 'user', content: '看看关山月这首' },
];
const projected = projectHistoryForClassifier(history);
assert.equal(projected.length, 3);
assert.equal(projected[1].content[0].text, '\n\n当前诗词库共有 13 首。');
assert.equal(projected[0].content, '当前有哪些古诗词');
assert.equal(projected[2].content, '看看关山月这首');
// 原历史不能被就地改写
assert.equal(history[1].content[0].text, structured);

// 落盘形态是双份编码：内容部分本身是一段 JSON 文本
const doubleEncoded = JSON.stringify([{ type: 'output_text', text: structured }]);
const nested = projectHistoryForClassifier([
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: doubleEncoded }] },
]);
assert.equal(nested[0].content[0].text, '\n\n当前诗词库共有 13 首。');

// content 直接是字符串的形态
const stringContent = projectHistoryForClassifier([
  { type: 'message', role: 'assistant', content: structured },
]);
assert.equal(stringContent[0].content, '\n\n当前诗词库共有 13 首。');

// 普通散文不动
const plain = [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] },
];
assert.deepEqual(projectHistoryForClassifier(plain), plain);

// 用户消息不动
const userItem = [{ type: 'message', role: 'user', content: structured }];
assert.deepEqual(projectHistoryForClassifier(userItem), userItem);

// 工具链条目不再原样喂给分类器
const toolOnly = [{ type: 'function_call', name: 'list_files', arguments: '{}' }];
assert.deepEqual(
  projectHistoryForClassifier(toolOnly),
  [],
  '只有工具条目、没有对话时，不凭空构造开头的 assistant 消息',
);

// 工具调用与回执压成一行文本记录，挂在最后一条 assistant 消息上
const withTools = projectHistoryForClassifier([
  { type: 'message', role: 'user', content: '把结果写到文件里' },
  {
    type: 'function_call',
    callId: 'c1',
    name: 'write_file',
    arguments: '{"path":"notes.md","content":"x"}',
  },
  { type: 'function_call_output', callId: 'c1', output: '{"ok":true}' },
  { type: 'message', role: 'assistant', content: '写好了。' },
]);
assert.equal(withTools.length, 2, '工具条目不能作为独立消息留下');
assert.equal(withTools[0].content, '把结果写到文件里');
assert.equal(withTools[1].content.includes('写好了。'), true);
assert.equal(withTools[1].content.includes('write_file(notes.md) 成功'), true);
assert.equal(
  withTools[1].content.includes('不是本轮已经执行'),
  true,
  '记录必须说明这不是本轮已执行',
);

// assistant 带 tool_calls 时，正文要保留，调用字段要摘掉
const assistantWithCalls = projectHistoryForClassifier([
  { type: 'message', role: 'user', content: '继续' },
  {
    type: 'message',
    role: 'assistant',
    content: '我先读一下。',
    tool_calls: [
      { id: 'c2', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'c2', content: '{"ok":false,"error":"missing"}' },
]);
assert.equal(assistantWithCalls.length, 2);
assert.equal(
  assistantWithCalls[1].tool_calls,
  undefined,
  '不能把可执行的工具调用字段喂给分类器',
);
assert.equal(assistantWithCalls[1].content.includes('我先读一下。'), true);
assert.equal(assistantWithCalls[1].content.includes('read_file(a.txt) 失败'), true);

// 带 message 字段但不是结构化输出的 JSON 不动
const otherJson = [{ type: 'message', role: 'assistant', content: '{"foo":1}' }];
assert.deepEqual(projectHistoryForClassifier(otherJson), otherJson);

// 坏 JSON 不动，不能抛
const broken = [{ type: 'message', role: 'assistant', content: '{不是 JSON' }];
assert.deepEqual(projectHistoryForClassifier(broken), broken);

console.log('classifier history tests passed');
