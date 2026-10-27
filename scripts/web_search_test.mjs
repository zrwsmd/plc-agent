import {
  WEB_SEARCH_SERVICE,
  createBochaProvider,
  createTavilyProvider,
  createWebSearchProvider,
  createWebSearchToolProvider,
  createRuntimeServiceContainer,
  createAppToolRegistry,
  WorkflowDecisionService,
  WorkflowRegistry,
} from './agent.testbundle.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* 每个用例自己换掉 fetch,跑完恢复。真实网络一次都不打。 */
const realFetch = globalThis.fetch;
function stubFetch(handler) {
  globalThis.fetch = handler;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

/* ------------------------------------------------------------------ */
/* [1] 没 key 就不建供应商                                             */
/* ------------------------------------------------------------------ */

assert(
  createWebSearchProvider(undefined) === undefined,
  '没有设置时不该建出供应商',
);
assert(
  createWebSearchProvider({ enabled: true }) === undefined,
  '没有 apiKey 时不该建出供应商',
);
assert(
  createWebSearchProvider({ enabled: true, apiKey: '   ' }) === undefined,
  'apiKey 全是空格等同于没填',
);
assert(
  createWebSearchProvider({ apiKey: 'k', provider: 'bocha' })?.id === 'bocha',
  '默认/显式 bocha 应建出博查',
);
assert(
  createWebSearchProvider({ apiKey: 'k', provider: 'TAVILY' })?.id === 'tavily',
  '供应商名大小写不该影响选择',
);

let unknownThrew = false;
try {
  createWebSearchProvider({ apiKey: 'k', provider: 'bing' });
} catch (error) {
  unknownThrew = /未知的搜索供应商/.test(String(error?.message ?? error));
}
assert(unknownThrew, '供应商名写错必须抛错,不能静默退化成博查');

/* ------------------------------------------------------------------ */
/* [2] 博查返回结构 → 收窄成四个字段                                   */
/* ------------------------------------------------------------------ */

let bochaRequest;
stubFetch(async (url, init) => {
  bochaRequest = { url, init };
  return new Response(
    JSON.stringify({
      code: 200,
      log_id: 'c1c2c3',
      // 真实结构:webPages 在 data 下面。按顶层读会永远 0 条,这个用例就是防它。
      data: {
        _type: 'SearchResponse',
        webPages: {
          value: [
            {
              name: 'S7-1200 系统手册',
              url: 'https://example.com/s71200',
              siteName: 'example.com',
              snippet: '短摘要',
              summary: '  长摘要   带空白  ',
              datePublished: '2024-05-01',
            },
            { name: '没有链接的条目', snippet: '这条要被丢掉' },
            {
              name: '',
              url: 'https://example.com/no-title',
              summary: '标题为空时用 url 兜底',
            },
          ],
        },
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});

const bocha = createBochaProvider({ apiKey: 'bocha-key' });
const bochaOutcome = await bocha.search({ query: 'S7-1200 F0002', count: 3 });
restoreFetch();

assert(bochaOutcome.provider === 'bocha', `provider 字段应为 bocha: ${bochaOutcome.provider}`);
assert(bochaOutcome.hits.length === 2, `无 url 的条目应被丢掉,实际 ${bochaOutcome.hits.length} 条`);
assert(
  bochaOutcome.hits[0].title === 'S7-1200 系统手册',
  `标题映射错了: ${bochaOutcome.hits[0].title}`,
);
assert(
  bochaOutcome.hits[0].snippet === '长摘要 带空白',
  `摘要应优先取 summary 并压平空白: ${JSON.stringify(bochaOutcome.hits[0].snippet)}`,
);
assert(
  bochaOutcome.hits[0].siteName === 'example.com'
    && bochaOutcome.hits[0].publishedAt === '2024-05-01',
  'siteName / publishedAt 应保留',
);
assert(
  bochaOutcome.hits[1].title === 'https://example.com/no-title',
  `标题为空时应用 url 兜底: ${bochaOutcome.hits[1].title}`,
);
assert(
  bochaRequest.url === 'https://api.bochaai.com/v1/web-search',
  `默认地址不对: ${bochaRequest.url}`,
);
assert(
  bochaRequest.init.headers.Authorization === 'Bearer bocha-key',
  '博查鉴权头应是 Bearer',
);
const bochaBody = JSON.parse(bochaRequest.init.body);
assert(
  bochaBody.query === 'S7-1200 F0002' && bochaBody.count === 3,
  `请求体没带上查询词和条数: ${bochaRequest.init.body}`,
);
assert(bochaBody.summary === true, '必须要求供应商返回摘要,否则只有一句话片段');

// 老写法:webPages 直接在顶层(没有 data 包一层)。改版前的老接口是这样,也要认。
stubFetch(async () =>
  new Response(
    JSON.stringify({
      webPages: { value: [{ name: '顶层老结构', url: 'https://example.com/legacy' }] },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ),
);
const legacyOutcome = await createBochaProvider({ apiKey: 'k' }).search({ query: 'q', count: 1 });
restoreFetch();
assert(
  legacyOutcome.hits.length === 1 && legacyOutcome.hits[0].title === '顶层老结构',
  '顶层直接给 webPages 的老结构应当照常解析',
);

// HTTP 200 但业务 code 非 200:必须抛错。不抛就变成"搜到 0 条",
// 用户会以为网上没资料,实际是额度/参数/鉴权问题。
stubFetch(async () =>
  new Response(
    JSON.stringify({ code: 403, message: 'You do not have enough money or package quota' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ),
);
let businessError;
try {
  await createBochaProvider({ apiKey: 'k' }).search({ query: 'q', count: 1 });
} catch (error) {
  businessError = String(error?.message ?? error);
}
restoreFetch();
assert(
  businessError?.includes('403') && businessError?.includes('not have enough money'),
  `业务错误码应当抛出来并带上原文,不能退化成 0 条: ${businessError}`,
);

/* ------------------------------------------------------------------ */
/* [3] 摘要超长要截断,否则单条就能吃掉上下文                          */
/* ------------------------------------------------------------------ */

const longText = 'A'.repeat(1200);
stubFetch(async () =>
  new Response(
    JSON.stringify({
      webPages: { value: [{ name: '长文', url: 'https://example.com/long', summary: longText }] },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ),
);
const longOutcome = await createBochaProvider({ apiKey: 'k' }).search({ query: 'q', count: 1 });
restoreFetch();
assert(
  longOutcome.hits[0].snippet.length === 601,
  `摘要应截断到 600 字加省略号,实际 ${longOutcome.hits[0].snippet.length}`,
);
assert(
  longOutcome.hits[0].snippet.endsWith('…'),
  '截断后要带省略号,让模型知道后面还有内容',
);

/* ------------------------------------------------------------------ */
/* [4] Tavily 返回结构                                                 */
/* ------------------------------------------------------------------ */

let tavilyRequest;
stubFetch(async (url, init) => {
  tavilyRequest = { url, init };
  return new Response(
    JSON.stringify({
      results: [
        { title: 'PLC Basics', url: 'https://example.org/plc', content: '正文片段', score: 0.9 },
        { title: '缺链接', content: '应被丢掉' },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});
const tavilyOutcome = await createTavilyProvider({ apiKey: 'tvly-k' }).search({
  query: 'plc basics',
  count: 4,
});
restoreFetch();

assert(tavilyOutcome.provider === 'tavily', 'provider 字段应为 tavily');
assert(tavilyOutcome.hits.length === 1, `Tavily 里无 url 的条目应丢掉,实际 ${tavilyOutcome.hits.length}`);
assert(tavilyOutcome.hits[0].snippet === '正文片段', 'Tavily 的 content 应映射成 snippet');
assert(tavilyRequest.url === 'https://api.tavily.com/search', `Tavily 地址不对: ${tavilyRequest.url}`);
const tavilyBody = JSON.parse(tavilyRequest.init.body);
assert(tavilyBody.max_results === 4, 'Tavily 的条数字段是 max_results');

/* ------------------------------------------------------------------ */
/* [5] 失败路径:HTTP 非 2xx / 非 JSON / 超时                          */
/* ------------------------------------------------------------------ */

stubFetch(async () => new Response('unauthorized: bad key', { status: 401 }));
let httpError;
try {
  await createBochaProvider({ apiKey: 'bad' }).search({ query: 'q', count: 1 });
} catch (error) {
  httpError = String(error?.message ?? error);
}
restoreFetch();
assert(httpError?.includes('401'), `HTTP 错误应带状态码: ${httpError}`);
assert(httpError?.includes('bad key'), `HTTP 错误应带上游原文: ${httpError}`);

stubFetch(async () => new Response('<html>502</html>', { status: 200 }));
let jsonError;
try {
  await createBochaProvider({ apiKey: 'k' }).search({ query: 'q', count: 1 });
} catch (error) {
  jsonError = String(error?.message ?? error);
}
restoreFetch();
assert(jsonError === '搜索服务返回的不是 JSON', `非 JSON 响应应明确报错: ${jsonError}`);

stubFetch(
  (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
);
let timeoutError;
const timeoutStartedAt = Date.now();
try {
  await createBochaProvider({ apiKey: 'k', timeoutMs: 60 }).search({ query: 'q', count: 1 });
} catch (error) {
  timeoutError = String(error?.message ?? error);
}
restoreFetch();
assert(timeoutError === 'aborted', `超时应当真的打断请求: ${timeoutError}`);
assert(Date.now() - timeoutStartedAt < 2000, '超时应当很快返回,不能挂住');

/* ------------------------------------------------------------------ */
/* [6] 工具注册门:没开 / 没 key / 供应商写错 都不该注册                 */
/* ------------------------------------------------------------------ */

const webSearchProvider = createWebSearchToolProvider();
const buildWith = (settings) =>
  webSearchProvider.createTools({
    // 这里只验"注册还是不注册",guardrails 给个空壳就够
    guardrails: { input: [], output: [] },
    services: createRuntimeServiceContainer(
      settings === undefined ? [] : [[WEB_SEARCH_SERVICE, settings]],
    ),
  });

assert(buildWith(undefined).length === 0, '宿主没注入设置时不该注册 web_search');
assert(buildWith({ enabled: false, apiKey: 'k' }).length === 0, '关掉开关后不该注册 web_search');
assert(buildWith({ enabled: true }).length === 0, '没有 key 时不该注册 web_search');
assert(
  buildWith({ enabled: true, apiKey: 'k', provider: 'bing' }).length === 0,
  '供应商写错时应当缺席,而不是让整轮跑挂',
);

const registered = buildWith({ enabled: true, apiKey: 'k', provider: 'bocha' });
assert(registered.length === 1, `配置齐全时应注册 1 个工具,实际 ${registered.length}`);
assert(registered[0].name === 'web_search', `工具名应为 web_search: ${registered[0].name}`);
// SDK 会把布尔值统一包成 async 函数,所以这里要调一下才知道真假
assert(
  typeof registered[0].needsApproval === 'function',
  '查询词会出站,必须逐次审批',
);
assert(
  (await registered[0].needsApproval()) === true,
  '审批策略必须为真,否则查询词会不经确认就发出去',
);

/* ------------------------------------------------------------------ */
/* [7] 路由可见性:普通问答能看见,高危拦截时看不见                     */
/* ------------------------------------------------------------------ */

const catalog = createAppToolRegistry().getToolCatalog();
const fallbackService = new WorkflowDecisionService(
  () => {},
  undefined,
  new WorkflowRegistry(),
  catalog,
);
const fallbackConfig = {
  baseUrl: '',
  apiKey: 'test',
  model: 'test',
  exportDir: '',
  workspaceRoot: '',
  jev: { enabled: false },
};

const readOnlyDecision = await fallbackService.decide(
  fallbackConfig,
  '帮我查一下这个报错码是什么意思',
  undefined,
  [],
  {
    modelClassifier: async () => ({
      kind: 'fallback',
      mode: 'read_only',
      confidence: 0.9,
      reason: 'search visibility',
    }),
  },
);
const readOnlyTools = readOnlyDecision.allowedTools ?? [];
assert(
  readOnlyTools.includes('web_search'),
  `read_only 候选里没有 web_search: ${readOnlyTools.join('|')}`,
);

console.log('web_search 测试全部通过');
