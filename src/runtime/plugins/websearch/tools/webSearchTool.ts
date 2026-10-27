/**
 * web_search:把查询词发给外部搜索服务,拿回标题 / 链接 / 摘要。
 *
 * 三件事刻意做成这样:
 *  1. 只返回标题、链接、摘要,不抓正文。搜到之后要不要读全文,交给模型下一步决定 ——
 *     一次性抓十篇正文会把上下文吃光,而且大部分是它不需要的。
 *  2. 强制逐次审批(needsApproval)。查询词会离开本机,属于数据出站:用户问的
 *     "这个变频器报 F0002 怎么办" 可能带着现场信息。发出去之前得让人点一下。
 *  3. 查不到就如实说 0 条,不给"最接近的几条":模糊结果会把模型带向一个它
 *     原本没问的东西。
 */
import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ToolBuildContext } from '../../../tools/toolBuildContext';
import type { WebSearchProvider } from '../webSearchProvider';

/** 一次最多几条:再多模型也读不完,还会把后面真正的工具结果挤掉 */
const MAX_RESULTS = 8;
const DEFAULT_RESULTS = 5;

export function createWebSearchTool(
  context: ToolBuildContext,
  provider: WebSearchProvider,
  options: { maxResults?: number } = {},
) {
  const { contract, failed, guard, guardrails } = context;
  const ceiling = Math.min(Math.max(options.maxResults ?? DEFAULT_RESULTS, 1), MAX_RESULTS);

  return tool({
    name: 'web_search',
    description:
      '在互联网上搜索,返回若干条结果的标题、链接和摘要。' +
      '当需要工作区之外的事实、最新信息、厂商文档或错误码含义时使用 —— ' +
      '例如某个 PLC 型号的规格、某个指令集的支持情况、某个报错在官方手册里的解释。' +
      '它不读工作区里的文件,要查本地代码请用 search_files / read_file。' +
      '返回只有标题、链接和摘要,不含正文:需要细节时应当据此判断该看哪一条,而不是反复搜同一个词。' +
      '查询词会发送到外部搜索服务,所以每次调用都需要用户确认。',
    parameters: z.object({
      query: z
        .string()
        .describe('搜索词。用具体的关键词组合,例如 "S7-1200 F0002 故障 手册",不要写成整句问题'),
      count: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS)
        .optional()
        .describe(`返回条数,默认 ${DEFAULT_RESULTS},最多 ${MAX_RESULTS}`),
    }),
    // 查询词出站,必须让人看一眼再发
    needsApproval: true,
    inputGuardrails: guardrails.input,
    outputGuardrails: guardrails.output,
    execute: ({ query, count }, _toolContext, details) =>
      guard(
        async () => {
          const keyword = typeof query === 'string' ? query.trim() : '';
          if (!keyword) {
            return failed(new Error('query 不能为空,请给出具体的关键词'), 'read');
          }
          const limit = Math.min(Math.max(count ?? DEFAULT_RESULTS, 1), ceiling);
          const outcome = await provider.search({
            query: keyword,
            count: limit,
            signal: details?.signal,
          });
          const hits = outcome.hits.slice(0, limit);
          return contract(
            {
              provider: outcome.provider,
              query: outcome.query,
              hitCount: hits.length,
              ...(hits.length === 0
                ? {
                    hint:
                      '没有搜到结果。先换一组关键词(型号、错误码、厂商名)再试;' +
                      '连续两次都为空就说明这个话题在网上没有可用资料,应当直接告诉用户,不要继续换词。',
                  }
                : {}),
              hits,
              elapsedMs: outcome.elapsedMs,
            },
            'read',
          );
        },
        'read',
      ),
  });
}
