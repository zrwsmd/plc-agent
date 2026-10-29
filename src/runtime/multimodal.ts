import type { AgentInputItem } from '@openai/agents';
import type { AgentApiFormat, AgentProvider } from './modelAdapter';

export type VisionMode = 'auto' | 'enabled' | 'disabled';

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export interface UserImageAttachment {
  name: string;
  mimeType: SupportedImageMimeType;
  dataUrl: string;
}

export interface UserMessageInput {
  text: string;
  images?: UserImageAttachment[];
}

export interface VisionCapabilityConfig {
  provider?: AgentProvider;
  apiFormat?: AgentApiFormat | 'auto';
  baseUrl: string;
  model: string;
  visionMode?: VisionMode;
}

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_DATA_URL_CHARS = 12_000_000;

export function isVisionMode(value: unknown): value is VisionMode {
  return value === 'auto' || value === 'enabled' || value === 'disabled';
}

export function normalizeVisionMode(value: unknown): VisionMode {
  return isVisionMode(value) ? value : 'auto';
}

/**
 * Auto mode is deliberately conservative for custom gateways: a model name
 * must match a provider family that is known to accept images. An explicit
 * enabled mode remains available for private or newly released vision models.
 */
export function supportsVision(config: VisionCapabilityConfig): boolean {
  const mode = normalizeVisionMode(config.visionMode);
  if (mode === 'enabled') return true;
  if (mode === 'disabled') return false;
  const model = config.model.trim().toLowerCase();
  if (!model) return false;
  if (config.provider === 'anthropic' || config.apiFormat === 'messages') {
    return /(?:claude-(?:3|4)|claude-(?:sonnet|opus|haiku))/u.test(model);
  }
  return /(?:gpt-(?:4o|4\.1|5)|^o\d(?:[a-z0-9-]*)?$)/u.test(model);
}

export function normalizeUserMessageInput(
  text: string,
  value?: unknown,
): UserMessageInput {
  const images = normalizeImageAttachments(value, false);
  return { text, ...(images.length ? { images } : {}) };
}

export function normalizeImageAttachments(value: unknown, limit = true): UserImageAttachment[] {
  if (!Array.isArray(value)) return [];
  const images: UserImageAttachment[] = [];
  const source = limit ? value.slice(0, MAX_IMAGE_ATTACHMENTS) : value;
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl.trim() : '';
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
    const name = typeof item.name === 'string' && item.name.trim()
      ? item.name.trim().slice(0, 180)
      : 'image';
    if (!isSupportedImageMimeType(mimeType) || !isImageDataUrl(dataUrl, mimeType)) continue;
    if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) continue;
    images.push({ name, mimeType, dataUrl });
  }
  return images;
}

export function validateUserMessageInput(
  input: UserMessageInput,
  config: VisionCapabilityConfig,
): string | undefined {
  const images = input.images ?? [];
  if (!images.length) return undefined;
  if (!supportsVision(config)) {
    return `当前模型 ${config.model || '未命名模型'} 未启用图片输入；请切换支持视觉的模型，或在设置中将图片能力改为“启用”。`;
  }
  if (images.length > MAX_IMAGE_ATTACHMENTS) {
    return `单轮最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片。`;
  }
  for (const image of images) {
    if (!isSupportedImageMimeType(image.mimeType) || !isImageDataUrl(image.dataUrl, image.mimeType)) {
      return `图片“${image.name}”格式无效，仅支持 PNG、JPEG、WebP。`;
    }
    if (image.dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
      return `图片“${image.name}”过大，请压缩后重试。`;
    }
  }
  return undefined;
}

export function userMessageInputToAgentItem(input: UserMessageInput): AgentInputItem {
  const text = input.text.trim();
  const images = input.images ?? [];
  const content: Array<Record<string, unknown>> = [];
  if (text) content.push({ type: 'input_text', text: input.text });
  for (const image of images) {
    content.push({ type: 'input_text', text: `[附件图片: ${image.name}]` });
    content.push({ type: 'input_image', image: image.dataUrl, detail: 'auto' });
  }
  if (!content.length) content.push({ type: 'input_text', text: '' });
  return { type: 'message', role: 'user', content } as unknown as AgentInputItem;
}

export function userMessageInputImages(value: UserMessageInput | undefined): readonly UserImageAttachment[] {
  return value?.images ?? [];
}

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

function isImageDataUrl(value: string, mimeType: string): boolean {
  return new RegExp(`^data:${mimeType};base64,[A-Za-z0-9+/=\\s]+$`, 'u').test(value);
}

