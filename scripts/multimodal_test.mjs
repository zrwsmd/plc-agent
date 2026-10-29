import assert from 'node:assert/strict';
import {
  normalizeImageAttachments,
  supportsVision,
  userMessageInputToAgentItem,
  validateUserMessageInput,
} from './agent.testbundle.mjs';

const image = {
  name: 'screen.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,aGVsbG8=',
};

assert.equal(supportsVision({ provider: 'openai', apiFormat: 'responses', baseUrl: '', model: 'gpt-4o-mini' }), true);
assert.equal(supportsVision({ provider: 'openai', apiFormat: 'chat_completions', baseUrl: 'http://gateway/v1', model: 'private-chat' }), false);
assert.equal(supportsVision({ provider: 'openai', apiFormat: 'chat_completions', baseUrl: 'http://gateway/v1', model: 'private-chat', visionMode: 'enabled' }), true);

const normalized = normalizeImageAttachments([image, { ...image, mimeType: 'image/bmp' }]);
assert.equal(normalized.length, 1);
const input = userMessageInputToAgentItem({ text: '请看图', images: [image] });
assert.equal(input.type, 'message');
assert.equal(input.role, 'user');
assert.deepEqual(
  (input.content ?? []).map((part) => part.type),
  ['input_text', 'input_text', 'input_image'],
);
assert.equal(validateUserMessageInput({ text: '请看图', images: [image] }, {
  provider: 'openai',
  apiFormat: 'responses',
  baseUrl: '',
  model: 'gpt-4o-mini',
}), undefined);
assert.match(
  validateUserMessageInput({ text: '请看图', images: [image] }, {
    provider: 'openai',
    apiFormat: 'chat_completions',
    baseUrl: 'http://gateway/v1',
    model: 'private-chat',
  }) ?? '',
  /未启用图片/,
);

console.log('multimodal tests passed');
