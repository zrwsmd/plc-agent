import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractChatMessages,
  JsonFileSession,
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

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plc-multimodal-session-'));
const sessionFile = path.join(storageDir, 'session.json');
const session = new JsonFileSession(sessionFile);
await session.addItems([
  input,
  { type: 'message', role: 'assistant', content: '图片已识别' },
]);

const persisted = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
assert.equal(
  JSON.stringify(persisted.displayItems).includes(image.dataUrl),
  false,
  'UI history should reference an attachment file instead of duplicating base64 data',
);
assert.equal(
  persisted.displayItems[0].content.some((part) => part.type === 'input_image_ref'),
  true,
);
const attachmentFiles = await fs.readdir(path.join(storageDir, 'attachments'));
assert.equal(attachmentFiles.length, 1);
assert.match(attachmentFiles[0], /^[a-f0-9]{64}\.png$/u);

const reopened = new JsonFileSession(sessionFile);
let restoredMessages = extractChatMessages(await reopened.getDisplayItems());
assert.equal(restoredMessages[0].text, '请看图');
assert.equal(restoredMessages[0].images?.[0]?.name, 'screen.png');
assert.equal(restoredMessages[0].images?.[0]?.dataUrl, image.dataUrl);

await reopened.replaceItems([
  { type: 'message', role: 'system', content: '[summary] 图片问题已经讨论' },
]);
const afterCompaction = new JsonFileSession(sessionFile);
restoredMessages = extractChatMessages(await afterCompaction.getDisplayItems());
assert.equal(restoredMessages[0].images?.[0]?.dataUrl, image.dataUrl);

await afterCompaction.clearSession();
await assert.rejects(fs.stat(path.join(storageDir, 'attachments')), { code: 'ENOENT' });

console.log('multimodal tests passed');
