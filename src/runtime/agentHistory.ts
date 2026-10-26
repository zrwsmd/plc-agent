import type { AgentInputItem, Session } from "@openai/agents";
import {
  parseToolResult,
  type ToolResult,
} from "../protocol/results";
import type { ToolCatalog } from "./toolCatalog";

function sessionOutputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => sessionOutputText(item))
      .filter((item): item is string => Boolean(item))
      .join("");
    return text || undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if ("output" in record) return sessionOutputText(record.output);
    if ("content" in record) return sessionOutputText(record.content);
  }
  return undefined;
}

export async function loadHistoricalToolResults(
  session: Session,
  userText: string,
): Promise<Array<{ name: string; args: string; result: ToolResult; order: number }>> {
  const calls = new Map<string, { name: string; args: string }>();
  const records: Array<{ name: string; args: string; result: ToolResult; order: number }> = [];
  let items: AgentInputItem[] = [];
  try {
    items = await session.getItems();
  } catch {
    return records;
  }
  const startIndex = [...items]
    .map((item, index) => ({ item, index }))
    .reverse()
    .find(({ item }) => {
      const value = item as { type?: string; role?: string; content?: unknown };
      return value.type === "message" &&
        value.role === "user" &&
        typeof value.content === "string" &&
        value.content === userText;
    })?.index ?? 0;
  let order = 0;
  for (const raw of items.slice(startIndex)) {
    const item = raw as {
      type?: string;
      callId?: string;
      name?: string;
      arguments?: string;
      output?: unknown;
    };
    if (item.type === "function_call" && item.callId && item.name) {
      calls.set(item.callId, {
        name: item.name,
        args: typeof item.arguments === "string" ? item.arguments : "",
      });
      continue;
    }
    if (
      item.type !== "function_call_result" &&
      item.type !== "function_call_output"
    ) {
      continue;
    }
    const call = item.callId ? calls.get(item.callId) : undefined;
    const text = sessionOutputText(item.output);
    if (!call || !text) continue;
    try {
      records.push({
        ...call,
        result: parseToolResult(JSON.parse(text)),
        order: ++order,
      });
    } catch {
      // Ignore non-protocol historical tool output.
    }
  }
  return records;
}

export function toolNameOf(item: unknown): string | undefined {
  const name = (item as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Apply a workflow/fallback allowlist only to provider-owned business tools.
 *
 * Runtime control tools are created by the agent runtime itself and must stay
 * available whenever the current run requires them. Keeping the two groups
 * separate prevents a narrow business-tool policy from disabling plan
 * progress, artifact delivery, or future runtime controls.
 */
export function composeToolSet<T>(
  businessTools: readonly T[],
  runtimeControlTools: readonly T[],
  allowedToolNames: readonly string[] | undefined,
  getName: (item: T) => string | undefined = (item) => toolNameOf(item),
): T[] {
  const visibleBusinessTools = allowedToolNames
    ? businessTools.filter((item) => {
        const name = getName(item);
        return typeof name === "string" && allowedToolNames.includes(name);
      })
    : [...businessTools];
  return [...visibleBusinessTools, ...runtimeControlTools];
}

export function renderAvailableToolsPrompt(
  toolNames: readonly string[],
  toolCatalog: ToolCatalog,
): string {
  const orderedToolNames = toolCatalog.orderToolNames(toolNames);
  if (orderedToolNames.length === 0) {
    return "\n\n当前没有可调用工具。不要尝试调用任何工具，只能用文字回答或说明阻塞原因。";
  }
  return (
    "\n\n当前可用工具及其用途（只能调用下面列出的工具；用途和风险说明仅用于选择，" +
    "实际权限仍由运行时审批、策略和工具回执决定）：\n" +
    toolCatalog.renderToolCapabilityPrompt(orderedToolNames) +
    "\n只能调用上面列出的工具；不要调用未列出的工具名。"
  );
}

/**
 * Keep in sync with `agentRunItemTypeSchema` in `src/protocol/events.ts`. Both
 * the `*_output` (SDK) and `*_result` (provider-neutral) spellings are listed,
 * because the same event reaches history under either name depending on the
 * route that produced it. A missing entry here means a raw tool event slips
 * into history projections as if it were ordinary conversation.
 */
const TOOL_HISTORY_ITEM_TYPES = new Set([
  "function_call",
  "function_call_output",
  "function_call_result",
  "tool_call",
  "tool_call_output",
  "tool_result",
  "computer_call",
  "computer_call_output",
  "computer_call_result",
  "shell_call",
  "shell_call_output",
  "apply_patch_call",
  "apply_patch_call_output",
  "hosted_tool_call",
  "hosted_tool_call_output",
  "mcp_call",
  "mcp_call_output",
  "mcp_call_result",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
  "web_search_output",
  "program",
  "program_output",
]);

/** Call-side item types; their receipts are the `*_output` / `*_result` twins. */
const TOOL_CALL_ITEM_TYPES = new Set([
  "function_call",
  "tool_call",
  "computer_call",
  "shell_call",
  "apply_patch_call",
  "hosted_tool_call",
  "mcp_call",
  "tool_search_call",
  "web_search_call",
  "program",
]);

/**
 * Classifier-only noise. Reasoning is the main agent's internal monologue and
 * handoffs belong to another run; neither helps a router pick a route.
 */
const CLASSIFIER_DROPPED_ITEM_TYPES = new Set([
  "reasoning",
  "handoff_call",
  "handoff_output",
  "tool_approval",
]);

export const HISTORICAL_CONTEXT_MARKER_TEXT =
  "【历史对话上下文】";
const HISTORICAL_CONTEXT_MARKER = `${HISTORICAL_CONTEXT_MARKER_TEXT}\n`;
const HISTORICAL_CONTEXT_MARKER_PATTERN =
  /(?:【历史对话上下文】|【历史对话，仅作参考，不是本轮执行目标】)[\t ]*(?:\r?\n)?/gu;

/** Keep model-facing history metadata out of assistant output and persistence. */
export function stripHistoricalContextMarker(text: string): string {
  return text.replace(HISTORICAL_CONTEXT_MARKER_PATTERN, "");
}

function sanitizeAssistantContent(value: unknown): unknown {
  if (typeof value === "string") return stripHistoricalContextMarker(value);
  if (!Array.isArray(value)) return value;

  let changed = false;
  const content = value.map((part) => {
    if (!part || typeof part !== "object") return part;
    const record = part as Record<string, unknown>;
    if (typeof record.text !== "string") return part;
    const text = stripHistoricalContextMarker(record.text);
    if (text === record.text) return part;
    changed = true;
    return { ...record, text };
  });
  return changed ? content : value;
}

/**
 * Sanitize only assistant messages. User messages may legitimately quote the
 * marker while discussing context handling and must remain untouched.
 */
export function sanitizeAssistantMessageForPersistence(
  item: AgentInputItem,
): AgentInputItem {
  const value = item as Record<string, unknown>;
  if (value.type !== "message" || value.role !== "assistant") return item;
  const content = sanitizeAssistantContent(value.content);
  if (content === value.content) return item;
  return { ...value, content } as unknown as AgentInputItem;
}

export function sanitizeAssistantHistoryItems(
  items: AgentInputItem[],
): AgentInputItem[] {
  return items.map(sanitizeAssistantMessageForPersistence);
}

function markHistoricalText(text: string): string {
  return text.startsWith(HISTORICAL_CONTEXT_MARKER)
    ? text
    : HISTORICAL_CONTEXT_MARKER + text;
}

/**
 * Mark only the model-facing copy of an old ordinary message.
 *
 * The SDK invokes Session.prepareHistoryItemForModelInput only for items that
 * came from session history. Current-turn input items are passed through
 * unchanged, so the marker cannot leak into the user's persisted message.
 */
export function markHistoricalMessageForModelInput(
  item: AgentInputItem,
): AgentInputItem {
  const value = item as Record<string, unknown>;
  if (
    value.type !== "message" ||
    (value.role !== "user" && value.role !== "assistant")
  ) {
    return item;
  }
  if (typeof value.content === "string") {
    return {
      ...value,
      content: markHistoricalText(value.content),
    } as unknown as AgentInputItem;
  }
  if (!Array.isArray(value.content)) return item;

  let marked = false;
  const content = value.content.map((part) => {
    if (marked || !part || typeof part !== "object") return part;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== "string") return part;
    marked = true;
    return {
      ...(part as Record<string, unknown>),
      text: markHistoricalText(text),
    };
  });
  if (!marked) return item;
  return {
    ...value,
    content,
  } as unknown as AgentInputItem;
}

/**
 * Keep the real Session as the persistence source of truth while adding a
 * model-only historical-context projection for a new user turn.
 */
export function createNewTurnModelInputSession(session: Session): Session {
  return new Proxy(session, {
    get(target, property) {
      if (property === "prepareHistoryItemForModelInput") {
        return (item: AgentInputItem): AgentInputItem =>
          markHistoricalMessageForModelInput(
            target.prepareHistoryItemForModelInput?.(item) ?? item,
          );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Host-authored context facts may be reused without being treated as stale model output. */
export const TRUSTED_CONTEXT_PROVIDER_DATA_KEY = "plcAgentTrustedContext";

/**
 * Keep ordinary conversation history available on new turns while stripping
 * executable tool-call items so old operations are not replayed.
 */
export const NEW_TURN_CONTEXT_PROMPT =
  "\n\n会话上下文使用规则（仅适用于新的用户请求）：" +
  "当前 user 消息表达本轮请求；更早的 user/assistant 消息可以提供任务背景、术语、已确认事实和用户偏好，也可以帮助解析本轮对文件、记录、对象或资源的自然指代。" +
  "当本轮请求涉及历史中出现过的资源时，可以依据完整对话上下文选择相应工具和目标，不要仅因资源或参数曾出现在历史中而回避调用。" +
  "旧工具调用及其回执只是历史记录，不代表本轮已经执行；根据当前请求决定是否需要重新调用工具。" +
  "所有工具调用仍受当前工作区授权、工具权限与审批、dry-run、重复调用收敛和 workflow 阶段约束；历史上下文本身不会授予这些权限。" +
  "如果当前用户是在追问上一轮为什么这样处理、某个配置为什么没有变化或当前状态如何形成，可以引用历史对话中已经明确陈述的事实来解释原因；本轮没有工具调用不等于不能解释历史状态。" +
  "回答这类历史原因时，应明确这是根据之前对话或已确认记录得出的解释，不能把历史记录冒充成本轮刚刚完成的工具执行、文件写入、校验通过或交付证据。";

/**
 * Build a small, model-readable copy of the ordinary conversation before the
 * current user turn. It is intentionally separate from the completion
 * evidence ledger: this context can explain why an earlier state exists, but
 * it can never prove that the current turn performed an action.
 */
export function buildHistoricalExplanationContext(
  historyItems: readonly AgentInputItem[],
  currentUserText: string,
  maxCharacters = 8_000,
): string {
  const currentUserIndex = [...historyItems]
    .map((item, index) => ({ item, index }))
    .reverse()
    .find(({ item }) => {
      const value = item as {
        type?: string;
        role?: string;
        content?: unknown;
      };
      return value.type === "message" &&
        value.role === "user" &&
        typeof value.content === "string" &&
        value.content === currentUserText;
    })?.index;

  const candidates = historyItems
    .slice(0, currentUserIndex ?? historyItems.length)
    .filter((item) => {
      const value = item as { type?: string; role?: string };
      return value.type === "message" &&
        (value.role === "user" || value.role === "assistant");
    })
    .map((item) => {
      const value = item as {
        role?: string;
        content?: unknown;
      };
      let text = sessionOutputText(value.content)?.trim() ?? "";
      if (value.role === "assistant") {
        const trimmed = text.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            const parsed = JSON.parse(trimmed) as {
              message?: unknown;
            };
            if (typeof parsed.message === "string") {
              text = parsed.message.trim();
            }
          } catch {
            // Keep non-JSON assistant text as-is.
          }
        }
      }
      text = stripHistoricalContextMarker(text);
      if (!text) return undefined;
      return `${value.role === "user" ? "用户" : "助手"}：${text}`;
    })
    .filter((item): item is string => Boolean(item));

  if (candidates.length === 0) return "";
  const full = candidates.slice(-12).join("\n");
  if (full.length <= maxCharacters) return full;
  return `…${full.slice(-(Math.max(1, maxCharacters) - 1))}`;
}

/**
 * Project persistent history for a genuinely new user turn.
 *
 * The durable session remains untouched. Only the model-facing input omits
 * executable tool-call/result items from older turns, so a previous workflow
 * cannot be replayed as if it belonged to the current request.
 */
export function isToolHistoryItem(item: AgentInputItem): boolean {
  const value = item as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : "";
  if (TOOL_HISTORY_ITEM_TYPES.has(type)) return true;
  if (value.role === "tool") return true;
  if (
    value.role === "assistant" &&
    (Array.isArray(value.tool_calls) || value.function_call !== undefined)
  ) {
    return true;
  }
  return false;
}

export function projectNewTurnSessionHistory(
  historyItems: AgentInputItem[],
  newItems: AgentInputItem[],
): AgentInputItem[] {
  return [
    ...historyItems.filter((item) => !isToolHistoryItem(item)),
    ...newItems,
  ];
}

const MAX_STRUCTURED_UNWRAP_DEPTH = 4;
const CLASSIFIER_TOOL_RECORD_LIMIT = 12;
const CLASSIFIER_TOOL_TARGET_MAX = 80;

interface ClassifierToolEvent {
  name: string;
  callId?: string;
  target?: string;
  outcome?: "ok" | "failed";
}

/**
 * Project history for the auxiliary classifiers (task plan, delivery contract,
 * workflow route, team route).
 *
 * Those roles only pick a route; they must not imitate the main agent. Two
 * things in durable history push them the wrong way:
 *
 * 1. Each finished turn is stored as the raw `IndustrialAgentOutput` JSON, so
 *    feeding it verbatim gives the model a much stronger pattern than the
 *    schema instruction in its prompt and it answers in the agent's shape.
 * 2. Each finished turn also stores its tool calls and tool receipts. A model
 *    that sees "assistant called a tool, tool returned a result" right before
 *    the new request tends to continue that turn instead of routing it, and a
 *    role that has no tools bound can only imitate the call in plain text.
 *
 * So the projection keeps the ordinary conversation and replaces the executable
 * tool trail with a short plain-text record of what the previous turns did.
 * The record is deliberately worded as history: it must never read as evidence
 * that the current turn already ran anything.
 */
export function projectHistoryForClassifier(
  items: readonly AgentInputItem[],
): AgentInputItem[] {
  const events: ClassifierToolEvent[] = [];
  const conversation: AgentInputItem[] = [];
  for (const item of items) {
    const type = (item as { type?: unknown }).type;
    if (typeof type === "string" && CLASSIFIER_DROPPED_ITEM_TYPES.has(type)) {
      continue;
    }
    events.push(...classifierToolCalls(item));
    const outcome = classifierToolOutcome(item);
    if (outcome) attachClassifierToolOutcome(events, item, outcome);
    if (isToolHistoryItem(item)) {
      const textOnly = assistantMessageWithoutToolCalls(item);
      if (textOnly) conversation.push(unwrapStructuredAssistantMessage(textOnly));
      continue;
    }
    conversation.push(unwrapStructuredAssistantMessage(item));
  }
  const tidied = tidyClassifierMessages(conversation);
  const record = classifierToolRecord(events);
  if (!record || !tidied.length) return tidied;
  const last = tidied[tidied.length - 1] as Record<string, unknown>;
  if (last.role === "assistant") {
    tidied[tidied.length - 1] = {
      ...last,
      content: appendMessageText(last, record),
    } as unknown as AgentInputItem;
    return tidied;
  }
  tidied.push({
    type: "message",
    role: "assistant",
    content: record,
  } as unknown as AgentInputItem);
  return tidied;
}

/**
 * Append text without flattening existing content parts. Rewriting an array of
 * parts into a plain string would drop the per-part metadata (for example the
 * `output_text` annotations) that the provider may still expect back.
 */
function appendMessageText(
  value: Record<string, unknown>,
  extra: string,
): unknown {
  const content = value.content;
  if (Array.isArray(content)) {
    const partType = value.role === "user" ? "input_text" : "output_text";
    return [...content, { type: partType, text: extra }];
  }
  const text = typeof content === "string" ? content : "";
  return text ? `${text}\n${extra}` : extra;
}

/**
 * A message is empty only when it carries nothing at all. An image-only user
 * turn has no extractable text but still matters to the conversation.
 */
function messageHasPayload(value: Record<string, unknown>): boolean {
  const content = value.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return content !== undefined && content !== null;
}

function classifierToolCalls(item: AgentInputItem): ClassifierToolEvent[] {
  const value = item as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : "";
  const events: ClassifierToolEvent[] = [];
  if (value.role === "assistant" && Array.isArray(value.tool_calls)) {
    for (const call of value.tool_calls) {
      if (!call || typeof call !== "object") continue;
      const record = call as Record<string, unknown>;
      const fn =
        record.function && typeof record.function === "object"
          ? (record.function as Record<string, unknown>)
          : record;
      const name = typeof fn.name === "string" ? fn.name.trim() : "";
      if (!name) continue;
      events.push({
        name,
        callId: typeof record.id === "string" ? record.id : undefined,
        target: classifierToolTarget(fn.arguments),
      });
    }
  }
  if (value.role === "assistant" && value.function_call !== undefined) {
    const fn =
      value.function_call && typeof value.function_call === "object"
        ? (value.function_call as Record<string, unknown>)
        : {};
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (name) {
      events.push({ name, target: classifierToolTarget(fn.arguments) });
    }
  }
  if (TOOL_CALL_ITEM_TYPES.has(type)) {
    const name =
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : classifierToolNameFromType(type);
    events.push({
      name,
      callId: typeof value.callId === "string" ? value.callId : undefined,
      target: classifierToolTarget(value.arguments),
    });
  }
  return events;
}

/**
 * Hosted events such as `web_search_call` and `program` carry no tool name.
 * The record still needs a label, so fall back to the event type itself.
 */
function classifierToolNameFromType(type: string): string {
  return type.replace(/_(?:call|output|result)$/u, "") || type;
}

/** Only the primary path-like argument is kept; the record must stay short. */
function classifierToolTarget(args: unknown): string | undefined {
  let parsed: unknown = args;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const candidate = record.path ?? record.file ?? record.targetPath;
  if (typeof candidate !== "string") return undefined;
  const text = candidate.trim();
  if (!text) return undefined;
  return text.length > CLASSIFIER_TOOL_TARGET_MAX
    ? `…${text.slice(-(CLASSIFIER_TOOL_TARGET_MAX - 1))}`
    : text;
}

function classifierToolOutcome(
  item: AgentInputItem,
): "ok" | "failed" | undefined {
  const value = item as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : "";
  const isReceipt =
    value.role === "tool" || /(?:_output|_result)$/u.test(type);
  if (!isReceipt) return undefined;
  const text =
    sessionOutputText(value.output ?? value.content)?.trim() ?? "";
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(text) as { ok?: unknown };
    if (parsed.ok === true) return "ok";
    if (parsed.ok === false) return "failed";
  } catch {
    return undefined;
  }
  return undefined;
}

function attachClassifierToolOutcome(
  events: ClassifierToolEvent[],
  item: AgentInputItem,
  outcome: "ok" | "failed",
): void {
  const value = item as Record<string, unknown>;
  const callId =
    typeof value.callId === "string"
      ? value.callId
      : typeof value.tool_call_id === "string"
        ? value.tool_call_id
        : undefined;
  if (callId) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.callId === callId && !event.outcome) {
        event.outcome = outcome;
        return;
      }
    }
    // The receipt names a call that history does not contain. Guessing which
    // call it belongs to would report one tool's failure against another, so
    // the outcome stays unknown.
    return;
  }
  // Older entries carry no call id, so order is the only signal available:
  // take the oldest call that is still waiting for a receipt.
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event.callId && !event.outcome) {
      event.outcome = outcome;
      return;
    }
  }
}

/**
 * An assistant turn that called tools usually also carries the sentence the
 * model wrote before calling. That sentence is ordinary conversation and must
 * survive; only the callable part is removed.
 */
function assistantMessageWithoutToolCalls(
  item: AgentInputItem,
): AgentInputItem | undefined {
  const value = item as Record<string, unknown>;
  if (value.role !== "assistant") return undefined;
  if (value.tool_calls === undefined && value.function_call === undefined) {
    return undefined;
  }
  const rest: Record<string, unknown> = { ...value };
  delete rest.tool_calls;
  delete rest.function_call;
  if (!messageHasPayload(rest)) return undefined;
  return rest as unknown as AgentInputItem;
}

/** Drop messages with no payload and fold adjacent same-role messages. */
function tidyClassifierMessages(
  items: readonly AgentInputItem[],
): AgentInputItem[] {
  const result: AgentInputItem[] = [];
  for (const item of items) {
    const value = item as Record<string, unknown>;
    const isMessage =
      value.type === "message" || typeof value.role === "string";
    if (!isMessage) {
      result.push(item);
      continue;
    }
    if (!messageHasPayload(value)) continue;
    const role = typeof value.role === "string" ? value.role : "assistant";
    const previous = result[result.length - 1] as
      | Record<string, unknown>
      | undefined;
    if (previous && previous.role === role) {
      result[result.length - 1] = {
        ...previous,
        content: mergeMessageContent(previous, value),
      } as unknown as AgentInputItem;
      continue;
    }
    result.push(item);
  }
  return result;
}

/**
 * Merge two adjacent same-role messages without losing parts. Extracting the
 * text and appending only that would silently drop images, files and any other
 * non-text part carried by the second message.
 */
function mergeMessageContent(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): unknown {
  const targetContent = target.content;
  const sourceContent = source.content;
  if (typeof targetContent === "string" && typeof sourceContent === "string") {
    const left = targetContent.trim();
    const right = sourceContent.trim();
    if (!left) return right;
    if (!right) return left;
    return `${left}\n${right}`;
  }
  const incoming = messageContentParts(source);
  if (!incoming.length) return targetContent;
  return [...messageContentParts(target), ...incoming];
}

function messageContentParts(value: Record<string, unknown>): unknown[] {
  const content = value.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string" && content.trim()) {
    return [
      {
        type: value.role === "user" ? "input_text" : "output_text",
        text: content.trim(),
      },
    ];
  }
  return [];
}

function classifierToolRecord(events: readonly ClassifierToolEvent[]): string {
  if (!events.length) return "";
  const recent = events.slice(-CLASSIFIER_TOOL_RECORD_LIMIT);
  const omitted = events.length - recent.length;
  const lines = recent.map((event) => {
    const target = event.target ? `(${event.target})` : "";
    const outcome =
      event.outcome === "ok" ? " 成功" : event.outcome === "failed" ? " 失败" : "";
    return `- ${event.name}${target}${outcome}`;
  });
  const header =
    omitted > 0
      ? `（历史工具调用记录，较早的 ${omitted} 次已省略。这是之前轮次发生了什么，不是本轮已经执行。）`
      : "（历史工具调用记录。这是之前轮次发生了什么，不是本轮已经执行。）";
  return `${header}\n${lines.join("\n")}`;
}

function unwrapStructuredAssistantMessage(item: AgentInputItem): AgentInputItem {
  const value = item as Record<string, unknown>;
  if (value.role !== "assistant") return item;
  if (typeof value.content === "string") {
    const text = unwrapStructuredOutputText(value.content);
    if (text === value.content) return item;
    return { ...value, content: text } as unknown as AgentInputItem;
  }
  if (!Array.isArray(value.content)) return item;

  let changed = false;
  const content = value.content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const record = part as Record<string, unknown>;
    if (typeof record.text !== "string") return part;
    const text = unwrapStructuredOutputText(record.text);
    if (text === record.text) return part;
    changed = true;
    return { ...record, text };
  });
  if (!changed) return item;
  return { ...value, content } as unknown as AgentInputItem;
}

function unwrapStructuredOutputText(text: string, depth = 0): string {
  if (depth >= MAX_STRUCTURED_UNWRAP_DEPTH) return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }
  if (Array.isArray(parsed)) {
    // SDK content parts: pull the text out and unwrap whatever it holds.
    const parts = parsed
      .map((part) => (part && typeof part === "object"
        ? (part as { text?: unknown }).text
        : undefined))
      .filter((entry): entry is string => typeof entry === "string");
    if (!parts.length) return text;
    return unwrapStructuredOutputText(parts.join(""), depth + 1);
  }
  const message = (parsed as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) {
    return unwrapStructuredOutputText(message, depth + 1);
  }
  return text;
}
