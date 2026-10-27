/**
 * web_search 的工具提供者。
 *
 * 注册是有条件的:没开、或者没配 key,就不注册这个工具。
 * 理由和别处一致 —— 一个永远返回"未配置"的工具只会让模型反复去试,
 * 白烧一轮调用,还会在工具列表里占位。
 */
import type { Tool } from '@openai/agents';
import { agentLog } from '../../modelGateway';
import { getRuntimeService } from '../../services';
import type { ToolProvider } from '../../toolRegistry';
import type { ToolCapability } from '../../toolCatalog';
import {
  WEB_SEARCH_SERVICE,
  createWebSearchProvider,
  type WebSearchSettings,
} from './webSearchProvider';
import { createWebSearchTool } from './tools/webSearchTool';

const WEB_SEARCH_CAPABILITIES: readonly ToolCapability[] = [
  {
    name: 'web_search',
    description: '在互联网上搜索,返回结果的标题、链接和摘要。',
    domain: 'research',
    intents: [
      '联网搜索',
      '搜索网上资料',
      '查厂商文档',
      '查错误码含义',
      '查最新信息',
    ],
    tags: ['research', 'search', 'web', 'read'],
    risk: 'read',
    effect: 'none',
    // 查询词会离开本机,即使 risk 是 read 也要逐次确认
    requiresApproval: true,
    fallbackModes: ['general_chat', 'read_only'],
  },
];

export function createWebSearchToolProvider(): ToolProvider {
  return {
    id: 'websearch',
    capabilities: WEB_SEARCH_CAPABILITIES,
    createTools(context): readonly Tool[] {
      // 设置由宿主注入(带 key),不走 cfg —— cfg 会被写进 runs.json
      const settings = getRuntimeService<WebSearchSettings>(context.services, WEB_SEARCH_SERVICE);
      if (!settings?.enabled) return [];
      let provider;
      try {
        provider = createWebSearchProvider(settings);
      } catch (error) {
        // 供应商名写错属于配置问题:记一条日志,让工具缺席,而不是让整轮跑挂
        agentLog(
          `[websearch] 未注册 web_search: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
      if (!provider) {
        agentLog('[websearch] 未注册 web_search: 缺少 apiKey');
        return [];
      }
      return [
        createWebSearchTool(context, provider, { maxResults: settings.maxResults }),
      ];
    },
  };
}
