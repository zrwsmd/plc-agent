/**
 * JSON 文件版会话持久化,实现 @openai/agents 的 Session 接口。
 *
 * 为什么不用官方 @openai/agents-sqlite:它依赖 better-sqlite3 原生模块,
 * VSCode 插件分发要按平台重新编译,代价不值;对话规模用 JSON 文件足够,
 * 以后真要大数据量再换后端,接口不变。
 *
 * 落盘位置:工作区 storage 目录/sessions/<session-id>/session.json；无工作区时
 * 回退到扩展 globalStorage。跨窗口、跨重启有效,卸载插件时 VSCode 会一并清理。
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentInputItem, Session } from '@openai/agents';
import {
  sanitizeAssistantHistoryItems,
  stripHistoricalContextMarker,
} from './agentHistory';
import { isContextStateLedgerItem } from './contextStateLedger';

export class JsonFileSession implements Session {
  private items: AgentInputItem[] = [];
  /**
   * UI replay history is intentionally separate from the model history.
   * Context compaction is allowed to replace `items`, but reopening a chat
   * must still show the complete user/assistant conversation.
   */
  private displayItems: AgentInputItem[] = [];
  private sessionId = '';
  /**
   * All operations for the same file share one queue, including operations
   * issued by separate JsonFileSession instances in the same extension host.
   * This prevents a stale instance from writing over a newer clear/add.
   */
  private static readonly queues = new Map<string, Promise<void>>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private queueKey(): string {
    const resolved = path.resolve(this.filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private async loadFromDisk(force = false): Promise<void> {
    if (this.loaded && !force) return;
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as {
        schemaVersion?: number;
        sessionId?: string;
        items?: unknown;
        displayItems?: unknown;
      };
      if (!data || typeof data !== 'object' || (data.schemaVersion !== undefined && data.schemaVersion !== 1)) {
        throw new Error('unsupported session schema');
      }
      if (!Array.isArray(data.items)) throw new Error('invalid session items');
      this.sessionId = typeof data.sessionId === 'string' ? data.sessionId : randomUUID();
      this.items = sanitizeAssistantHistoryItems(data.items as AgentInputItem[]);
      const rawDisplayItems = Array.isArray(data.displayItems) ? data.displayItems : data.items;
      this.displayItems = sanitizeAssistantHistoryItems(rawDisplayItems as AgentInputItem[])
        .filter(isDisplayHistoryItem);
      if (
        JSON.stringify(this.items) !== JSON.stringify(data.items) ||
        !Array.isArray(data.displayItems)
      ) {
        await this.persistSnapshot();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `会话存储损坏，已停止恢复以避免混入错误上下文: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // A read-only first access may happen before the first write. Keep the
      // generated id stable until the document is actually persisted.
      if (!this.loaded || !this.sessionId) this.sessionId = randomUUID();
      this.items = [];
      this.displayItems = [];
    }
    this.loaded = true;
  }

  private persistSnapshot(): Promise<void> {
    // Capture the complete document before awaiting any filesystem operation.
    // Persisting `this.items` later would allow a subsequent clear/mutation to
    // change the payload of an already queued write.
    const snapshot = JSON.stringify({
      schemaVersion: 1,
      sessionId: this.sessionId,
      items: this.items,
      displayItems: this.displayItems,
    });
    return (async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(
        temp,
        snapshot,
        'utf8',
      );
      await fs.rename(temp, this.filePath);
    })();
  }

  /** Serialize reads and writes against the same on-disk session document. */
  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const key = this.queueKey();
    const previous = JsonFileSession.queues.get(key) ?? Promise.resolve();
    const current = previous.then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    JsonFileSession.queues.set(key, settled);
    void settled.then(() => {
      if (JsonFileSession.queues.get(key) === settled) {
        JsonFileSession.queues.delete(key);
      }
    });
    return current;
  }

  async getSessionId(): Promise<string> {
    return this.enqueue(async () => {
      await this.loadFromDisk(true);
      return this.sessionId;
    });
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.enqueue(async () => {
      await this.loadFromDisk(true);
      return limit === undefined ? [...this.items] : this.items.slice(-limit);
    });
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await this.enqueue(async () => {
      await this.loadFromDisk(true);
      const sanitized = sanitizeAssistantHistoryItems(items);
      this.items.push(...sanitized);
      this.displayItems.push(...sanitized.filter(isDisplayHistoryItem));
      await this.persistSnapshot();
    });
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.enqueue(async () => {
      await this.loadFromDisk(true);
      const last = this.items.pop();
      if (last) {
        const signature = displayMessageSignature(last);
        if (signature) {
          for (let index = this.displayItems.length - 1; index >= 0; index -= 1) {
            if (displayMessageSignature(this.displayItems[index]) === signature) {
              this.displayItems.splice(index, 1);
              break;
            }
          }
        }
      }
      await this.persistSnapshot();
      return last;
    });
  }

  async clearSession(): Promise<void> {
    await this.enqueue(async () => {
      await this.loadFromDisk(true);
      this.items = [];
      this.displayItems = [];
      this.sessionId = randomUUID();
      await this.persistSnapshot();
    });
  }

  /** Atomically replace the complete stored history, preserving the session id. */
  async replaceItems(items: AgentInputItem[]): Promise<void> {
    await this.enqueue(async () => {
      await this.loadFromDisk(true);
      this.items = sanitizeAssistantHistoryItems(items).map((item) => ({ ...item }));
      await this.persistSnapshot();
    });
  }

  /** Return the uncompressed message history used to restore the chat UI. */
  async getDisplayItems(): Promise<AgentInputItem[]> {
    return this.enqueue(async () => {
      await this.loadFromDisk(true);
      return this.displayItems.map((item) => ({ ...item }));
    });
  }

  /** Restore the session to a turn boundary before retrying a failed/cancelled run. */
  async truncate(length: number): Promise<void> {
    await this.enqueue(async () => {
      await this.loadFromDisk(true);
      const safeLength = Math.max(0, Math.min(this.items.length, Math.floor(length)));
      const removed = this.items.slice(safeLength);
      this.items = this.items.slice(0, safeLength);
      // Rollback removes the current failed turn from the UI copy as well.
      // Compaction may have made model and display lengths diverge, so use the
      // first user message in the removed model suffix as the boundary.
      const firstRemovedUser = removed.find(isUserMessageItem);
      if (firstRemovedUser) {
        const signature = displayMessageSignature(firstRemovedUser);
        if (signature) {
          for (let index = this.displayItems.length - 1; index >= 0; index -= 1) {
            if (displayMessageSignature(this.displayItems[index]) === signature) {
              this.displayItems = this.displayItems.slice(0, index);
              break;
            }
          }
        }
      }
      await this.persistSnapshot();
    });
  }
}

function isDisplayHistoryItem(item: AgentInputItem): boolean {
  const value = item as { type?: unknown; role?: unknown };
  return value.type === 'message' && (value.role === 'user' || value.role === 'assistant');
}

function isUserMessageItem(item: AgentInputItem): boolean {
  const value = item as { type?: unknown; role?: unknown };
  return value.type === 'message' && value.role === 'user';
}

function displayMessageSignature(item: AgentInputItem): string | undefined {
  if (!isDisplayHistoryItem(item)) return undefined;
  const value = item as { role?: unknown; content?: unknown };
  return `${String(value.role)}\u0000${displayMessageText(value.content)}`;
}

function displayMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => typeof part === 'string' ? part : (part as { text?: unknown })?.text ?? '')
    .filter((part): part is string => typeof part === 'string')
    .join('');
}

/** 从会话条目里抽取可展示的 user/assistant 文本(用于面板重开时回放历史) */
export function extractChatMessages(items: AgentInputItem[]): { role: 'user' | 'agent'; text: string }[] {
  const out: { role: 'user' | 'agent'; text: string }[] = [];
  for (const item of items) {
    const it = item as { type?: string; role?: string; content?: unknown };
    if (isContextStateLedgerItem(item)) continue;
    if (it.type !== 'message' || (it.role !== 'user' && it.role !== 'assistant')) continue;
    let text = '';
    if (typeof it.content === 'string') {
      text = it.content;
    } else if (Array.isArray(it.content)) {
      text = it.content
        .map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? ''))
        .join('');
    }
    if (it.role === 'assistant') {
      text = stripHistoricalContextMarker(projectAssistantHistoryText(text));
    }
    if (text.trim()) out.push({ role: it.role === 'user' ? 'user' : 'agent', text });
  }
  return out;
}

function projectAssistantHistoryText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return text;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { message?: unknown }).message === 'string'
    ) {
      return (parsed as { message: string }).message;
    }
  } catch {
    // Not a structured agent output; keep the original assistant text.
  }
  return text;
}
