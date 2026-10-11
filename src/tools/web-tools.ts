/**
 * Ollama web search / web fetch exposed as model-callable tools.
 *
 * Implements the "Building a search agent" pattern from
 * https://docs.ollama.com/capabilities/web-search: hand `web_search` and `web_fetch`
 * to a tool-capable model, execute the calls it emits against Ollama Cloud's hosted
 * `/api/web_search` and `/api/web_fetch`, and feed bounded results back as
 * `role: 'tool'` messages. Use with {@link ToolRegistry} / `Agent`.
 */

import { z } from 'zod';
import type {
  WebFetchRequestOptions,
  WebFetchResponse,
  WebSearchRequestOptions,
  WebSearchResponse,
} from '../types.js';
import { defineTool } from './define-tool.js';
import type { Tool } from './types.js';

/** The subset of `OllamaClient` the web tools call. */
export interface WebToolsClient {
  webSearch(req: WebSearchRequestOptions): Promise<WebSearchResponse>;
  webFetch(req: WebFetchRequestOptions): Promise<WebFetchResponse>;
}

export interface WebToolsOptions {
  /**
   * Upper bound on the model-visible JSON a single call returns. Web pages and search
   * snippets can run to thousands of tokens; the docs truncate each result to
   * `2000 * 4` characters, which is the default here. Content fields are trimmed (not
   * the serialized JSON), so the output always stays valid JSON.
   */
  readonly maxOutputChars?: number | undefined;
  /** `max_results` sent when the model omits it. Server default is 5, max 10. */
  readonly defaultMaxResults?: number | undefined;
  /** Maximum number of page links `web_fetch` returns to the model. Default 25. */
  readonly maxLinks?: number | undefined;
  /** Per-call tool execution timeout in milliseconds (see `ToolRegistryOptions.timeoutMs`). */
  readonly timeoutMs?: number | undefined;
}

export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const WEB_FETCH_TOOL_NAME = 'web_fetch';

const DEFAULT_MAX_OUTPUT_CHARS = 2000 * 4;
const DEFAULT_MAX_LINKS = 25;
const TRUNCATION_MARKER = '…[truncated]';

const webSearchSchema = z.object({
  query: z.string().min(1).describe('The search query string'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum results to return (default 5, max 10)'),
});

const webFetchSchema = z.object({
  url: z.string().min(1).describe('The URL of the web page to fetch'),
});

export type WebSearchToolParams = z.infer<typeof webSearchSchema>;
export type WebFetchToolParams = z.infer<typeof webFetchSchema>;

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, received ${String(value)}`);
  }
  return value;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length) return text.slice(0, maxChars);
  return text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** Serialize a web search response within `maxChars`, trimming each snippet evenly. */
export function formatWebSearchResult(res: WebSearchResponse, maxChars: number): string {
  const results = res.results.map(({ title, url, content }) => ({ title, url, content }));
  const full = JSON.stringify({ results });
  if (full.length <= maxChars || results.length === 0) return truncate(full, maxChars);

  // Budget the content fields: everything except the snippets is structural overhead.
  const overhead = JSON.stringify({
    results: results.map((r) => ({ ...r, content: '' })),
  }).length;
  const perResult = Math.max(0, Math.floor((maxChars - overhead) / results.length));
  const trimmed = JSON.stringify({
    results: results.map((r) => ({ ...r, content: truncate(r.content, perResult) })),
  });
  // JSON escaping can still overshoot the estimate; fall back to a hard cut.
  return trimmed.length <= maxChars ? trimmed : truncate(trimmed, maxChars);
}

/** Serialize a web fetch response within `maxChars`, trimming page content first. */
export function formatWebFetchResult(
  res: WebFetchResponse,
  maxChars: number,
  maxLinks: number = DEFAULT_MAX_LINKS,
): string {
  const page = {
    title: res.title ?? '',
    content: res.content,
    links: (res.links ?? []).slice(0, maxLinks),
  };
  const full = JSON.stringify(page);
  if (full.length <= maxChars) return full;

  const overhead = JSON.stringify({ ...page, content: '' }).length;
  const trimmed = JSON.stringify({
    ...page,
    content: truncate(page.content, Math.max(0, maxChars - overhead)),
  });
  return trimmed.length <= maxChars ? trimmed : truncate(trimmed, maxChars);
}

/** `web_search` tool backed by {@link WebToolsClient.webSearch}. */
export function createWebSearchTool(
  client: WebToolsClient,
  options: WebToolsOptions = {},
): Tool<WebSearchToolParams, string> {
  const maxChars = positiveInt(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 'maxOutputChars');
  const defaultMaxResults =
    options.defaultMaxResults === undefined
      ? undefined
      : Math.min(positiveInt(options.defaultMaxResults, 5, 'defaultMaxResults'), 10);
  return defineTool({
    name: WEB_SEARCH_TOOL_NAME,
    description:
      'Search the web for current information. Returns a list of results, each with a title, url, and relevant content snippet.',
    schema: webSearchSchema,
    timeoutMs: options.timeoutMs,
    execute: async ({ query, max_results }, { signal }) => {
      const res = await client.webSearch({
        query,
        ...((max_results ?? defaultMaxResults) !== undefined
          ? { max_results: max_results ?? defaultMaxResults }
          : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      return formatWebSearchResult(res, maxChars);
    },
  });
}

/** `web_fetch` tool backed by {@link WebToolsClient.webFetch}. */
export function createWebFetchTool(
  client: WebToolsClient,
  options: WebToolsOptions = {},
): Tool<WebFetchToolParams, string> {
  const maxChars = positiveInt(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 'maxOutputChars');
  const maxLinks = positiveInt(options.maxLinks, DEFAULT_MAX_LINKS, 'maxLinks');
  return defineTool({
    name: WEB_FETCH_TOOL_NAME,
    description:
      'Fetch a single web page by URL. Returns the page title, its main content, and links found on the page.',
    schema: webFetchSchema,
    timeoutMs: options.timeoutMs,
    execute: async ({ url }, { signal }) => {
      const res = await client.webFetch({ url, ...(signal !== undefined ? { signal } : {}) });
      return formatWebFetchResult(res, maxChars, maxLinks);
    },
  });
}

/**
 * Both web tools, ready to register:
 *
 * ```ts
 * const registry = new ToolRegistry(createWebTools(client));
 * const agent = new Agent(client, { tools: registry });
 * ```
 *
 * Requires an Ollama API key on the client (`apiKey` or `OLLAMA_API_KEY`); calls
 * always go to `https://ollama.com`, independent of the client's inference endpoints.
 */
export function createWebTools(
  client: WebToolsClient,
  options: WebToolsOptions = {},
): [Tool<WebSearchToolParams, string>, Tool<WebFetchToolParams, string>] {
  return [createWebSearchTool(client, options), createWebFetchTool(client, options)];
}
