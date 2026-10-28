import { Agent, Runner, type AgentInputItem } from '@openai/agents';
import { z } from 'zod';
import { buildModelAdapter } from './modelGateway';
import type { AgentConfig } from './agentConfig';
import { estimateItemsTokens } from './contextTokenEstimator';
import {
  buildContextStateLedger,
  compactContextStateLedgerItem,
  createContextStateLedgerItem,
  isContextStateLedgerItem,
} from './contextStateLedger';

export const CONTEXT_SUMMARY_MARKER = '[plc-agent-context-summary:v1]';
export const CONTEXT_TOOL_RESULT_CLIP_MARKER = '[tool-result-context-clipped]';

export interface ContextManagedSession {
  getItems(limit?: number): Promise<AgentInputItem[]>;
  replaceItems(items: AgentInputItem[]): Promise<void>;
}

/** Legacy limits retained for old hosts and persisted run documents. */
export interface LegacyContextCompactionBudget {
  /** @deprecated Use maxInputTokens or the model context window instead. */
  maxItems?: number;
  /** @deprecated Use maxInputTokens or the model context window instead. */
  maxCharacters?: number;
  /** Character ceiling used only when a model profile has no known context window. */
  unknownMaxCharacters?: number;
  /** Minimum recent item count; retention expands to the containing full user turn. */
  recentItems?: number;
  /** Retained in both modes to bound the summarizer input. */
  maxSummaryInputCharacters?: number;
}

/** Model-aware local compaction settings. */
export interface ContextCompactionBudget extends LegacyContextCompactionBudget {
  /** Explicit effective input-token ceiling; 0/unset uses the model profile. */
  maxInputTokens?: number;
}

export interface TokenEstimateCalibration {
  routeKey: string;
  factor: number;
  /** Calibration for the input history portion only. */
  historyFactor?: number;
  /** Estimated fixed request overhead for this route's request shape. */
  fixedOverheadTokens?: number;
  samples: number;
  updatedAt: string;
}

/** Model-route context metadata shared by local and provider-managed compaction. */
export interface ModelContextProfile {
  /** The model's total context window, consumed by the token-aware stage. */
  contextWindowTokens?: number;
  /** Input headroom reserved for the model's response. */
  reservedOutputTokens?: number;
  /** Extra input headroom kept as a safety margin. */
  safetyMarginTokens?: number;
  /**
   * Baseline tokens consumed by system instructions, tools, schemas and other
   * non-history request fields. The learned main-agent calibration can add to
   * this value for the next turn.
   */
  fixedRequestOverheadTokens?: number;
  /** Automatically learned estimate correction for this model/API route. */
  tokenCalibration?: TokenEstimateCalibration;
  /** Per-request-purpose calibration; tokenCalibration remains the legacy main-agent slot. */
  tokenCalibrations?: Record<string, TokenEstimateCalibration>;
  /** Local-compaction limits; token budget takes precedence when available. */
  compaction?: ContextCompactionBudget;
}

export const contextSummarySchema = z.object({
  summary: z.string().min(1),
  userPreferences: z.array(z.string()).default([]),
  durableFacts: z.array(z.string()).default([]),
  importantFiles: z.array(z.string()).default([]),
  openTasks: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
}).strict();

export type ContextSummary = z.infer<typeof contextSummarySchema>;

export type ContextSummarizer = (
  config: AgentConfig,
  olderItems: AgentInputItem[],
  recentItems: AgentInputItem[],
  signal?: AbortSignal,
  maxInputCharacters?: number,
  priorSummaryItems?: AgentInputItem[],
  protectedUserItems?: AgentInputItem[],
) => Promise<ContextSummary>;

export interface ContextManagerOptions {
  /** New unified configuration entry point for context management. */
  modelContext?: ModelContextProfile;
  /** Legacy direct fields remain supported for callers and older tests. */
  /** @deprecated Use modelContext.compaction.maxInputTokens instead. */
  maxItems?: number;
  /** @deprecated Use modelContext.compaction.maxInputTokens instead. */
  maxCharacters?: number;
  /** Character ceiling for a model profile whose context window is unknown. */
  unknownMaxCharacters?: number;
  /** Retained as a compaction-shaping option in both trigger modes. */
  recentItems?: number;
  /** Retained as a compaction-shaping option in both trigger modes. */
  maxSummaryInputCharacters?: number;
  signal?: AbortSignal;
  summarize?: ContextSummarizer;
  /** Notifies the host when an actual compaction request starts or finishes. */
  onCompactionState?: (
    state: 'started' | 'completed' | 'failed',
    result?: ContextCompactionResult,
  ) => void;
}

export interface ResolvedContextCompactionPolicy {
  triggerMode: 'token_budget' | 'legacy_threshold';
  inputBudgetTokens?: number;
  legacy: Required<LegacyContextCompactionBudget>;
}

export interface ContextCompactionResult {
  compacted: boolean;
  beforeItems: number;
  afterItems: number;
  beforeCharacters: number;
  afterCharacters: number;
  beforeTokens?: number;
  afterTokens?: number;
  inputBudgetTokens?: number;
  triggerMode?: 'token_budget' | 'legacy_threshold';
  postCompactionBudgetSatisfied?: boolean;
  reason?: string;
  error?: string;
}

export const LEGACY_CONTEXT_COMPACTION_DEFAULTS: Required<LegacyContextCompactionBudget> = {
  maxItems: 48,
  maxCharacters: 200_000,
  unknownMaxCharacters: 80_000,
  recentItems: 16,
  maxSummaryInputCharacters: 60_000,
};

// Unknown/local models use a separate conservative ceiling. The normal
// maxCharacters setting remains 200k for legacy callers and known-window
// profiles; callers can explicitly raise this value when the model supports it.
export const UNKNOWN_CONTEXT_MAX_CHARACTERS = 80_000;

export async function ensureContextCompacted(
  session: ContextManagedSession,
  config: AgentConfig,
  options: ContextManagerOptions = {},
): Promise<ContextCompactionResult> {
  const items = await session.getItems();
  const beforeCharacters = estimateItemsCharacters(items);
  const modelContext = options.modelContext ?? config.modelContext;
  const policy = resolveContextCompactionPolicy(modelContext, options);
  const { inputBudgetTokens, triggerMode } = policy;
  const beforeTokens = inputBudgetTokens === undefined
    ? undefined
    : estimateItemsTokens(items, modelContext?.tokenCalibration);
  const { maxItems, maxCharacters } = policy.legacy;
  // A modern modelContext profile uses context length as the fallback signal
  // even when its exact model window is unknown. Item count is retained only
  // for legacy callers that never supplied a modelContext profile.
  const useLegacyItemThreshold = modelContext === undefined;
  const tooManyItems = useLegacyItemThreshold && items.length > maxItems;
  const tooManyCharacters = beforeCharacters > maxCharacters;
  const tooManyTokens =
    inputBudgetTokens !== undefined &&
    beforeTokens !== undefined &&
    beforeTokens > inputBudgetTokens;
  const shouldCompact = inputBudgetTokens === undefined
    ? tooManyItems || tooManyCharacters
    : tooManyTokens;
  if (!shouldCompact) {
    return {
      compacted: false,
      beforeItems: items.length,
      afterItems: items.length,
      beforeCharacters,
      afterCharacters: beforeCharacters,
      beforeTokens,
      afterTokens: beforeTokens,
      inputBudgetTokens,
      triggerMode,
    };
  }

  const splitAt = resolveRecentTurnBoundary(items, policy.legacy.recentItems);
  const olderItems = items.slice(0, splitAt);
  const recentItems = items.slice(splitAt);
  if (!olderItems.length) {
    return {
      compacted: false,
      beforeItems: items.length,
      afterItems: items.length,
      beforeCharacters,
      afterCharacters: beforeCharacters,
      beforeTokens,
      afterTokens: beforeTokens,
      inputBudgetTokens,
      triggerMode,
      reason: 'history_contains_only_recent_items',
    };
  }

  notifyCompactionState(options, 'started');

  const runtimeLedgerItem = createContextStateLedgerItem(buildContextStateLedger(items));
  const priorSummaryItems = [...olderItems, ...recentItems].filter(isContextSummaryItem);
  const olderContentItems = olderItems.filter(
    (item) => !isContextSummaryItem(item) && !isContextStateLedgerItem(item),
  );
  const recentContentItems = recentItems.filter(
    (item) => !isContextSummaryItem(item) && !isContextStateLedgerItem(item),
  );
  const protectedUserItems = olderContentItems.filter(isUserMessageItem);
  const summaryInputOlderItems = olderContentItems.map(compactToolResultItem);
  const summaryInputRecentItems = recentContentItems.map(compactToolResultItem);

  try {
    const summarize = options.summarize ?? summarizeContextWithModel;
    const summary = await summarize(
      config,
      summaryInputOlderItems,
      summaryInputRecentItems,
      options.signal,
      policy.legacy.maxSummaryInputCharacters,
      priorSummaryItems,
      protectedUserItems,
    );
    const candidateItems = [
      createSummaryItem(summary),
      runtimeLedgerItem,
      ...protectedUserItems,
      ...recentContentItems.map(compactToolResultItem),
    ];
    const compactedItems = enforcePostCompactionBudget(candidateItems, policy, modelContext);
    await session.replaceItems(compactedItems);
    const afterCharacters = estimateItemsCharacters(compactedItems);
    const afterTokens = inputBudgetTokens === undefined
      ? undefined
      : estimateItemsTokens(compactedItems, modelContext?.tokenCalibration);
    const result = {
      compacted: true,
      beforeItems: items.length,
      afterItems: compactedItems.length,
      beforeCharacters,
      afterCharacters,
      beforeTokens,
      afterTokens,
      inputBudgetTokens,
      triggerMode,
      postCompactionBudgetSatisfied: isWithinCompactionBudget(
        compactedItems,
        policy,
        modelContext,
      ),
      reason: inputBudgetTokens === undefined
        ? [
          tooManyItems ? `items>${maxItems}` : '',
          tooManyCharacters ? `chars>${maxCharacters}` : '',
        ].filter(Boolean).join(',')
        : `tokens>${inputBudgetTokens}`,
    };
    notifyCompactionState(options, 'completed', result);
    return result;
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      const result = {
        compacted: false,
        beforeItems: items.length,
        afterItems: items.length,
        beforeCharacters,
        afterCharacters: beforeCharacters,
        beforeTokens,
        afterTokens: beforeTokens,
        inputBudgetTokens,
        triggerMode,
        postCompactionBudgetSatisfied: false,
        reason: 'aborted',
      };
      notifyCompactionState(options, 'failed', result);
      return result;
    }
    const originalError = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    const fallbackItems = enforcePostCompactionBudget([
      createEmergencySummaryItem(),
      runtimeLedgerItem,
      ...priorSummaryItems,
      ...protectedUserItems,
      ...recentContentItems.map(compactToolResultItem),
    ], policy, modelContext);
    try {
      await session.replaceItems(fallbackItems);
      const afterCharacters = estimateItemsCharacters(fallbackItems);
      const afterTokens = inputBudgetTokens === undefined
        ? undefined
        : estimateItemsTokens(fallbackItems, modelContext?.tokenCalibration);
      const result = {
        compacted: true,
        beforeItems: items.length,
        afterItems: fallbackItems.length,
        beforeCharacters,
        afterCharacters,
        beforeTokens,
        afterTokens,
        inputBudgetTokens,
        triggerMode,
        postCompactionBudgetSatisfied: isWithinCompactionBudget(
          fallbackItems,
          policy,
          modelContext,
        ),
        reason: 'summary_failed_emergency_fallback',
        error: originalError,
      };
      notifyCompactionState(options, 'completed', result);
      return result;
    } catch (fallbackError) {
      const fallbackErrorText = fallbackError instanceof Error
        ? `${fallbackError.name}: ${fallbackError.message}`
        : String(fallbackError);
      const result = {
        compacted: false,
        beforeItems: items.length,
        afterItems: items.length,
        beforeCharacters,
        afterCharacters: beforeCharacters,
        beforeTokens,
        afterTokens: beforeTokens,
        inputBudgetTokens,
        triggerMode,
        error: `${originalError}; emergency fallback failed: ${fallbackErrorText}`,
      };
      notifyCompactionState(options, 'failed', result);
      return result;
    }
  }
}

function notifyCompactionState(
  options: ContextManagerOptions,
  state: 'started' | 'completed' | 'failed',
  result?: ContextCompactionResult,
): void {
  try {
    options.onCompactionState?.(state, result);
  } catch {
    // A UI/telemetry observer must never change the compaction result.
  }
}

/**
 * Centralize the migration boundary between the token budget and the old
 * item/character thresholds. The old fields are intentionally still read,
 * but they cannot override a valid token budget.
 */
export function resolveContextCompactionPolicy(
  modelContext?: ModelContextProfile,
  options: Pick<
    ContextManagerOptions,
    'maxItems' | 'maxCharacters' | 'unknownMaxCharacters' | 'recentItems' | 'maxSummaryInputCharacters'
  > = {},
): ResolvedContextCompactionPolicy {
  const budget = modelContext?.compaction;
  const configuredMaxCharacters = positiveIntegerOrDefault(
    options.maxCharacters ?? budget?.maxCharacters,
    LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxCharacters,
  );
  const configuredUnknownMaxCharacters = positiveIntegerOrDefault(
    options.unknownMaxCharacters ?? budget?.unknownMaxCharacters,
    LEGACY_CONTEXT_COMPACTION_DEFAULTS.unknownMaxCharacters,
  );
  const hasKnownContextWindow = positiveInteger(modelContext?.contextWindowTokens) !== undefined;
  const hasExplicitTokenBudget = positiveInteger(budget?.maxInputTokens) !== undefined;
  const legacy = {
    maxItems: positiveIntegerOrDefault(
      options.maxItems ?? budget?.maxItems,
      LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxItems,
    ),
    maxCharacters: modelContext !== undefined && !hasKnownContextWindow && !hasExplicitTokenBudget
      ? Math.min(configuredUnknownMaxCharacters, configuredMaxCharacters)
      : configuredMaxCharacters,
    unknownMaxCharacters: configuredUnknownMaxCharacters,
    recentItems: Math.max(
      2,
      positiveIntegerOrDefault(
        options.recentItems ?? budget?.recentItems,
        LEGACY_CONTEXT_COMPACTION_DEFAULTS.recentItems,
      ),
    ),
    maxSummaryInputCharacters: positiveIntegerOrDefault(
      options.maxSummaryInputCharacters ?? budget?.maxSummaryInputCharacters,
      LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxSummaryInputCharacters,
    ),
  };
  const inputBudgetTokens = resolveInputTokenBudget(modelContext);
  return {
    triggerMode: inputBudgetTokens === undefined ? 'legacy_threshold' : 'token_budget',
    inputBudgetTokens,
    legacy,
  };
}

/**
 * Resolve the effective local input budget.
 *
 * An explicit compaction max wins when it is below the model-derived ceiling.
 * Invalid/insufficient model headroom returns undefined so old item/character
 * thresholds remain the safe compatibility path.
 */
export function resolveInputTokenBudget(
  profile?: ModelContextProfile,
): number | undefined {
  if (!profile) return undefined;

  const explicit = positiveInteger(profile.compaction?.maxInputTokens);
  const contextWindow = positiveInteger(profile.contextWindowTokens);
  const fixedRequestOverhead = Math.max(
    nonNegativeInteger(profile.fixedRequestOverheadTokens),
    nonNegativeInteger(profile.tokenCalibration?.fixedOverheadTokens),
  );
  let derived: number | undefined;
  if (contextWindow !== undefined) {
    const reservedOutput = nonNegativeInteger(profile.reservedOutputTokens);
    const safetyMargin = nonNegativeInteger(profile.safetyMarginTokens);
    const available = contextWindow - reservedOutput - safetyMargin - fixedRequestOverhead;
    if (available <= 0) return undefined;
    derived = available;
  }

  const explicitAvailable = explicit === undefined
    ? undefined
    : explicit - fixedRequestOverhead;
  if (explicitAvailable !== undefined && explicitAvailable <= 0) return undefined;
  if (explicitAvailable === undefined) return derived;
  if (derived === undefined) return explicitAvailable;
  return Math.min(explicitAvailable, derived);
}

export async function summarizeContextWithModel(
  config: AgentConfig,
  olderItems: AgentInputItem[],
  recentItems: AgentInputItem[],
  signal?: AbortSignal,
  maxInputCharacters = LEGACY_CONTEXT_COMPACTION_DEFAULTS.maxSummaryInputCharacters,
  priorSummaryItems: AgentInputItem[] = [],
  protectedUserItems: AgentInputItem[] = [],
): Promise<ContextSummary> {
  signal?.throwIfAborted();
  const adapter = buildModelAdapter(config, 'context_summarizer');
  const summarizer = new Agent({
    name: 'PLC Context Summarizer',
    model: adapter.model,
    outputType: contextSummarySchema,
    instructions:
      '你是长对话上下文压缩器，只做摘要，不执行工具。' +
      '把较早历史压缩成后续任务仍需要的事实、约束、用户偏好、重要文件、未完成事项和风险。' +
      '不要发明历史里没有的信息；不要保留寒暄、重复内容或已经无关的细节。' +
      '最近若干完整轮次会被保留，因此只摘要更早历史。已有的历史压缩摘要和用户约束会单独提供，' +
      '必须把它们当作已确认事实合并，不能把它们当普通对话重新压缩。' +
      '必须严格返回 schema，不要输出 markdown。',
  });
  const input = [
    {
      type: 'message',
      role: 'user',
      content: [
        '请压缩以下较早会话历史，供后续 PLC/工作区 Agent 继续使用。',
        '',
        '已有的历史压缩摘要（作为已确认事实合并，不要重新淡化）：',
        serializeItemsForSummary(priorSummaryItems, Math.min(12_000, Math.floor(maxInputCharacters / 4))),
        '',
        '必须原样保留的用户消息/约束（不要改写成相反含义）：',
        serializeItemsForSummary(protectedUserItems, Math.min(16_000, Math.floor(maxInputCharacters / 3))),
        '',
        '较早历史：',
        serializeItemsForSummary(olderItems, maxInputCharacters),
        '',
        '以下最近完整轮次会被保留，你只需避免与它重复：',
        serializeItemsForSummary(recentItems, Math.min(12_000, Math.floor(maxInputCharacters / 4))),
      ].join('\n'),
    } as unknown as AgentInputItem,
  ];
  const tracingDisabled = !(adapter.provider === 'openai' && adapter.apiFormat === 'responses' && !config.baseUrl.trim());
  const result = await new Runner({ tracingDisabled }).run(summarizer, input, {
    stream: false,
    maxTurns: 1,
    signal,
  });
  return contextSummarySchema.parse(result.finalOutput);
}

export function createSummaryItem(summary: ContextSummary): AgentInputItem {
  return {
    type: 'message',
    role: 'system',
    content: renderContextSummary(summary),
  } as unknown as AgentInputItem;
}

function createEmergencySummaryItem(): AgentInputItem {
  return createSummaryItem({
    summary: '上下文摘要模型失败，运行时已执行保守裁剪。未被保留的旧工具细节不可直接推断，必要时请重新读取。',
    userPreferences: [],
    durableFacts: [],
    importantFiles: [],
    openTasks: [],
    risks: ['本条是摘要失败后的保底记录，不是完整历史摘要。'],
  });
}

export function isContextSummaryItem(item: AgentInputItem): boolean {
  const value = item as Record<string, unknown>;
  if (value.type !== 'message' || value.role !== 'system') return false;
  return messageText(value.content).includes(CONTEXT_SUMMARY_MARKER);
}

export function renderContextSummary(summary: ContextSummary): string {
  const lines = [
    CONTEXT_SUMMARY_MARKER,
    '以下是较早会话历史的压缩摘要。它替代被压缩的原始消息；最近消息仍保留原文。',
    '',
    `总体摘要：${summary.summary}`,
    renderList('用户偏好/约束', summary.userPreferences),
    renderList('已确认事实', summary.durableFacts),
    renderList('重要文件/产物', summary.importantFiles),
    renderList('未完成事项', summary.openTasks),
    renderList('风险/注意点', summary.risks),
  ].filter((line) => line !== undefined && line !== '');
  return lines.join('\n');
}

export function estimateItemsCharacters(items: AgentInputItem[]): number {
  return items.reduce((total, item) => total + serializeItem(item).length, 0);
}

function renderList(title: string, values: string[]): string {
  const entries = values.map((value) => value.trim()).filter(Boolean);
  if (!entries.length) return `${title}：无`;
  return `${title}：\n${entries.map((entry) => `- ${entry}`).join('\n')}`;
}

function serializeItemsForSummary(items: AgentInputItem[], maxCharacters: number): string {
  const text = items
    .map((item, index) => `#${index + 1} ${serializeItemForTranscript(item)}`)
    .join('\n');
  return middleClip(text, maxCharacters);
}

function isUserMessageItem(item: AgentInputItem): boolean {
  const value = item as Record<string, unknown>;
  return value.type === 'message' && value.role === 'user' && !isContextStateLedgerItem(item);
}

function isToolResultItem(item: AgentInputItem): boolean {
  const value = item as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : '';
  return (
    type === 'function_call_result' ||
    type === 'function_call_output' ||
    type === 'tool_result' ||
    type === 'tool_output' ||
    value.role === 'tool'
  );
}

function compactToolResultItem(item: AgentInputItem): AgentInputItem {
  if (!isToolResultItem(item)) return item;
  const value = item as Record<string, unknown>;
  const field = Object.prototype.hasOwnProperty.call(value, 'output')
    ? 'output'
    : Object.prototype.hasOwnProperty.call(value, 'content')
      ? 'content'
      : undefined;
  if (!field) return item;
  const original = messageText(value[field]);
  const compacted = compactToolResultText(original);
  if (compacted === original) return item;
  return {
    ...value,
    [field]: compacted,
  } as unknown as AgentInputItem;
}

/**
 * Keep the configured recent window intact, extending it to the user message
 * that begins the containing turn so tool-heavy turns are never split.
 */
export function resolveRecentTurnBoundary(
  items: readonly AgentInputItem[],
  recentItemTarget: number,
): number {
  if (items.length <= 1) return 0;
  const target = Math.max(2, Math.min(items.length - 1, Math.floor(recentItemTarget)));
  const nominal = Math.max(1, items.length - target);
  for (let index = nominal; index >= 1; index -= 1) {
    if (isUserMessageItem(items[index])) return index;
  }
  return nominal;
}

function enforcePostCompactionBudget(
  items: AgentInputItem[],
  policy: ResolvedContextCompactionPolicy,
  modelContext?: ModelContextProfile,
): AgentInputItem[] {
  let bounded = items.map((item) => ({ ...item }));
  const exceeds = (): boolean => {
    if (policy.inputBudgetTokens !== undefined) {
      return estimateItemsTokens(bounded, modelContext?.tokenCalibration) > policy.inputBudgetTokens;
    }
    return estimateItemsCharacters(bounded) > policy.legacy.maxCharacters;
  };
  if (!exceeds()) return bounded;

  // Keep user requirements intact while reducing the least durable data first.
  // Tool results are recoverable by rerunning a tool; user messages are not.
  bounded = bounded.map((item, index) => index < 2 ? item : hardClipToolResultItem(item, 1_200));
  if (!exceeds()) return bounded;

  // Bound tool arguments and assistant prose without removing their paired
  // events or discarding any user request.
  bounded = bounded.map((item, index) => {
    if (index < 2 || isUserMessageItem(item) || isToolResultItem(item)) return item;
    return hardClipItemPayload(item, 2_000);
  });
  if (!exceeds()) return bounded;

  const latestUserIndex = findLastUserMessageIndex(bounded);
  bounded = bounded.map((item, index) => {
    if (index < 2 || isUserMessageItem(item) || isToolEventItem(item)) return item;
    return clipMessageItem(item, 4_000);
  });
  if (!exceeds()) return bounded;

  // An unusually large current request can exceed the configured window by
  // itself. Retain both ends and its full-text fingerprint in the ledger.
  if (latestUserIndex >= 0) bounded[latestUserIndex] = clipMessageItem(bounded[latestUserIndex], 12_000);
  if (!exceeds()) return bounded;

  // Tool events are represented in the deterministic ledger. Drop the oldest
  // raw events as call/result groups, so the remaining history is valid for
  // providers that require every tool result to have a matching call.
  for (let index = 2; exceeds() && index < bounded.length;) {
    if (isToolEventItem(bounded[index])) {
      removeToolEventGroupAt(bounded, index);
      continue;
    }
    index += 1;
  }
  if (!exceeds()) return bounded;

  // Remove old assistant prose before removing old user requirements. The
  // latest user message is always retained until the final unavoidable clip.
  for (let index = 2; exceeds() && index < bounded.length;) {
    const currentUserIndex = findLastUserMessageIndex(bounded);
    const item = bounded[index];
    if (isToolEventItem(item)) {
      removeToolEventGroupAt(bounded, index);
      continue;
    }
    if (index !== currentUserIndex && !isUserMessageItem(item)) {
      bounded.splice(index, 1);
      continue;
    }
    index += 1;
  }
  if (!exceeds()) return bounded;

  // Only now remove older user messages. This is the last structural removal
  // because the summary/ledger cannot be assumed to reproduce every original
  // constraint verbatim.
  for (let index = 2; exceeds() && index < bounded.length;) {
    const currentUserIndex = findLastUserMessageIndex(bounded);
    if (isUserMessageItem(bounded[index]) && index !== currentUserIndex) {
      bounded.splice(index, 1);
      continue;
    }
    index += 1;
  }
  if (!exceeds()) return bounded;

  const ledgerIndex = bounded.findIndex(isContextStateLedgerItem);
  if (ledgerIndex >= 0) bounded[ledgerIndex] = compactContextStateLedgerItem(bounded[ledgerIndex]);
  const summaryIndex = bounded.findIndex(isContextSummaryItem);
  if (summaryIndex >= 0 && summaryIndex < bounded.length) {
    bounded[summaryIndex] = clipMessageItem(bounded[summaryIndex], 6_000);
  }
  if (!exceeds()) return bounded;

  const currentUserIndex = findLastUserMessageIndex(bounded);
  if (currentUserIndex >= 0) bounded[currentUserIndex] = clipMessageItem(bounded[currentUserIndex], 2_000);
  return bounded;
}

function isWithinCompactionBudget(
  items: AgentInputItem[],
  policy: ResolvedContextCompactionPolicy,
  modelContext?: ModelContextProfile,
): boolean {
  if (policy.inputBudgetTokens !== undefined) {
    return estimateItemsTokens(items, modelContext?.tokenCalibration) <= policy.inputBudgetTokens;
  }
  return estimateItemsCharacters(items) <= policy.legacy.maxCharacters;
}

function isToolCallItem(item: AgentInputItem): boolean {
  const value = item as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : '';
  return type === 'function_call' || type === 'tool_call' || type.endsWith('_call') ||
    (type === 'message' && Array.isArray(value.tool_calls));
}

function isToolEventItem(item: AgentInputItem): boolean {
  return isToolResultItem(item) || isToolCallItem(item);
}

function toolEventIds(item: AgentInputItem): string[] {
  const value = item as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : '';
  const ids = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate === 'string' && candidate.trim()) ids.add(candidate.trim());
  };
  add(value.callId);
  add(value.call_id);
  add(value.tool_call_id);
  add(value.toolCallId);
  if (isToolCallItem(item) && type !== 'message') add(value.id);
  if (type === 'message') {
    if (Array.isArray(value.tool_calls)) {
      for (const toolCall of value.tool_calls) {
        if (!toolCall || typeof toolCall !== 'object') continue;
        const call = toolCall as Record<string, unknown>;
        add(call.id);
        add(call.callId);
        add(call.call_id);
      }
    }
    if (value.function_call && typeof value.function_call === 'object') {
      const call = value.function_call as Record<string, unknown>;
      add(call.id);
      add(call.callId);
      add(call.call_id);
    }
  }
  return [...ids];
}

function findToolEventGroupIndices(items: AgentInputItem[], index: number): number[] {
  const seed = items[index];
  const ids = new Set(toolEventIds(seed));
  const group = new Set<number>([index]);
  if (ids.size > 0) {
    for (let candidate = 2; candidate < items.length; candidate += 1) {
      if (!isToolEventItem(items[candidate])) continue;
      if (toolEventIds(items[candidate]).some((id) => ids.has(id))) group.add(candidate);
    }
  } else if (isToolCallItem(seed)) {
    for (let candidate = index + 1; candidate < items.length; candidate += 1) {
      if (isToolResultItem(items[candidate])) {
        group.add(candidate);
        break;
      }
      if (isUserMessageItem(items[candidate]) ||
        ((items[candidate] as Record<string, unknown>).type === 'message' && !isToolCallItem(items[candidate]))) break;
    }
  } else if (isToolResultItem(seed)) {
    for (let candidate = index - 1; candidate >= 2; candidate -= 1) {
      if (isToolCallItem(items[candidate])) {
        group.add(candidate);
        break;
      }
      if (isUserMessageItem(items[candidate]) ||
        ((items[candidate] as Record<string, unknown>).type === 'message' && !isToolResultItem(items[candidate]))) break;
    }
  }
  return [...group];
}

function removeToolEventGroupAt(items: AgentInputItem[], index: number): void {
  const indices = findToolEventGroupIndices(items, index).sort((left, right) => right - left);
  for (const removalIndex of indices) items.splice(removalIndex, 1);
}

function hardClipToolResultItem(item: AgentInputItem, maxCharacters: number): AgentInputItem {
  if (!isToolResultItem(item)) return item;
  const value = item as Record<string, unknown>;
  const field = Object.prototype.hasOwnProperty.call(value, 'output')
    ? 'output'
    : Object.prototype.hasOwnProperty.call(value, 'content')
      ? 'content'
      : undefined;
  if (!field) return item;
  const original = messageText(value[field]);
  if (original.length <= maxCharacters) return item;
  return {
    ...value,
    [field]: clipContentValue(value[field], maxCharacters, true),
  } as unknown as AgentInputItem;
}

function hardClipItemPayload(item: AgentInputItem, maxCharacters: number): AgentInputItem {
  if (isToolResultItem(item)) return hardClipToolResultItem(item, maxCharacters);
  const value = item as Record<string, unknown>;
  if (value.type === 'message') return clipMessageItem(item, maxCharacters);
  if (typeof value.arguments === 'string' && value.arguments.length > maxCharacters) {
    return { ...value, arguments: middleClip(value.arguments, maxCharacters) } as unknown as AgentInputItem;
  }
  return item;
}

function clipMessageItem(item: AgentInputItem, maxCharacters: number): AgentInputItem {
  const value = item as Record<string, unknown>;
  const text = messageText(value.content);
  if (text.length <= maxCharacters) return item;
  return { ...value, content: clipContentValue(value.content, maxCharacters, false) } as unknown as AgentInputItem;
}

function clipContentValue(value: unknown, maxCharacters: number, includeMarker: boolean): unknown {
  const decorate = (text: string): string => includeMarker
    ? `${CONTEXT_TOOL_RESULT_CLIP_MARKER}\n${text}`
    : text;
  if (typeof value === 'string') {
    return decorate(middleClip(value, maxCharacters));
  }
  if (!Array.isArray(value)) {
    return decorate(middleClip(messageText(value), maxCharacters));
  }

  const text = value.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
      return (part as Record<string, unknown>).text as string;
    }
    return '';
  }).join('');
  const clipped = decorate(middleClip(text, maxCharacters));
  let assigned = false;
  return value.map((part) => {
    if (typeof part === 'string') {
      if (assigned) return '';
      assigned = true;
      return clipped;
    }
    if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
      if (assigned) return { ...(part as Record<string, unknown>), text: '' };
      assigned = true;
      return { ...(part as Record<string, unknown>), text: clipped };
    }
    return part;
  });
}

function findLastUserMessageIndex(items: readonly AgentInputItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isUserMessageItem(items[index])) return index;
  }
  return -1;
}

function compactToolResultText(value: string, maxCharacters = 4_000): string {
  const lines = value.split(/\r?\n/);
  if (lines.length > 12) {
    const head = lines.slice(0, 6).join('\n');
    const tail = lines.slice(-6).join('\n');
    return [
      CONTEXT_TOOL_RESULT_CLIP_MARKER,
      head,
      `...[工具回执中间省略 ${Math.max(0, lines.length - 12)} 行]...`,
      tail,
    ].join('\n');
  }
  if (value.length <= maxCharacters) return value;
  return `${CONTEXT_TOOL_RESULT_CLIP_MARKER}\n${middleClip(value, maxCharacters)}`;
}

function serializeItemForTranscript(item: AgentInputItem): string {
  const value = item as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : 'unknown';
  if (type === 'message' || typeof value.role === 'string') {
    const role = typeof value.role === 'string' ? value.role : 'unknown';
    return `${role}: ${middleClip(messageText(value.content), 4_000)}`;
  }
  if (type === 'function_call') {
    return `tool_call ${String(value.name ?? 'tool')}: ${middleClip(String(value.arguments ?? ''), 2_000)}`;
  }
  if (type === 'function_call_result') {
    return `tool_result ${String(value.name ?? 'tool')}: ${middleClip(messageText(value.output), 2_000)}`;
  }
  return `${type}: ${middleClip(serializeItem(item), 2_000)}`;
}

function serializeItem(item: AgentInputItem): string {
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') return text;
      }
      return serializeUnknown(part);
    }).join('');
  }
  return serializeUnknown(value);
}

function serializeUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function middleClip(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  const half = Math.max(1, Math.floor((maxCharacters - 40) / 2));
  return `${value.slice(0, half)}\n...[中间省略 ${value.length - half * 2} 字符]...\n${value.slice(-half)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function nonNegativeInteger(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}
