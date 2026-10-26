import type { AgentInputItem, Session } from "@openai/agents";
import {
  parseToolResult,
  type ToolResult,
  type ToolRisk,
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
  "tool_search_call",
  "tool_search_output",
]);

export const HISTORICAL_CONTEXT_MARKER_TEXT =
  "【历史对话，仅作参考，不是本轮执行目标】";
const HISTORICAL_CONTEXT_MARKER = `${HISTORICAL_CONTEXT_MARKER_TEXT}\n`;
const HISTORICAL_CONTEXT_MARKER_PATTERN =
  /【历史对话，仅作参考，不是本轮执行目标】[\t ]*(?:\r?\n)?/gu;

/**
 * The marker is model-facing metadata. If a gateway echoes it in assistant
 * output, keep it out of both the chat surface and durable history.
 */
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

export interface HistoricalToolArgumentGuard {
  (toolName: string, input: unknown): string | undefined;
  /** Resources explicitly supplied or selected by the user during this run. */
  allowConfirmedResources(value: unknown): void;
}

/** Host-authored context facts may be reused without being treated as stale model output. */
export const TRUSTED_CONTEXT_PROVIDER_DATA_KEY = "plcAgentTrustedContext";

const RESOURCE_TOKEN_PATTERN =
  /(?:[a-z]:[\\/][^\s"'，。！？,;:]+|(?:\.{0,2}[\\/])?[a-z0-9_\u4e00-\u9fff.-]+(?:[\\/][a-z0-9_\u4e00-\u9fff.-]+)*\.[a-z0-9_\u4e00-\u9fff-]{1,16})/giu;
const STABLE_ID_PATTERN =
  /(?<![\p{L}\p{N}])[\p{L}_][\p{L}\p{N}_.:-]*(?:[\p{N}][\p{L}\p{N}_.:-]*|[_:-][\p{L}\p{N}_.:-]+)(?![\p{L}\p{N}])/gu;
const CONTINUATION_REFERENCE_PATTERN =
  /(?:继续|接着|续上|刚才|上一轮|上一次|之前|前面|上面|上述|前述|基于(?:上面|之前|前面|刚才|上述)|按(?:刚才|之前|上面|前面)|这个|那个|该文件|该程序|同一|它们?|这些(?:文件|程序|记录|项目|对象|资源|任务)|那些(?:文件|程序|记录|项目|对象|资源|任务)|continue|previous|last time|based on|the same|that file|that record|it|them|those)/iu;
const DERIVED_TASK_REFERENCE_PATTERN =
  /(?:基于|根据|利用|参考|从|依据|based on|using|from|according to)/iu;
const NEW_TASK_PIVOT_PATTERN =
  /(?:换个(?:问题|话题|任务)|另一个(?:问题|任务)|新问题|无关的?(?:问题|任务)|开始(?:一个)?新任务|different topic|another task|new task)/iu;
const NEW_TARGET_PATTERN =
  /(?:新建|创建|另建|新生成|create|new\s+(?:a\s+)?(?:file|project|record|task|resource|item|object|report))/iu;
const MUTATING_ACTION_PATTERN =
  /(?:创建|新建|写入|保存|修改|编辑|改名|重命名|修复|替换|更新|删除|删掉|清理|移除|运行|执行|测试|构建|编译|导出|部署|提交|create|write|save|modify|edit|rename|fix|replace|update|delete|remove|run|execute|test|build|compile|export|deploy|commit)/iu;
const IMPLICIT_TARGET_PATTERN =
  /(?:文件|程序|代码|结果|记录|项目|配置|报表|任务|对象|资源|file|program|code|result|record|project|config|report|task|object|resource)/iu;

function normalizeResourceReference(value: string): string {
  return value
    .trim()
    .replace(/^["'([{]+/u, "")
    .replace(/[)}\],.;:!?，。！？]+$/u, "")
    .replace(/\\/gu, "/")
    .replace(/\/+/gu, "/")
    .toLocaleLowerCase();
}

function looksLikeResourceReference(value: string): boolean {
  const normalized = normalizeResourceReference(value);
  if (!normalized || normalized.length > 260 || /\s/u.test(normalized)) return false;
  return normalized.includes("/") ||
    /(?:^|[^.])\.[a-z0-9_\u4e00-\u9fff-]{1,16}$/iu.test(normalized) ||
    /^(?=.*\p{N})(?:[\p{L}_][\p{L}\p{N}_.:-]*|[\p{N}][\p{L}\p{N}_.:-]*)$/u.test(normalized) ||
    /^(?=.*[-:])(?=.*[\p{L}\p{N}])[\p{L}\p{N}][\p{L}\p{N}_.:-]{2,}$/u.test(normalized);
}

function trimResourceToken(token: string): string {
  let value = token;
  const leading = value.match(/^(?:(?:上一轮|上一次|刚才|之前|前面|上述)的?)?(?:读取|查看|打开|列出|搜索|查找|分析|检查|总结|导入|导出|保存|加载|修改|编辑|写入|更新|确认|读一下|看一下|看看)/u);
  if (leading) {
    const rest = value.slice(leading[0].length);
    if (looksLikeResourceReference(rest)) value = rest;
  }
  const trailing = value.match(/[\u4e00-\u9fff]+$/u);
  if (trailing) {
    const rest = value.slice(0, value.length - trailing[0].length);
    if (/[a-z0-9]$/iu.test(rest)) value = rest;
  }
  return value;
}

function addReference(output: Map<string, string>, value: string): void {
  const normalized = normalizeResourceReference(value);
  if (looksLikeResourceReference(normalized) && !output.has(normalized)) {
    output.set(normalized, value.trim());
  }
}

function collectTextReferences(value: string, output: Map<string, string>): void {
  for (const match of value.matchAll(RESOURCE_TOKEN_PATTERN)) {
    const token = match[0];
    if (token) addReference(output, trimResourceToken(token));
  }
  for (const match of value.matchAll(STABLE_ID_PATTERN)) {
    const token = match[0];
    if (token) addReference(output, token);
  }
}

function parseJsonValue(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Scan values without relying on tool names or argument field names. */
function collectStructuredReferences(
  value: unknown,
  output: Map<string, string>,
  depth = 0,
): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const parsed = parseJsonValue(value);
    if (parsed !== undefined) {
      collectStructuredReferences(parsed, output, depth + 1);
    } else {
      addReference(output, value);
    }
    return;
  }
  if (typeof value === "number") {
    addReference(output, String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredReferences(item, output, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStructuredReferences(item, output, depth + 1);
    }
  }
}

function collectComparableValues(
  value: unknown,
  output: Set<string>,
  depth = 0,
): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const parsed = parseJsonValue(value);
    if (parsed !== undefined) {
      collectComparableValues(parsed, output, depth + 1);
      return;
    }
    const normalized = normalizeResourceReference(value);
    if (normalized) output.add(normalized);
    return;
  }
  if (typeof value === "number") {
    output.add(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectComparableValues(item, output, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectComparableValues(item, output, depth + 1);
    }
  }
}

function isTrustedContextItem(item: unknown): boolean {
  const value = item as { providerData?: unknown };
  if (!value.providerData || typeof value.providerData !== "object") return false;
  return (value.providerData as Record<string, unknown>)[TRUSTED_CONTEXT_PROVIDER_DATA_KEY] === true;
}

function isMessage(item: unknown): item is {
  type?: string;
  role?: string;
  content?: unknown;
} {
  const value = item as { type?: string; role?: string };
  return value.type === "message" &&
    (value.role === "user" || value.role === "assistant");
}

function historicalReferences(
  historyItems: readonly AgentInputItem[],
  currentUserText: string,
): { references: Map<string, string>; currentUserIndex: number } {
  const currentUserIndex = [...historyItems]
    .map((item, index) => ({ item, index }))
    .reverse()
    .find(({ item }) => {
      const value = item as { type?: string; role?: string; content?: unknown };
      return value.type === "message" &&
        value.role === "user" &&
        typeof value.content === "string" &&
        value.content === currentUserText;
    })?.index ?? historyItems.length;
  const references = new Map<string, string>();

  for (const item of historyItems.slice(0, currentUserIndex)) {
    if (isTrustedContextItem(item)) continue;
    const value = item as {
      type?: string;
      role?: string;
      content?: unknown;
      arguments?: unknown;
      output?: unknown;
    };
    if (isMessage(item) && typeof value.content === "string") {
      collectTextReferences(value.content, references);
      continue;
    }
    if (["function_call", "tool_call", "mcp_call", "shell_call", "apply_patch_call"].includes(value.type ?? "")) {
      collectStructuredReferences(value.arguments, references);
      continue;
    }
    if (["function_call_result", "function_call_output", "tool_result", "tool_call_output"].includes(value.type ?? "")) {
      const outputText = sessionOutputText(value.output);
      const parsed = outputText ? parseJsonValue(outputText) : undefined;
      if (parsed !== undefined) collectStructuredReferences(parsed, references);
      else if (outputText) collectTextReferences(outputText, references);
    }
  }
  return { references, currentUserIndex };
}

function isContinuationTask(
  historyItems: readonly AgentInputItem[],
  currentUserIndex: number,
  currentUserText: string,
): boolean {
  const previousItems = historyItems.slice(0, currentUserIndex);
  const recentItems = previousItems.slice(-24);
  const recentTargetReferences = new Map<string, string>();
  const recentMessages: string[] = [];

  for (const item of recentItems) {
    if (isTrustedContextItem(item)) continue;
    const value = item as {
      type?: string;
      role?: string;
      content?: unknown;
      arguments?: unknown;
      output?: unknown;
    };
    if (isMessage(item) && typeof value.content === "string") {
      recentMessages.push(value.content);
      collectTextReferences(value.content, recentTargetReferences);
    } else if (["function_call", "tool_call", "mcp_call", "shell_call", "apply_patch_call"].includes(value.type ?? "")) {
      collectStructuredReferences(value.arguments, recentTargetReferences);
    } else if (["function_call_result", "function_call_output", "tool_result", "tool_call_output"].includes(value.type ?? "")) {
      const outputText = sessionOutputText(value.output);
      const parsed = outputText ? parseJsonValue(outputText) : undefined;
      if (parsed !== undefined) collectStructuredReferences(parsed, recentTargetReferences);
    }
  }

  const hasRecentTaskContext = recentMessages.length > 0 &&
    (recentTargetReferences.size > 0 || recentMessages.some((text) => MUTATING_ACTION_PATTERN.test(text)));
  const hasReferenceCue = CONTINUATION_REFERENCE_PATTERN.test(currentUserText);
  const hasDerivedReference = DERIVED_TASK_REFERENCE_PATTERN.test(currentUserText);
  const startsNewTask = NEW_TASK_PIVOT_PATTERN.test(currentUserText) ||
    (NEW_TARGET_PATTERN.test(currentUserText) && !hasDerivedReference);
  if (startsNewTask) return false;
  if (hasReferenceCue || hasDerivedReference) return true;

  return hasRecentTaskContext &&
    MUTATING_ACTION_PATTERN.test(currentUserText) &&
    IMPLICIT_TARGET_PATTERN.test(currentUserText) &&
    !NEW_TARGET_PATTERN.test(currentUserText);
}

export function createHistoricalToolArgumentGuard(
  historyItems: readonly AgentInputItem[],
  currentUserText: string,
  getToolRisk: (toolName: string) => ToolRisk = () => "execute",
): HistoricalToolArgumentGuard | undefined {
  const { references, currentUserIndex } = historicalReferences(historyItems, currentUserText);
  if (references.size === 0) return undefined;

  const explicitlyNamedReferences = new Map<string, string>();
  collectTextReferences(currentUserText, explicitlyNamedReferences);
  const continuation = isContinuationTask(historyItems, currentUserIndex, currentUserText);
  const confirmedReferences = new Set<string>();

  const guard: HistoricalToolArgumentGuard = (toolName, input) => {
    if (continuation) return undefined;
    const risk = getToolRisk(toolName);
    if (risk !== "write" && risk !== "execute") return undefined;

    const inputValues = new Set<string>();
    collectComparableValues(input, inputValues);
    const staleReferences = [...inputValues].filter((value) =>
      references.has(value) &&
      !explicitlyNamedReferences.has(value) &&
      !confirmedReferences.has(value),
    );
    if (staleReferences.length === 0) return undefined;

    const display = staleReferences
      .slice(0, 4)
      .map((reference) => references.get(reference) ?? reference);
    return (
      "本轮被判定为新任务，工具 " + toolName + " 的参数复用了历史资源（" +
      display.join("、") + "）；已阻止工具执行。请按本轮目标重新选择资源参数；" +
      "若确实要沿用历史资源，请先通过只读核验或本轮澄清明确目标。"
    );
  };
  guard.allowConfirmedResources = (value) => {
    const selectedValues = new Set<string>();
    collectComparableValues(value, selectedValues);
    for (const selected of selectedValues) {
      if (references.has(selected)) confirmedReferences.add(selected);
    }
    const selectedReferences = new Map<string, string>();
    collectTextReferences(JSON.stringify(value), selectedReferences);
    for (const selected of selectedReferences.keys()) {
      if (references.has(selected)) confirmedReferences.add(selected);
    }
  };
  return guard;
}
export async function loadHistoricalToolArgumentGuard(
  session: Session,
  currentUserText: string,
  getToolRisk?: (toolName: string) => ToolRisk,
): Promise<HistoricalToolArgumentGuard | undefined> {
  try {
    return createHistoricalToolArgumentGuard(
      await session.getItems(),
      currentUserText,
      getToolRisk,
    );
  } catch {
    return undefined;
  }
}

/**
 * New turns keep ordinary conversation history for reference, but they do not
 * inherit the previous turn's concrete execution target by default.
 *
 * This is intentionally tool-agnostic. A user may refer to an earlier file,
 * symbol, result, or command, so the history must remain available; the model
 * decides whether the current wording explicitly continues that context.
 */
export const NEW_TURN_CONTEXT_PROMPT =
  "\n\n本轮上下文边界（仅适用于新的用户请求）：" +
  "最后一条 user 消息是本轮唯一的执行目标；更早的 user/assistant 消息仅作为历史参考，用于理解术语、已确认事实和用户偏好。" +
  "历史消息中的具体文件路径、文件名、符号名、变量值、命令参数、工具名称和待办动作，默认不属于本轮目标。" +
  "先根据本轮原话与最近的对话上下文判断任务是否延续；延续任务可以继续使用相关历史资源，具体目标仍需由当前任务语义决定。" +
  "新任务中，读取、搜索和列举工具可以核验历史资源；写入、删除、执行类工具不得静默复用旧任务参数，必须按当前目标重新选择，或先通过本轮澄清明确复用意图。" +
  "创建新目标时不要继承旧目标；如果明确基于历史对象派生新产物，仍按原任务关系处理。" +
  "延续任务判断不会授予工作区访问权或批准高风险操作；工具权限、工作区授权、重复调用收敛和 workflow 阶段约束仍然有效。" +
  "历史工具回执可以作为参考事实，但不代表本轮已经执行；本轮需要动作时，必须根据当前目标重新决定工具调用。" +
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

/**
 * Project history for the auxiliary classifiers (task plan, delivery contract,
 * workflow route, team route).
 *
 * Those roles only pick a route; they must not imitate the main agent. Durable
 * history stores each finished turn as the raw `IndustrialAgentOutput` JSON, so
 * feeding it verbatim gives the model a much stronger pattern than the schema
 * instruction in its prompt and it answers in the agent's shape instead — which
 * then fails validation. Unwrapping it back to the plain message text keeps the
 * conversation (so "it" still has a referent) without the format contamination.
 */
export function projectHistoryForClassifier(
  items: readonly AgentInputItem[],
): AgentInputItem[] {
  return items.map(unwrapStructuredAssistantMessage);
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
