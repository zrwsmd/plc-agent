import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_SUMMARY_MARKER,
  CONTEXT_STATE_LEDGER_MARKER,
  CONTEXT_TOOL_RESULT_CLIP_MARKER,
  buildContextStateLedger,
  ensureContextCompacted,
  applyTokenEstimateCalibration,
  estimateItemsTokens,
  estimateItemsCharacters,
  estimateModelRequestTokenBreakdown,
  estimateModelRequestTokens,
  estimateTextTokens,
  extractChatMessages,
  JsonFileSession,
  LEGACY_CONTEXT_COMPACTION_DEFAULTS,
  UNKNOWN_CONTEXT_MAX_CHARACTERS,
  UNKNOWN_CONTEXT_MAX_INPUT_TOKENS,
  modelContextCalibrationRouteKey,
  parseContextStateLedgerItem,
  resolveRecentTurnBoundary,
  resolveContextCompactionPolicy,
  resolveInputTokenBudget,
  updateTokenEstimateCalibration,
  updateTokenEstimateCalibrationFromRequest,
} from './agent.testbundle.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plc-context-test-'));
const cfg = {
  baseUrl: 'http://mock/v1',
  apiKey: 'key',
  model: 'mock',
  exportDir: '',
  workspaceRoot: '',
};

try {
  {
    const englishTokens = estimateTextTokens('The quick brown fox jumps over the lazy dog.');
    const chineseTokens = estimateTextTokens('读取工作区文件并分析依赖关系');
    assert.ok(englishTokens > 0);
    assert.ok(chineseTokens > englishTokens);

    const requestEstimate = estimateModelRequestTokens({
      systemInstructions: 'You are a helpful assistant.',
      input: [{ type: 'message', role: 'user', content: '读取 main.st' }],
      tools: [{ name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      handoffs: [],
      outputType: 'text',
      modelSettings: {},
    });
    assert.ok(requestEstimate > chineseTokens);
    const requestBreakdown = estimateModelRequestTokenBreakdown({
      systemInstructions: 'You are a helpful assistant.',
      input: [{ type: 'message', role: 'user', content: '读取 main.st' }],
      tools: [{ name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      handoffs: [],
      outputType: 'text',
      modelSettings: {},
    });
    assert.ok(requestBreakdown.rawInputTokens > 0);
    assert.ok(requestBreakdown.rawFixedOverheadTokens > 0);
    assert.equal(requestBreakdown.rawTotalTokens, requestBreakdown.rawInputTokens + requestBreakdown.rawFixedOverheadTokens);
    assert.equal(requestBreakdown.totalTokens, requestBreakdown.inputTokens + requestBreakdown.fixedOverheadTokens);

    const routeKey = modelContextCalibrationRouteKey({
      provider: 'openai',
      apiFormat: 'responses',
      baseUrl: 'https://api.example/v1/',
      model: 'model-a',
    });
    assert.equal(
      modelContextCalibrationRouteKey({
        provider: 'openai',
        apiFormat: 'auto',
        baseUrl: 'https://api.example/v1/',
        model: 'model-a',
      }),
      modelContextCalibrationRouteKey({
        provider: 'openai',
        apiFormat: 'chat_completions',
        baseUrl: 'https://api.example/v1/',
        model: 'model-a',
      }),
    );
    assert.equal(
      modelContextCalibrationRouteKey({
        provider: 'openai',
        apiFormat: 'auto',
        baseUrl: '',
        model: 'model-a',
      }),
      modelContextCalibrationRouteKey({
        provider: 'openai',
        apiFormat: 'responses',
        baseUrl: '',
        model: 'model-a',
      }),
    );
    const first = updateTokenEstimateCalibration(undefined, routeKey, 100, 150);
    assert.equal(first.factor, 1.5);
    assert.equal(first.samples, 1);
    const second = updateTokenEstimateCalibration(first, routeKey, 100, 200);
    assert.equal(second.samples, 2);
    assert.equal(second.factor, 1.625);
    assert.equal(applyTokenEstimateCalibration(100, second), 163);
    assert.ok(estimateItemsTokens([{ type: 'message', role: 'user', content: '你好' }], second) > 0);
    const requestCalibration = updateTokenEstimateCalibrationFromRequest(
      undefined,
      routeKey,
      100,
      40,
      180,
    );
    assert.equal(requestCalibration.historyFactor, 1.4);
    assert.equal(requestCalibration.fixedOverheadTokens, 40);
    assert.equal(
      estimateItemsTokens([{ type: 'message', role: 'user', content: '你好' }], {
        ...requestCalibration,
        factor: 2,
        historyFactor: 1,
      }),
      estimateItemsTokens([{ type: 'message', role: 'user', content: '你好' }]),
    );

    const otherRoute = updateTokenEstimateCalibration(second, 'other-route', 100, 110);
    assert.equal(otherRoute.samples, 1);
    assert.equal(otherRoute.factor, 1.1);
    assert.equal(
      resolveInputTokenBudget({
        contextWindowTokens: 128_000,
        reservedOutputTokens: 4_096,
        safetyMarginTokens: 1_024,
      }),
      122_880,
    );
    assert.equal(
      resolveInputTokenBudget({
        contextWindowTokens: 128_000,
        reservedOutputTokens: 4_096,
        safetyMarginTokens: 1_024,
        fixedRequestOverheadTokens: 4_096,
      }),
      118_784,
    );
    assert.equal(
      resolveInputTokenBudget({
        contextWindowTokens: 128_000,
        reservedOutputTokens: 4_096,
        safetyMarginTokens: 1_024,
        compaction: { maxInputTokens: 10_000 },
      }),
      10_000,
    );
    assert.equal(UNKNOWN_CONTEXT_MAX_INPUT_TOKENS, 120_000);
    assert.equal(
      resolveInputTokenBudget({
        fixedRequestOverheadTokens: 4_096,
        compaction: { unknownMaxInputTokens: UNKNOWN_CONTEXT_MAX_INPUT_TOKENS },
      }),
      115_904,
    );
    assert.equal(resolveInputTokenBudget({ contextWindowTokens: 4_000, reservedOutputTokens: 4_096 }), undefined);
    assert.deepEqual(LEGACY_CONTEXT_COMPACTION_DEFAULTS, {
      maxItems: 48,
      maxCharacters: 200_000,
      unknownMaxCharacters: 80_000,
      recentItems: 16,
      maxSummaryInputCharacters: 60_000,
    });
    assert.deepEqual(
      resolveContextCompactionPolicy(undefined, {}),
      {
        triggerMode: 'legacy_threshold',
        inputBudgetTokens: undefined,
        legacy: LEGACY_CONTEXT_COMPACTION_DEFAULTS,
      },
    );
    assert.equal(
      resolveContextCompactionPolicy(
        { contextWindowTokens: 128_000, reservedOutputTokens: 4_096, safetyMarginTokens: 1_024 },
        { maxItems: 2, maxCharacters: 10, recentItems: 3, maxSummaryInputCharacters: 100 },
      ).triggerMode,
      'token_budget',
    );
  }

  {
    const session = new JsonFileSession(path.join(dir, 'session.json'));
    await session.addItems([
      { type: 'message', role: 'user', content: 'old user 1' },
      { type: 'message', role: 'assistant', content: 'old assistant 1' },
      { type: 'message', role: 'user', content: 'old user 2' },
      { type: 'message', role: 'assistant', content: 'old assistant 2' },
      { type: 'message', role: 'user', content: 'recent user' },
      { type: 'message', role: 'assistant', content: 'recent assistant' },
    ]);

    let summarizedOlder = 0;
    const compactionStates = [];
    const result = await ensureContextCompacted(session, cfg, {
      maxItems: 4,
      recentItems: 2,
      onCompactionState: (state) => compactionStates.push(state),
      summarize: async (_config, older, recent) => {
        summarizedOlder = older.length;
        assert.equal(recent.length, 2);
        return {
          summary: '用户正在围绕 PLC 项目连续工作，早期历史已压缩。',
          userPreferences: ['偏好中文回复'],
          durableFacts: ['已经讨论过 old user 1 和 old user 2'],
          importantFiles: ['main.st'],
          openTasks: ['继续保留最近两条原文'],
          risks: ['不要丢失审批状态'],
        };
      },
    });

    assert.equal(result.compacted, true);
    assert.deepEqual(compactionStates, ['started', 'completed']);
    assert.equal(result.triggerMode, 'legacy_threshold');
    assert.equal(summarizedOlder, 4);
    const items = await session.getItems();
    assert.equal(items.length, 6);
    assert.equal(items[0].role, 'system');
    assert.match(items[0].content, new RegExp(CONTEXT_SUMMARY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(items[1].role, 'user', '运行时账本不能作为第二条 system 消息发送给兼容网关');
    assert.match(items[1].content, new RegExp(CONTEXT_STATE_LEDGER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(items[2].content, 'old user 1');
    assert.equal(items[3].content, 'old user 2');
    assert.equal(items[4].content, 'recent user');
    assert.equal(items[5].content, 'recent assistant');

    const visible = extractChatMessages(items);
    assert.deepEqual(visible.map((message) => message.text), [
      'old user 1',
      'old user 2',
      'recent user',
      'recent assistant',
    ]);

    // Compaction changes only the model-facing history. Reopening the same
    // file must still replay every complete user/assistant turn in the UI.
    const display = extractChatMessages(await session.getDisplayItems());
    assert.deepEqual(display.map((message) => message.text), [
      'old user 1',
      'old assistant 1',
      'old user 2',
      'old assistant 2',
      'recent user',
      'recent assistant',
    ]);
    const reopened = new JsonFileSession(path.join(dir, 'session.json'));
    const reopenedDisplay = extractChatMessages(await reopened.getDisplayItems());
    assert.deepEqual(reopenedDisplay, display);
  }

  {
    const session = new JsonFileSession(path.join(dir, 'summary-merge-session.json'));
    const largeToolOutput = Array.from({ length: 30 }, (_, index) => `tool-line-${index + 1}`).join('\n');
    await session.addItems([
      {
        type: 'message',
        role: 'system',
        content: `${CONTEXT_SUMMARY_MARKER}\n已有事实：不能修改配置文件`,
      },
      { type: 'message', role: 'user', content: '必须保留这个用户约束：不要修改配置文件' },
      { type: 'message', role: 'assistant', content: '收到' },
      { type: 'function_call_output', call_id: 'call-1', name: 'read_file', output: largeToolOutput },
      { type: 'message', role: 'user', content: '继续检查最近文件' },
      { type: 'message', role: 'assistant', content: '继续' },
    ]);

    let capturedPriorSummaries = [];
    let capturedProtectedUsers = [];
    let capturedOlder = [];
    const result = await ensureContextCompacted(session, cfg, {
      maxItems: 4,
      recentItems: 2,
      summarize: async (_config, older, _recent, _signal, _maxChars, priorSummaries, protectedUsers) => {
        capturedOlder = older;
        capturedPriorSummaries = priorSummaries;
        capturedProtectedUsers = protectedUsers;
        return {
          summary: '合并后的摘要',
          userPreferences: [],
          durableFacts: ['不能修改配置文件'],
          importantFiles: [],
          openTasks: [],
          risks: [],
        };
      },
    });

    assert.equal(result.compacted, true);
    assert.equal(capturedPriorSummaries.length, 1);
    assert.equal(capturedProtectedUsers.length, 1);
    assert.equal(capturedProtectedUsers[0].content, '必须保留这个用户约束：不要修改配置文件');
    assert.equal(capturedOlder.some((item) => String(item.content ?? '').includes(CONTEXT_SUMMARY_MARKER)), false);
    const capturedTool = capturedOlder.find((item) => item.type === 'function_call_output');
    assert.ok(capturedTool);
    assert.match(capturedTool.output, new RegExp(CONTEXT_TOOL_RESULT_CLIP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(capturedTool.output, /tool-line-1/);
    assert.match(capturedTool.output, /tool-line-30/);

    const compacted = await session.getItems();
    assert.equal(compacted.filter((item) => String(item.content ?? '').includes(CONTEXT_SUMMARY_MARKER)).length, 1);
    assert.ok(compacted.some((item) => item.content === '必须保留这个用户约束：不要修改配置文件'));
  }

  {
    const session = new JsonFileSession(path.join(dir, 'display-rollback-session.json'));
    await session.addItems([
      { type: 'message', role: 'user', content: '旧请求' },
      { type: 'message', role: 'assistant', content: '旧回复' },
    ]);
    // Model history can be shorter than the display copy after compaction.
    await session.replaceItems([
      { type: 'message', role: 'system', content: '[summary] 旧请求已压缩' },
      { type: 'message', role: 'user', content: '旧请求' },
    ]);
    await session.addItems([
      { type: 'message', role: 'user', content: '失败的新请求' },
      { type: 'message', role: 'assistant', content: '失败的半成品' },
    ]);
    await session.truncate(2);
    assert.deepEqual(
      extractChatMessages(await session.getDisplayItems()).map((message) => message.text),
      ['旧请求', '旧回复'],
    );
  }

  {
    const session = new JsonFileSession(path.join(dir, 'tool-result-session.json'));
    const largeToolOutput = Array.from({ length: 30 }, (_, index) => `recent-tool-line-${index + 1}`).join('\n');
    await session.addItems([
      { type: 'message', role: 'user', content: '旧请求' },
      { type: 'message', role: 'assistant', content: '旧回复' },
      { type: 'message', role: 'user', content: '最近读取结果' },
      { type: 'function_call_output', call_id: 'call-2', name: 'read_file', output: largeToolOutput },
    ]);
    const result = await ensureContextCompacted(session, cfg, {
      maxItems: 3,
      recentItems: 2,
      summarize: async () => ({
        summary: '工具结果已压缩',
        userPreferences: [],
        durableFacts: [],
        importantFiles: [],
        openTasks: [],
        risks: [],
      }),
    });
    assert.equal(result.compacted, true);
    const compacted = await session.getItems();
    const tool = compacted.find((item) => item.type === 'function_call_output');
    assert.ok(tool);
    assert.match(tool.output, new RegExp(CONTEXT_TOOL_RESULT_CLIP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(tool.output, /recent-tool-line-1/);
    assert.match(tool.output, /recent-tool-line-30/);
  }

  {
    const session = new JsonFileSession(path.join(dir, 'summary-fallback-session.json'));
    await session.addItems([
      { type: 'message', role: 'user', content: '必须保留的旧用户约束' },
      { type: 'message', role: 'assistant', content: '旧回复' },
      { type: 'message', role: 'user', content: '另一个旧请求' },
      { type: 'message', role: 'assistant', content: '另一个旧回复' },
      { type: 'message', role: 'user', content: '最近请求' },
      { type: 'message', role: 'assistant', content: '最近回复' },
    ]);
    const result = await ensureContextCompacted(session, cfg, {
      maxItems: 4,
      recentItems: 2,
      summarize: async () => {
        throw new Error('summary service unavailable');
      },
    });
    assert.equal(result.compacted, true);
    assert.equal(result.reason, 'summary_failed_emergency_fallback');
    assert.match(result.error, /summary service unavailable/);
    const compacted = await session.getItems();
    assert.ok(compacted.length <= 7);
    assert.ok(compacted.some((item) => item.content === '必须保留的旧用户约束'));
    assert.match(compacted[0].content, new RegExp(CONTEXT_SUMMARY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(compacted[0].content, /保底/);
    assert.ok(compacted.some((item) => String(item.content ?? '').includes(CONTEXT_STATE_LEDGER_MARKER)));
  }

  {
    const structured = JSON.stringify({
      artifacts: [],
      data: {},
      diagnostics: [],
      message: '已读取 yy.txt，共 1 行：\nhello',
    });
    const visible = extractChatMessages([
      { type: 'message', role: 'user', content: '读取 yy.txt' },
      { type: 'message', role: 'assistant', content: structured },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '## 普通 Markdown\n\n正文' }],
      },
    ]);
    assert.deepEqual(visible, [
      { role: 'user', text: '读取 yy.txt' },
      { role: 'agent', text: '已读取 yy.txt，共 1 行：\nhello' },
      { role: 'agent', text: '## 普通 Markdown\n\n正文' },
    ]);
  }

  {
    const session = new JsonFileSession(path.join(dir, 'small-session.json'));
    await session.addItems([
      { type: 'message', role: 'user', content: 'short' },
      { type: 'message', role: 'assistant', content: 'ok' },
    ]);
    let called = false;
    const before = estimateItemsCharacters(await session.getItems());
    const result = await ensureContextCompacted(session, cfg, {
      maxItems: 10,
      maxCharacters: before + 1_000,
      summarize: async () => {
        called = true;
        throw new Error('should not summarize');
      },
    });
    assert.equal(result.compacted, false);
    assert.equal(called, false);
    assert.equal((await session.getItems()).length, 2);
  }

  {
    const session = new JsonFileSession(path.join(dir, 'manual-force-session.json'));
    await session.addItems([
      { type: 'message', role: 'user', content: '较早的用户需求' },
      { type: 'message', role: 'assistant', content: '较早的处理结果' },
      { type: 'message', role: 'user', content: '最近的用户需求' },
      { type: 'message', role: 'assistant', content: '最近的处理结果' },
    ]);
    let called = false;
    const result = await ensureContextCompacted(session, cfg, {
      force: true,
      modelContext: {
        contextWindowTokens: 128_000,
        compaction: { maxInputTokens: 100_000, recentItems: 16 },
      },
      summarize: async (_config, older, recent) => {
        called = true;
        assert.equal(older.length, 2);
        assert.equal(recent.length, 2);
        return {
          summary: '手动压缩摘要',
          userPreferences: [],
          durableFacts: [],
          importantFiles: [],
          openTasks: [],
          risks: [],
        };
      },
    });
    assert.equal(called, true);
    assert.equal(result.compacted, true);
    assert.equal(result.reason, 'manual_force');
    assert.equal(result.triggerMode, 'token_budget');
    assert.ok(
      (await session.getItems()).some((item) =>
        String(item.content ?? '').includes('手动压缩摘要')),
    );
  }

  {
    const session = new JsonFileSession(path.join(dir, 'profile-session.json'));
    await session.addItems([
      { type: 'message', role: 'user', content: 'profile old user' },
      { type: 'message', role: 'assistant', content: 'profile old assistant' },
      { type: 'message', role: 'user', content: 'profile recent user' },
      { type: 'message', role: 'assistant', content: 'profile recent assistant' },
    ]);
    const beforeTokens = estimateItemsTokens(await session.getItems());
    let called = false;
    const result = await ensureContextCompacted(session, cfg, {
      modelContext: {
        contextWindowTokens: 128_000,
        compaction: {
          maxInputTokens: beforeTokens - 1,
          maxItems: 3,
          recentItems: 2,
          maxSummaryInputCharacters: 2_000,
        },
      },
      summarize: async (_config, older, recent, _signal, maxInputCharacters) => {
        called = true;
        assert.equal(older.length, 2);
        assert.equal(recent.length, 2);
        assert.equal(maxInputCharacters, 2_000);
        return {
          summary: 'profile summary',
          userPreferences: [],
          durableFacts: [],
          importantFiles: [],
          openTasks: [],
          risks: [],
        };
      },
    });
    assert.equal(called, true);
    assert.equal(result.compacted, true);
    assert.equal(result.triggerMode, 'token_budget');
    assert.equal(result.beforeTokens, beforeTokens);
    assert.equal(result.inputBudgetTokens, beforeTokens - 1);
    assert.match(result.reason, /^tokens>/);
    assert.equal((await session.getItems()).length, 3);
    assert.equal(
      result.postCompactionBudgetSatisfied,
      false,
      '小于最小摘要、账本和当前请求集合的预算必须明确报告无法满足',
    );
  }

  {
    const session = new JsonFileSession(path.join(dir, 'token-precedence-session.json'));
    await session.addItems([
      { type: 'message', role: 'user', content: 'small 1' },
      { type: 'message', role: 'assistant', content: 'small 2' },
      { type: 'message', role: 'user', content: 'small 3' },
      { type: 'message', role: 'assistant', content: 'small 4' },
    ]);
    let called = false;
    const result = await ensureContextCompacted(session, cfg, {
      modelContext: {
        contextWindowTokens: 128_000,
        compaction: {
          maxItems: 1,
          recentItems: 2,
        },
      },
      summarize: async () => {
        called = true;
        throw new Error('token budget should prevent this legacy trigger');
      },
    });
    assert.equal(result.compacted, false);
    assert.equal(result.triggerMode, 'token_budget');
    assert.equal(called, false);
  }

  {
    const session = new JsonFileSession(path.join(dir, 'legacy-profile-session.json'));
    await session.addItems([
      { type: 'message', role: 'user', content: 'legacy 1' },
      { type: 'message', role: 'assistant', content: 'legacy 2' },
      { type: 'message', role: 'user', content: 'legacy 3' },
      { type: 'message', role: 'assistant', content: 'legacy 4' },
    ]);
    const result = await ensureContextCompacted(session, cfg, {
      modelContext: {
        compaction: {
          maxItems: 3,
          maxCharacters: 1,
          recentItems: 2,
        },
      },
      summarize: async () => ({
        summary: 'legacy summary',
        userPreferences: [],
        durableFacts: [],
        importantFiles: [],
        openTasks: [],
        risks: [],
      }),
    });
    assert.equal(result.compacted, true);
    assert.equal(result.triggerMode, 'legacy_threshold');
    assert.equal(result.beforeTokens, undefined);
    assert.match(result.reason, /chars>1/);
  }

  {
    const unknownWindowPolicy = resolveContextCompactionPolicy({
      compaction: { maxCharacters: LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxCharacters },
    });
    assert.equal(
      unknownWindowPolicy.legacy.maxCharacters,
      UNKNOWN_CONTEXT_MAX_CHARACTERS,
      '未知模型窗口不能直接使用 200000 字符阈值',
    );
    const widenedUnknownWindowPolicy = resolveContextCompactionPolicy({
      compaction: {
        maxCharacters: LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxCharacters,
        unknownMaxCharacters: LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxCharacters,
      },
    });
    assert.equal(
      widenedUnknownWindowPolicy.legacy.maxCharacters,
      LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxCharacters,
      '未知模型窗口可以通过显式 unknownMaxCharacters 放宽到 200000',
    );
    const knownWindowPolicy = resolveContextCompactionPolicy({
      contextWindowTokens: 128_000,
      compaction: { maxCharacters: LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxCharacters },
    });
    assert.equal(knownWindowPolicy.legacy.maxCharacters, LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxCharacters);
  }

  {
    const session = new JsonFileSession(path.join(dir, 'length-profile-session.json'));
    await session.addItems(Array.from({ length: 52 }, (_, index) => ({
      type: 'message',
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `短消息 ${index + 1}`,
    })));
    let called = false;
    const result = await ensureContextCompacted(session, cfg, {
      modelContext: {
        compaction: {
          maxItems: 1,
          maxCharacters: 100_000,
          recentItems: 16,
        },
      },
      summarize: async () => {
        called = true;
        throw new Error('item count must not trigger a modern length profile');
      },
    });
    assert.equal(result.compacted, false);
    assert.equal(called, false);
  }

  {
    const session = new JsonFileSession(path.join(dir, 'replace-session.json'));
    await session.addItems([{ type: 'message', role: 'user', content: 'stale' }]);
    await session.replaceItems([{ type: 'message', role: 'assistant', content: 'fresh' }]);
    const items = await session.getItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].content, 'fresh');
  }

  {
    const turnItems = [
      { type: 'message', role: 'user', content: '旧轮次' },
      { type: 'message', role: 'assistant', content: '旧回复' },
      { type: 'message', role: 'user', content: '当前工具密集轮次' },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: index % 2 === 0 ? 'function_call' : 'function_call_output',
        call_id: `call-${Math.floor(index / 2)}`,
        name: 'read_file',
        ...(index % 2 === 0
          ? { arguments: JSON.stringify({ path: `file-${index}.st` }) }
          : { output: JSON.stringify({ ok: true, effect: 'none', risk: 'read', data: {} }) }),
      })),
    ];
    assert.equal(
      resolveRecentTurnBoundary(turnItems, 4),
      2,
      '最近窗口必须向前扩展到当前完整用户轮次的起点',
    );
  }

  {
    const ledger = buildContextStateLedger([
      { type: 'message', role: 'user', content: '修改并交付 PumpControl.st' },
      {
        type: 'function_call',
        call_id: 'write-1',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'PumpControl.st', contentHash: 'sha-final' }),
      },
      {
        type: 'function_call_output',
        call_id: 'write-1',
        name: 'write_file',
        output: JSON.stringify({
          ok: true,
          effect: 'filesystem',
          risk: 'write',
          data: {
            file: 'PumpControl.st',
            contentHash: 'sha-final',
            deliveryCommit: { commitId: 'delivery-commit-1', path: 'PumpControl.st' },
          },
        }),
      },
    ]);
    assert.equal(ledger.currentTask.userRequest, '修改并交付 PumpControl.st');
    assert.equal(ledger.tools.at(-1).name, 'write_file');
    assert.equal(ledger.tools.at(-1).outcome, 'ok');
    assert.equal(ledger.tools.at(-1).target, 'PumpControl.st');
    assert.ok(ledger.resources.some((fact) => fact.kind === 'hash' && fact.value === 'sha-final'));
    assert.ok(ledger.deliveryEvidence.some((fact) => fact.value === 'delivery-commit-1'));
  }

  {
    const session = new JsonFileSession(path.join(dir, 'post-budget-session.json'));
    const noisyToolOutput = Array.from(
      { length: 80 },
      (_, index) => `tool-${index}-${'x'.repeat(80)}`,
    ).join('\n');
    await session.addItems([
      { type: 'message', role: 'user', content: `旧需求一${'甲'.repeat(5_000)}` },
      { type: 'message', role: 'assistant', content: '旧回复一' },
      { type: 'message', role: 'user', content: `旧需求二${'乙'.repeat(5_000)}` },
      { type: 'message', role: 'assistant', content: '旧回复二' },
      { type: 'message', role: 'user', content: '当前需求' },
      { type: 'function_call_output', call_id: 'read-1', name: 'read_file', output: noisyToolOutput },
    ]);
    const result = await ensureContextCompacted(session, cfg, {
      maxCharacters: 3_000,
      recentItems: 2,
      summarize: async () => ({
        summary: '较早需求已经汇总。',
        userPreferences: [],
        durableFacts: [],
        importantFiles: [],
        openTasks: [],
        risks: [],
      }),
    });
    assert.equal(result.compacted, true);
    assert.ok(result.afterCharacters <= 3_000, '压缩后必须重新收缩到字符预算以内');
    assert.equal(result.postCompactionBudgetSatisfied, true);
    const compacted = await session.getItems();
    const ledgerItem = compacted.find((item) => String(item.content ?? '').includes(CONTEXT_STATE_LEDGER_MARKER));
    assert.ok(ledgerItem);
    assert.equal(parseContextStateLedgerItem(ledgerItem).currentTask.userRequest, '当前需求');
    assert.ok(compacted.some((item) => item.content === '当前需求'));
  }

  {
    const session = new JsonFileSession(path.join(dir, 'tool-pair-budget-session.json'));
    const hugeArguments = JSON.stringify({ path: 'large.st', content: 'x'.repeat(80_000) });
    await session.addItems([
      { type: 'message', role: 'user', content: '必须保留的原始需求' },
      { type: 'message', role: 'assistant', content: '准备检查' },
      { type: 'message', role: 'user', content: '当前需求' },
      { type: 'function_call', call_id: 'pair-1', name: 'write_file', arguments: hugeArguments },
      { type: 'function_call_output', call_id: 'pair-1', name: 'write_file', output: '完成' },
      { type: 'function_call', call_id: 'pair-2', name: 'read_file', arguments: hugeArguments },
      { type: 'function_call_output', call_id: 'pair-2', name: 'read_file', output: '完成' },
      {
        type: 'message',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'chat-pair', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'chat-pair', content: '完成' },
    ]);
    const result = await ensureContextCompacted(session, cfg, {
      maxCharacters: 1_200,
      recentItems: 2,
      summarize: async () => ({
        summary: '工具事件已经登记到账本。',
        userPreferences: [],
        durableFacts: [],
        importantFiles: [],
        openTasks: [],
        risks: [],
      }),
    });
    assert.equal(result.compacted, true);
    const compacted = await session.getItems();
    const calls = new Set(compacted.filter((item) => item.type === 'function_call').map((item) => item.call_id));
    const chatCalls = new Set(compacted.flatMap((item) => item.type === 'message' && Array.isArray(item.tool_calls)
      ? item.tool_calls.map((call) => call.id)
      : []));
    for (const output of compacted.filter((item) => item.type === 'function_call_output')) {
      assert.ok(calls.has(output.call_id), `工具结果 ${output.call_id} 不能脱离对应调用残留`);
    }
    for (const output of compacted.filter((item) => item.role === 'tool')) {
      assert.ok(chatCalls.has(output.tool_call_id), `Chat Completions 工具结果 ${output.tool_call_id} 不能脱离对应调用残留`);
    }
    assert.ok(compacted.some((item) => item.content === '必须保留的原始需求'));
  }

  {
    const session = new JsonFileSession(path.join(dir, 'multimodal-budget-session.json'));
    const imageBlock = { type: 'input_image', image_url: 'data:image/png;base64,placeholder' };
    await session.addItems([
      { type: 'message', role: 'user', content: '旧请求' },
      { type: 'message', role: 'assistant', content: '旧回复' },
      {
        type: 'message',
        role: 'user',
        content: [imageBlock, { type: 'input_text', text: '当前需求 '.repeat(5_000) }],
      },
    ]);
    await ensureContextCompacted(session, cfg, {
      maxCharacters: 2_000,
      recentItems: 2,
      summarize: async () => ({
        summary: '已收到当前需求。',
        userPreferences: [],
        durableFacts: [],
        importantFiles: [],
        openTasks: [],
        risks: [],
      }),
    });
    const compacted = await session.getItems();
    const current = compacted.find((item) => item.type === 'message' && item.role === 'user' &&
      Array.isArray(item.content));
    assert.ok(current, '多模态用户消息必须继续保持消息数组结构');
    assert.deepEqual(current.content.find((part) => part.type === 'input_image'), imageBlock);
  }

  console.log('context manager tests passed: bounded compaction, runtime ledger, full-turn retention');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
