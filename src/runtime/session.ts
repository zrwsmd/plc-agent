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
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentInputItem, Session } from '@openai/agents';
import {
  sanitizeAssistantHistoryItems,
  stripHistoricalContextMarker,
} from './agentHistory';
import { isContextStateLedgerItem } from './contextStateLedger';
import type { SupportedImageMimeType, UserImageAttachment } from './multimodal';

interface DisplayImageReference {
  type: 'input_image_ref';
  file: string;
  name: string;
  mimeType: SupportedImageMimeType;
}

export interface ChatHistoryMessage {
  role: 'user' | 'agent';
  text: string;
  images?: UserImageAttachment[];
}

const DISPLAY_IMAGE_REF_TYPE = 'input_image_ref';
const IMAGE_ATTACHMENT_MARKER = /^\[附件图片:\s*([^\]]+)\]$/u;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/u;
const IMAGE_FILE = /^[a-f0-9]{64}\.(?:png|jpg|webp)$/u;
const IMAGE_EXTENSIONS: Record<SupportedImageMimeType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

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

  private attachmentsDir(): string {
    return path.join(path.dirname(this.filePath), 'attachments');
  }

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
      const rawDisplayItems = sanitizeAssistantHistoryItems(
        (Array.isArray(data.displayItems) ? data.displayItems : data.items) as AgentInputItem[],
      ).filter(isDisplayHistoryItem);
      this.displayItems = [];
      for (const item of rawDisplayItems) {
        this.displayItems.push(await this.projectDisplayHistoryItem(item));
      }
      await this.restoreDisplayImagesFromModelHistory();
      if (
        JSON.stringify(this.items) !== JSON.stringify(data.items) ||
        !Array.isArray(data.displayItems) ||
        JSON.stringify(this.displayItems) !== JSON.stringify(rawDisplayItems)
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

  private async projectDisplayHistoryItem(item: AgentInputItem): Promise<AgentInputItem> {
    const value = item as Record<string, unknown>;
    if (value.type !== 'message' || value.role !== 'user' || !Array.isArray(value.content)) {
      return item;
    }
    let changed = false;
    let pendingName = '';
    const content: unknown[] = [];
    for (const part of value.content) {
      if (!part || typeof part !== 'object') {
        content.push(part);
        continue;
      }
      const record = part as Record<string, unknown>;
      if (record.type === 'input_text' && typeof record.text === 'string') {
        pendingName = IMAGE_ATTACHMENT_MARKER.exec(record.text.trim())?.[1]?.trim() ?? '';
        content.push(part);
        continue;
      }
      if (isDisplayImageReference(record)) {
        content.push(record);
        pendingName = '';
        continue;
      }
      if (record.type !== 'input_image' || typeof record.image !== 'string') {
        content.push(part);
        continue;
      }
      const reference = await this.persistDisplayImage(record.image, pendingName || imageName(record));
      content.push(reference ?? part);
      changed = changed || Boolean(reference);
      pendingName = '';
    }
    return changed ? { ...value, content } as unknown as AgentInputItem : item;
  }

  private async persistDisplayImage(
    dataUrl: string,
    requestedName: string,
  ): Promise<DisplayImageReference | undefined> {
    const match = IMAGE_DATA_URL.exec(dataUrl.trim());
    if (!match) return undefined;
    const mimeType = match[1] as SupportedImageMimeType;
    const bytes = Buffer.from(match[2].replace(/\s+/gu, ''), 'base64');
    if (!bytes.length) return undefined;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = `${hash}${IMAGE_EXTENSIONS[mimeType]}`;
    const target = path.join(this.attachmentsDir(), file);
    await fs.mkdir(this.attachmentsDir(), { recursive: true });
    try {
      await fs.writeFile(target, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
    }
    return {
      type: DISPLAY_IMAGE_REF_TYPE,
      file,
      name: sanitizeImageName(requestedName, file),
      mimeType,
    };
  }

  private async restoreDisplayImagesFromModelHistory(): Promise<void> {
    const candidates = new Map<string, AgentInputItem[]>();
    for (const item of this.items) {
      if (!isUserMessageItem(item) || !hasInlineImage(item)) continue;
      const signature = displayMessageSignature(item);
      if (!signature) continue;
      const projected = await this.projectDisplayHistoryItem(item);
      if (!hasDisplayImage(projected)) continue;
      const list = candidates.get(signature) ?? [];
      list.push(projected);
      candidates.set(signature, list);
    }
    this.displayItems = this.displayItems.map((item) => {
      if (!isUserMessageItem(item) || hasDisplayImage(item)) return item;
      const signature = displayMessageSignature(item);
      if (!signature) return item;
      return candidates.get(signature)?.shift() ?? item;
    });
  }

  private async hydrateDisplayHistoryItem(item: AgentInputItem): Promise<AgentInputItem> {
    const value = item as Record<string, unknown>;
    if (value.type !== 'message' || value.role !== 'user' || !Array.isArray(value.content)) {
      return { ...item };
    }
    let changed = false;
    const content: unknown[] = [];
    for (const part of value.content) {
      if (!isDisplayImageReference(part)) {
        content.push(part);
        continue;
      }
      const file = safeAttachmentFile(part.file);
      if (!file) {
        content.push(part);
        continue;
      }
      try {
        const bytes = await fs.readFile(path.join(this.attachmentsDir(), file));
        content.push({
          type: 'input_image',
          image: `data:${part.mimeType};base64,${bytes.toString('base64')}`,
          name: part.name,
          mimeType: part.mimeType,
        });
        changed = true;
      } catch {
        content.push(part);
      }
    }
    return changed ? { ...value, content } as unknown as AgentInputItem : { ...item };
  }

  private async pruneDisplayAttachments(): Promise<void> {
    const referenced = new Set<string>();
    for (const item of this.displayItems) {
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (isDisplayImageReference(part)) referenced.add(part.file);
      }
    }
    let files: string[];
    try {
      files = await fs.readdir(this.attachmentsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(files.map(async (file) => {
      if (!referenced.has(file) && safeAttachmentFile(file)) {
        await fs.rm(path.join(this.attachmentsDir(), file), { force: true });
      }
    }));
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
      for (const item of sanitized.filter(isDisplayHistoryItem)) {
        this.displayItems.push(await this.projectDisplayHistoryItem(item));
      }
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
      await this.pruneDisplayAttachments();
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
      await fs.rm(this.attachmentsDir(), { recursive: true, force: true });
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
      return Promise.all(this.displayItems.map((item) => this.hydrateDisplayHistoryItem(item)));
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
      await this.pruneDisplayAttachments();
      await this.persistSnapshot();
    });
  }
}

function isDisplayHistoryItem(item: AgentInputItem): boolean {
  const value = item as { type?: unknown; role?: unknown };
  return value.type === 'message' && (value.role === 'user' || value.role === 'assistant');
}

function isDisplayImageReference(value: unknown): value is DisplayImageReference {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === DISPLAY_IMAGE_REF_TYPE &&
    typeof record.file === 'string' &&
    Boolean(safeAttachmentFile(record.file)) &&
    typeof record.name === 'string' &&
    (record.mimeType === 'image/png' || record.mimeType === 'image/jpeg' || record.mimeType === 'image/webp');
}

function safeAttachmentFile(value: string): string | undefined {
  return IMAGE_FILE.test(value) && path.basename(value) === value ? value : undefined;
}

function sanitizeImageName(value: string, fallback: string): string {
  const name = String(value ?? '').replace(/[\u0000-\u001f]/gu, '').trim().slice(0, 180);
  return name || fallback;
}

function imageName(value: Record<string, unknown>): string {
  return typeof value.name === 'string' ? value.name : '';
}

function hasInlineImage(item: AgentInputItem): boolean {
  const content = (item as { content?: unknown }).content;
  return Array.isArray(content) && content.some((part) =>
    part && typeof part === 'object' &&
    (part as Record<string, unknown>).type === 'input_image' &&
    typeof (part as Record<string, unknown>).image === 'string');
}

function hasDisplayImage(item: AgentInputItem): boolean {
  const content = (item as { content?: unknown }).content;
  return Array.isArray(content) && content.some((part) =>
    isDisplayImageReference(part) ||
    (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'input_image'));
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

/** 从会话条目里抽取可展示的文字与图片(用于面板重开时回放历史) */
export function extractChatMessages(items: AgentInputItem[]): ChatHistoryMessage[] {
  const out: ChatHistoryMessage[] = [];
  for (const item of items) {
    const it = item as { type?: string; role?: string; content?: unknown };
    if (isContextStateLedgerItem(item)) continue;
    if (it.type !== 'message' || (it.role !== 'user' && it.role !== 'assistant')) continue;
    const extracted = extractMessageContent(it.content);
    let text = extracted.text;
    if (it.role === 'assistant') {
      text = stripHistoricalContextMarker(projectAssistantHistoryText(text));
    }
    if (text.trim() || extracted.images.length) {
      out.push({
        role: it.role === 'user' ? 'user' : 'agent',
        text,
        ...(extracted.images.length ? { images: extracted.images } : {}),
      });
    }
  }
  return out;
}

function extractMessageContent(content: unknown): { text: string; images: UserImageAttachment[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const text: string[] = [];
  const pendingMarkers: Array<{ raw: string; name: string }> = [];
  const images: UserImageAttachment[] = [];
  const flushMarkers = () => {
    while (pendingMarkers.length) text.push(pendingMarkers.shift()!.raw);
  };
  for (const part of content) {
    if (typeof part === 'string') {
      flushMarkers();
      text.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') {
      const marker = IMAGE_ATTACHMENT_MARKER.exec(record.text.trim());
      if (marker) pendingMarkers.push({ raw: record.text, name: marker[1].trim() });
      else {
        flushMarkers();
        text.push(record.text);
      }
      continue;
    }
    if (record.type === 'input_image' && typeof record.image === 'string') {
      const data = IMAGE_DATA_URL.exec(record.image.trim());
      if (data) {
        const marker = pendingMarkers.shift();
        const mimeType = data[1] as SupportedImageMimeType;
        images.push({
          name: sanitizeImageName(imageName(record) || marker?.name || '', marker?.name || '附件图片'),
          mimeType,
          dataUrl: record.image,
        });
        continue;
      }
    }
    flushMarkers();
  }
  flushMarkers();
  return { text: text.join(''), images };
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
