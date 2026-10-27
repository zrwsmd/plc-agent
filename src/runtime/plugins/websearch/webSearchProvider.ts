/**
 * 搜索供应商的薄接口:一个查询词进去,一组结果出来。
 *
 * 为什么不把供应商写死在工具里:换供应商是迟早的事。现在用博查的免费额度,
 * 以后可能换 Tavily,或者换成公司自建的网关。工具层只该知道"输入查询词、
 * 输出结果列表",供应商的 URL、鉴权方式、返回结构都关在这两个实现里。
 *
 * 两个实现都走 Node 18 自带的 fetch,不新增依赖。
 *
 * 返回结构刻意收窄成四个字段:标题、链接、摘要、站点名。供应商给的其他东西
 * (相关性分数、图标、原始 HTML)对模型没用,带上只会白占上下文。
 */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
  publishedAt?: string;
}

export interface WebSearchOutcome {
  provider: string;
  query: string;
  hits: WebSearchHit[];
  elapsedMs: number;
}

export interface WebSearchRequest {
  query: string;
  count: number;
  signal?: AbortSignal;
}

export interface WebSearchProvider {
  readonly id: string;
  search(request: WebSearchRequest): Promise<WebSearchOutcome>;
}

/**
 * 宿主把解析好的搜索设置放在这个键下注入运行时。
 *
 * 走 runtime services 而不是 AgentConfig:设置里带着 apiKey,而 AgentConfig 会被
 * 序列化进 runs.json。密钥只该在内存里过一遍,不该落盘。
 */
export const WEB_SEARCH_SERVICE = 'websearch.settings';

export interface WebSearchSettings {
  enabled?: boolean;
  provider?: string;
  apiKey?: string;
  endpoint?: string;
  maxResults?: number;
  timeoutMs?: number;
}

/** 摘要截断长度:单条太长会把上下文挤掉,模型真正需要的是"这条讲什么" */
const MAX_SNIPPET_CHARS = 600;
const DEFAULT_TIMEOUT_MS = 15000;

function clampText(value: unknown, limit = MAX_SNIPPET_CHARS): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function textOf(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : undefined;
}

/**
 * 把调用方的取消信号和本地超时合成一个。
 * 不用 AbortSignal.any:那是 Node 20 才有的,项目目标是 node18。
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`搜索请求超时(${timeoutMs}ms)`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function postJson(
  url: string,
  body: unknown,
  apiKey: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const bounded = withTimeout(signal, timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: bounded.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      // 只留前 300 字:错误页可能很长,原样塞进工具结果会把上下文吃满
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error('搜索服务返回的不是 JSON');
    }
  } finally {
    bounded.dispose();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ---- 博查(默认) ----
// POST https://api.bochaai.com/v1/web-search
// 返回 webPages.value[],字段是 name / url / siteName / snippet / summary / datePublished。
export function createBochaProvider(options: {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
}): WebSearchProvider {
  const endpoint = options.endpoint?.trim() || 'https://api.bochaai.com/v1/web-search';
  return {
    id: 'bocha',
    async search(request) {
      const startedAt = Date.now();
      const payload = await postJson(
        endpoint,
        {
          query: request.query,
          count: request.count,
          summary: true,
          freshness: 'noLimit',
        },
        options.apiKey,
        request.signal,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const webPages = asRecord(asRecord(payload)?.webPages);
      const list = Array.isArray(webPages?.value) ? (webPages.value as unknown[]) : [];
      const hits: WebSearchHit[] = [];
      for (const item of list) {
        const row = asRecord(item);
        if (!row) continue;
        const url = textOf(row.url);
        if (!url) continue;
        hits.push({
          title: clampText(row.name, 200) || url,
          url,
          snippet: clampText(row.summary) || clampText(row.snippet),
          ...(textOf(row.siteName) ? { siteName: textOf(row.siteName) } : {}),
          ...(textOf(row.datePublished) ? { publishedAt: textOf(row.datePublished) } : {}),
        });
      }
      return {
        provider: 'bocha',
        query: request.query,
        hits,
        elapsedMs: Date.now() - startedAt,
      };
    },
  };
}

// ---- Tavily ----
// POST https://api.tavily.com/search,Authorization: Bearer tvly-…
// 返回 results[],字段是 title / url / content / score。
export function createTavilyProvider(options: {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
}): WebSearchProvider {
  const endpoint = options.endpoint?.trim() || 'https://api.tavily.com/search';
  return {
    id: 'tavily',
    async search(request) {
      const startedAt = Date.now();
      const payload = await postJson(
        endpoint,
        {
          query: request.query,
          max_results: request.count,
          search_depth: 'basic',
          topic: 'general',
        },
        options.apiKey,
        request.signal,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const list = Array.isArray(asRecord(payload)?.results)
        ? ((payload as Record<string, unknown>).results as unknown[])
        : [];
      const hits: WebSearchHit[] = [];
      for (const item of list) {
        const row = asRecord(item);
        if (!row) continue;
        const url = textOf(row.url);
        if (!url) continue;
        hits.push({
          title: clampText(row.title, 200) || url,
          url,
          snippet: clampText(row.content),
        });
      }
      return {
        provider: 'tavily',
        query: request.query,
        hits,
        elapsedMs: Date.now() - startedAt,
      };
    },
  };
}

/**
 * 按配置挑一个供应商。没配 key 就返回 undefined —— 由调用方决定是"不注册这个工具"
 * 还是"注册了但明确告诉模型不可用",这里不替上层做决定。
 */
export function createWebSearchProvider(
  settings: WebSearchSettings | undefined,
): WebSearchProvider | undefined {
  const apiKey = settings?.apiKey?.trim();
  if (!apiKey) return undefined;
  const id = (settings?.provider ?? 'bocha').trim().toLowerCase();
  const options = { apiKey, endpoint: settings?.endpoint, timeoutMs: settings?.timeoutMs };
  if (id === 'tavily') return createTavilyProvider(options);
  if (id === 'bocha' || id === '') return createBochaProvider(options);
  // 写错的供应商名不要静默退化成博查:那样用户会拿着 Tavily 的 key 去打博查,
  // 报出来的 401 完全对不上原因。
  throw new Error(`未知的搜索供应商: ${id}(可选 bocha / tavily)`);
}
