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

// 协议里的托管工具事件（web_search / program）也必须被压平，不能原样进历史
const hostedEvents = projectHistoryForClassifier([
  { type: 'message', role: 'user', content: '查一下资料' },
  { type: 'web_search_call', status: 'completed' },
  { type: 'web_search_output', output: '{}' },
  { type: 'program', code: 'print(1)' },
  { type: 'program_output', output: '1' },
  { type: 'message', role: 'assistant', content: '查到了。' },
]);
assert.equal(hostedEvents.length, 2, '托管工具事件不能作为独立消息留下');
assert.equal(hostedEvents[0].content, '查一下资料');
assert.equal(hostedEvents[1].content.includes('- web_search'), true);
assert.equal(hostedEvents[1].content.includes('- program'), true);
assert.equal(
  hostedEvents.some((item) => item.type === 'web_search_call' || item.type === 'program'),
  false,
  '原始工具事件结构不能出现在分类器输入里',
);

// 回执 ID 对不上时不能猜，结果保持未知
const orphanReceipt = projectHistoryForClassifier([
  { type: 'message', role: 'user', content: '继续' },
  {
    type: 'function_call',
    callId: 'c9',
    name: 'write_file',
    arguments: '{"path":"a.md"}',
  },
  { type: 'function_call_output', callId: 'other', output: '{"ok":false}' },
  { type: 'message', role: 'assistant', content: '好了' },
]);
const orphanText = orphanReceipt[1].content;
assert.equal(orphanText.includes('write_file(a.md)'), true);
assert.equal(orphanText.includes('成功'), false, 'ID 对不上时不能标成功');
assert.equal(orphanText.includes('失败'), false, 'ID 对不上时不能把失败记到别的调用上');

// 没有 ID 的旧格式，只能按先后顺序配对
const legacyPairing = projectHistoryForClassifier([
  { type: 'message', role: 'user', content: '继续' },
  { type: 'function_call', name: 'write_file', arguments: '{"path":"a.md"}' },
  { type: 'function_call', name: 'read_file', arguments: '{"path":"b.md"}' },
  { type: 'function_call_output', output: '{"ok":true}' },
  { type: 'function_call_output', output: '{"ok":false}' },
  { type: 'message', role: 'assistant', content: '好了' },
]);
const legacyText = legacyPairing[1].content;
assert.equal(legacyText.includes('write_file(a.md) 成功'), true);
assert.equal(legacyText.includes('read_file(b.md) 失败'), true);

// 记录条数上限：只留最近 12 条，更早的用一句省略带过
const manyCalls = [{ type: 'message', role: 'user', content: '批量' }];
for (let index = 0; index < 15; index += 1) {
  manyCalls.push({
    type: 'function_call',
    callId: `c${index}`,
    name: 'read_file',
    arguments: `{"path":"f${index}.md"}`,
  });
}
manyCalls.push({ type: 'message', role: 'assistant', content: '完成' });
const cappedText = projectHistoryForClassifier(manyCalls)[1].content;
assert.equal(cappedText.includes('较早的 3 次已省略'), true);
assert.equal(
  cappedText.split('\n').filter((line) => line.startsWith('- ')).length,
  12,
  '记录条数必须被截断',
);
assert.equal(cappedText.includes('f0.md'), false, '最旧的调用应被省略');
assert.equal(cappedText.includes('f14.md'), true, '最新的调用必须保留');

// 只带图片没有文字的 user 消息不能被当成空消息丢掉
const imageOnly = projectHistoryForClassifier([
  {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
  },
  { type: 'message', role: 'assistant', content: '看到图了。' },
]);
assert.equal(imageOnly.length, 2, '图片消息不能被丢弃');
assert.equal(Array.isArray(imageOnly[0].content), true);

// 合并相邻同角色消息时，要保留 part 结构，不能拍平成字符串
const mergedParts = projectHistoryForClassifier([
  {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: '第一段', annotations: [] }],
  },
  {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: '第二段' }],
  },
]);
assert.equal(mergedParts.length, 1);
assert.equal(Array.isArray(mergedParts[0].content), true);
assert.equal(mergedParts[0].content[0].annotations.length, 0, '原有 part 元数据要保留');
assert.equal(mergedParts[0].content[1].text, '第二段');

// 后一条消息同时含文本和图片时，合并不能只留文本
const mixedMerge = projectHistoryForClassifier([
  { type: 'message', role: 'user', content: '第一段' },
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: '第二段' },
      { type: 'input_image', image_url: 'data:image/png;base64,BBBB' },
    ],
  },
]);
assert.equal(mixedMerge.length, 1);
const mixedParts = mixedMerge[0].content;
assert.equal(Array.isArray(mixedParts), true);
assert.equal(mixedParts.length, 3);
assert.equal(mixedParts[0].text, '第一段');
assert.equal(mixedParts[1].text, '第二段');
assert.equal(mixedParts[2].type, 'input_image', '图片 part 不能在合并时被丢掉');

// 带 message 字段但不是结构化输出的 JSON 不动
const otherJson = [{ type: 'message', role: 'assistant', content: '{"foo":1}' }];
assert.deepEqual(projectHistoryForClassifier(otherJson), otherJson);

// 坏 JSON 不动，不能抛
const broken = [{ type: 'message', role: 'assistant', content: '{不是 JSON' }];
assert.deepEqual(projectHistoryForClassifier(broken), broken);

console.log('classifier history tests passed');
