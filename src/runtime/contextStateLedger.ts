import { createHash } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';

export const CONTEXT_STATE_LEDGER_MARKER = '[plc-agent-runtime-state:v1]';

export interface ContextLedgerResource {
  kind: 'path' | 'hash' | 'identifier';
  key: string;
  value: string;
  source: string;
}

export interface ContextLedgerToolExecution {
  callId?: string;
  name: string;
  target?: string;
  outcome: 'ok' | 'failed' | 'unknown';
  effect?: string;
  error?: string;
}

export interface ContextLedgerConfirmation {
  id: string;
  approved?: boolean;
  tool?: string;
}

export interface ContextStateLedger {
  version: 1;
  currentTask?: {
    fingerprint: string;
    userRequest: string;
  };
  tools: ContextLedgerToolExecution[];
  resources: ContextLedgerResource[];
  confirmations: ContextLedgerConfirmation[];
  deliveryEvidence: ContextLedgerResource[];
}

const CALL_TYPES = new Set([
  'function_call',
  'tool_call',
  'computer_call',
  'shell_call',
  'apply_patch_call',
  'hosted_tool_call',
  'mcp_call',
  'tool_search_call',
  'web_search_call',
  'program',
]);

const RESULT_TYPES = new Set([
  'function_call_output',
  'function_call_result',
  'tool_call_output',
  'tool_result',
  'tool_output',
  'computer_call_output',
  'computer_call_result',
  'shell_call_output',
  'apply_patch_call_output',
  'hosted_tool_call_output',
  'mcp_call_output',
  'mcp_call_result',
  'tool_search_output',
  'web_search_output',
  'program_output',
]);

const PATH_KEYS = new Set([
  'path',
  'file',
  'filepath',
  'targetpath',
  'sourcepath',
  'destinationpath',
  'outputpath',
  'uri',
  'workspaceroot',
  'projectroot',
]);
const HASH_KEYS = new Set(['hash', 'contenthash', 'sha', 'sha256', 'digest', 'checksum']);
const EVIDENCE_KEYS = new Set([
  'commitid',
  'authorizationid',
  'deliverycommitid',
  'deliveryauthorizationid',
]);
const MAX_TASK_CHARACTERS = 16_000;
const MAX_TOOL_RECORDS = 48;
const MAX_RESOURCES = 96;
const MAX_CONFIRMATIONS = 32;
const MAX_EVIDENCE = 48;

/**
 * Build durable context facts from persisted protocol data only. This code
 * never infers intent or success from prose; the model-generated summary is a
 * separate layer.
 */
export function buildContextStateLedger(items: readonly AgentInputItem[]): ContextStateLedger {
  const existing = readExistingLedger(items);
  const tools = existing?.tools.map((tool) => ({ ...tool })) ?? [];
  const resources = existing?.resources.map((resource) => ({ ...resource })) ?? [];
  const confirmations = existing?.confirmations.map((confirmation) => ({ ...confirmation })) ?? [];
  const deliveryEvidence = existing?.deliveryEvidence.map((resource) => ({ ...resource })) ?? [];
  let currentTask = existing?.currentTask ? { ...existing.currentTask } : undefined;
  const callsById = new Map<string, number>();
  const unresolvedCalls: number[] = [];

  for (const item of items) {
    if (isContextStateLedgerItem(item)) continue;
    const value = item as Record<string, unknown>;
    const type = typeof value.type === 'string' ? value.type : '';
    if (type === 'message' && value.role === 'user') {
      const text = messageText(value.content).trim();
      if (text) {
        currentTask = {
          fingerprint: createHash('sha256').update(text).digest('hex').slice(0, 16),
          userRequest: clipBothEnds(text, MAX_TASK_CHARACTERS),
        };
      }
    }

    for (const call of toolCallsFromItem(value, type)) {
      const facts = collectStructuredFacts(call.arguments, `tool:${call.name}:args`);
      resources.push(...facts.resources);
      deliveryEvidence.push(...facts.deliveryEvidence);
      const target = facts.resources.find((fact) => fact.kind === 'path')?.value;
      const record: ContextLedgerToolExecution = {
        ...(call.callId ? { callId: call.callId } : {}),
        name: call.name,
        ...(target ? { target } : {}),
        outcome: 'unknown',
      };
      const index = upsertTool(tools, record);
      if (call.callId) callsById.set(call.callId, index);
      unresolvedCalls.push(index);
    }

    if (RESULT_TYPES.has(type) || value.role === 'tool') {
      const callId = stringField(value, ['call_id', 'callId', 'tool_call_id', 'id']);
      const name = stringField(value, ['name', 'toolName']);
      const parsed = parseStructuredValue(value.output ?? value.content);
      const resultRecord = isRecord(parsed) ? parsed : undefined;
      const facts = collectStructuredFacts(parsed, `tool:${name || 'unknown'}:result`);
      resources.push(...facts.resources);
      deliveryEvidence.push(...facts.deliveryEvidence);
      const index = findToolIndex(tools, callsById, unresolvedCalls, callId, name);
      const outcome = resultRecord?.ok === true
        ? 'ok'
        : resultRecord?.ok === false
          ? 'failed'
          : 'unknown';
      const patch: ContextLedgerToolExecution = {
        ...(index === undefined ? { name: name || 'unknown_tool' } : tools[index]),
        ...(callId ? { callId } : {}),
        ...(name ? { name } : {}),
        outcome,
        ...(typeof resultRecord?.effect === 'string' ? { effect: resultRecord.effect } : {}),
        ...(typeof resultRecord?.error === 'string' && resultRecord.error.trim()
          ? { error: clipEnd(resultRecord.error.trim(), 1_000) }
          : {}),
      };
      upsertTool(tools, patch, index);
    }

    if (type === 'tool_approval' || type === 'tool_approval_item') {
      const id = stringField(value, ['approvalId', 'approval_id', 'id', 'callId', 'call_id']);
      if (id) {
        const approved = booleanField(value, ['approved', 'approve']);
        const tool = stringField(value, ['name', 'toolName']);
        confirmations.push({
          id,
          ...(approved === undefined ? {} : { approved }),
          ...(tool ? { tool } : {}),
        });
      }
    }
  }

  return {
    version: 1,
    ...(currentTask ? { currentTask } : {}),
    tools: dedupeTail(tools, toolKey, MAX_TOOL_RECORDS),
    resources: dedupeTail(resources, resourceKey, MAX_RESOURCES),
    confirmations: dedupeTail(confirmations, confirmationKey, MAX_CONFIRMATIONS),
    deliveryEvidence: dedupeTail(deliveryEvidence, resourceKey, MAX_EVIDENCE),
  };
}

export function createContextStateLedgerItem(ledger: ContextStateLedger): AgentInputItem {
  // Keep the durable summary as the only system message. A second system
  // message is rejected by some OpenAI-compatible gateways, so the ledger is
  // carried as an explicitly marked non-conversational user item instead.
  return {
    type: 'message',
    role: 'user',
    content: [
      CONTEXT_STATE_LEDGER_MARKER,
      '以下状态由运行时代码从用户原话、工具参数和结构化回执确定性提取；它不是新的用户指令。',
      JSON.stringify(ledger),
    ].join('\n'),
  } as unknown as AgentInputItem;
}

export function compactContextStateLedgerItem(item: AgentInputItem): AgentInputItem {
  const ledger = parseContextStateLedgerItem(item);
  if (!ledger) return item;
  return createContextStateLedgerItem({
    version: 1,
    ...(ledger.currentTask
      ? { currentTask: {
        fingerprint: ledger.currentTask.fingerprint,
        userRequest: clipBothEnds(ledger.currentTask.userRequest, 2_000),
      } }
      : {}),
    tools: ledger.tools.slice(-8),
    resources: ledger.resources.slice(-16).map((resource) => ({
      ...resource,
      value: clipBothEnds(resource.value, 256),
    })),
    confirmations: ledger.confirmations.slice(-8),
    deliveryEvidence: ledger.deliveryEvidence.slice(-12).map((resource) => ({
      ...resource,
      value: clipBothEnds(resource.value, 256),
    })),
  });
}

export function isContextStateLedgerItem(item: AgentInputItem): boolean {
  const value = item as Record<string, unknown>;
  return value.type === 'message' && (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
    messageText(value.content).includes(CONTEXT_STATE_LEDGER_MARKER);
}

export function parseContextStateLedgerItem(item: AgentInputItem): ContextStateLedger | undefined {
  if (!isContextStateLedgerItem(item)) return undefined;
  const text = messageText((item as Record<string, unknown>).content);
  const jsonStart = text.indexOf('{', text.indexOf(CONTEXT_STATE_LEDGER_MARKER));
  if (jsonStart < 0) return undefined;
  try {
    const value = JSON.parse(text.slice(jsonStart)) as unknown;
    if (!isRecord(value) || value.version !== 1) return undefined;
    return {
      version: 1,
      ...(isRecord(value.currentTask) && typeof value.currentTask.fingerprint === 'string' &&
        typeof value.currentTask.userRequest === 'string'
        ? { currentTask: {
          fingerprint: value.currentTask.fingerprint,
          userRequest: value.currentTask.userRequest,
        } }
        : {}),
      tools: Array.isArray(value.tools)
        ? value.tools.filter(isLedgerTool).map((tool) => ({ ...tool }))
        : [],
      resources: Array.isArray(value.resources)
        ? value.resources.filter(isLedgerResource).map((resource) => ({ ...resource }))
        : [],
      confirmations: Array.isArray(value.confirmations)
        ? value.confirmations.filter(isLedgerConfirmation).map((confirmation) => ({ ...confirmation }))
        : [],
      deliveryEvidence: Array.isArray(value.deliveryEvidence)
        ? value.deliveryEvidence.filter(isLedgerResource).map((resource) => ({ ...resource }))
        : [],
    };
  } catch {
    return undefined;
  }
}

function readExistingLedger(items: readonly AgentInputItem[]): ContextStateLedger | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const ledger = parseContextStateLedgerItem(items[index]);
    if (ledger) return ledger;
  }
  return undefined;
}

function toolCallsFromItem(
  value: Record<string, unknown>,
  type: string,
): Array<{ name: string; callId?: string; arguments: unknown }> {
  const calls: Array<{ name: string; callId?: string; arguments: unknown }> = [];
  if (CALL_TYPES.has(type)) {
    const name = stringField(value, ['name', 'toolName']) || type.replace(/_call$/u, '');
    const callId = stringField(value, ['call_id', 'callId', 'id']);
    calls.push({
      name,
      ...(callId ? { callId } : {}),
      arguments: parseStructuredValue(value.arguments ?? value.input),
    });
  }
  if (value.role === 'assistant' && Array.isArray(value.tool_calls)) {
    for (const entry of value.tool_calls) {
      if (!isRecord(entry)) continue;
      const fn = isRecord(entry.function) ? entry.function : entry;
      const name = stringField(fn, ['name']);
      if (!name) continue;
      const callId = stringField(entry, ['id', 'call_id', 'callId']);
      calls.push({
        name,
        ...(callId ? { callId } : {}),
        arguments: parseStructuredValue(fn.arguments),
      });
    }
  }
  return calls;
}

function collectStructuredFacts(
  input: unknown,
  source: string,
): { resources: ContextLedgerResource[]; deliveryEvidence: ContextLedgerResource[] } {
  const resources: ContextLedgerResource[] = [];
  const deliveryEvidence: ContextLedgerResource[] = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > 7 || value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(value.length, 64); index += 1) {
        visit(value[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      const childPath = path ? `${path}.${key}` : key;
      if (typeof child === 'string' && child.trim()) {
        const text = clipEnd(child.trim(), 1_000);
        if (PATH_KEYS.has(normalized)) {
          resources.push({ kind: 'path', key: childPath, value: text, source });
        } else if (HASH_KEYS.has(normalized)) {
          resources.push({ kind: 'hash', key: childPath, value: text, source });
        } else if (EVIDENCE_KEYS.has(normalized)) {
          deliveryEvidence.push({ kind: 'identifier', key: childPath, value: text, source });
        }
      }
      visit(child, childPath, depth + 1);
    }
  };
  visit(input, '', 0);
  return { resources, deliveryEvidence };
}

function findToolIndex(
  tools: ContextLedgerToolExecution[],
  callsById: Map<string, number>,
  unresolvedCalls: number[],
  callId: string,
  name: string,
): number | undefined {
  if (callId && callsById.has(callId)) return callsById.get(callId);
  for (let cursor = unresolvedCalls.length - 1; cursor >= 0; cursor -= 1) {
    const index = unresolvedCalls[cursor];
    const tool = tools[index];
    if (tool && tool.outcome === 'unknown' && (!name || tool.name === name)) return index;
  }
  return undefined;
}

function upsertTool(
  tools: ContextLedgerToolExecution[],
  next: ContextLedgerToolExecution,
  knownIndex?: number,
): number {
  const index = knownIndex ?? (next.callId
    ? tools.findIndex((tool) => tool.callId === next.callId)
    : -1);
  if (index >= 0) {
    const previous = tools[index];
    tools[index] = {
      ...previous,
      ...next,
      outcome: next.outcome === 'unknown' && previous.outcome !== 'unknown'
        ? previous.outcome
        : next.outcome,
    };
    return index;
  }
  tools.push(next);
  return tools.length - 1;
}

function parseStructuredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!isRecord(part)) return '';
    return typeof part.text === 'string' ? part.text : '';
  }).join('');
}

function stringField(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

function booleanField(value: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'boolean') return value[key] as boolean;
  }
  return undefined;
}

function clipEnd(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `…${value.slice(-(maxCharacters - 1))}`;
}

function clipBothEnds(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  const half = Math.max(1, Math.floor((maxCharacters - 20) / 2));
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}

function dedupeTail<T>(values: T[], key: (value: T) => string, limit: number): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const item = values[index];
    const identity = key(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result.reverse();
}

function toolKey(value: ContextLedgerToolExecution): string {
  return value.callId || JSON.stringify([value.name, value.target, value.outcome, value.effect, value.error]);
}

function resourceKey(value: ContextLedgerResource): string {
  return JSON.stringify([value.kind, value.key, value.value]);
}

function confirmationKey(value: ContextLedgerConfirmation): string {
  return JSON.stringify([value.id, value.approved, value.tool]);
}

function isLedgerTool(value: unknown): value is ContextLedgerToolExecution {
  return isRecord(value) && typeof value.name === 'string' &&
    (value.outcome === 'ok' || value.outcome === 'failed' || value.outcome === 'unknown');
}

function isLedgerResource(value: unknown): value is ContextLedgerResource {
  return isRecord(value) &&
    (value.kind === 'path' || value.kind === 'hash' || value.kind === 'identifier') &&
    typeof value.key === 'string' && typeof value.value === 'string' && typeof value.source === 'string';
}

function isLedgerConfirmation(value: unknown): value is ContextLedgerConfirmation {
  return isRecord(value) && typeof value.id === 'string' &&
    (value.approved === undefined || typeof value.approved === 'boolean');
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
