import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { OllamaClient } from '../src/client.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  createWebFetchTool,
  createWebSearchTool,
  createWebTools,
  formatWebFetchResult,
  formatWebSearchResult,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type WebToolsClient,
} from '../src/tools/web-tools.js';
import type { WebFetchResponse, WebSearchResponse } from '../src/types.js';

function fakeClient(
  search: Partial<WebSearchResponse> = {},
  fetchRes: Partial<WebFetchResponse> = {},
): WebToolsClient & {
  webSearch: ReturnType<typeof vi.fn>;
  webFetch: ReturnType<typeof vi.fn>;
} {
  return {
    webSearch: vi.fn().mockResolvedValue({
      results: [
        { title: 'Ollama', url: 'https://ollama.com/', content: 'Cloud models are now available' },
      ],
      ...search,
    }),
    webFetch: vi.fn().mockResolvedValue({
      title: 'Ollama',
      content: 'Run models locally.',
      links: ['https://ollama.com/', 'https://ollama.com/models'],
      ...fetchRes,
    }),
  };
}

describe('createWebTools', () => {
  it('exposes web_search / web_fetch function definitions matching the documented request fields', () => {
    const [search, fetchTool] = createWebTools(fakeClient());
    expect(search.name).toBe(WEB_SEARCH_TOOL_NAME);
    expect(fetchTool.name).toBe(WEB_FETCH_TOOL_NAME);

    const searchParams = search.definition.function.parameters;
    expect(Object.keys(searchParams.properties).sort()).toEqual(['max_results', 'query']);
    expect(searchParams.required).toEqual(['query']);

    const fetchParams = fetchTool.definition.function.parameters;
    expect(Object.keys(fetchParams.properties)).toEqual(['url']);
    expect(fetchParams.required).toEqual(['url']);
  });

  it('executes web_search with the model-supplied arguments and forwards the abort signal', async () => {
    const client = fakeClient();
    const registry = new ToolRegistry(createWebTools(client));
    const controller = new AbortController();

    const result = await registry.executeToolCall(
      { function: { name: 'web_search', arguments: { query: 'ollama engine', max_results: 3 } } },
      { signal: controller.signal },
    );

    expect(result.success).toBe(true);
    expect(client.webSearch).toHaveBeenCalledWith({
      query: 'ollama engine',
      max_results: 3,
      signal: controller.signal,
    });
    expect(JSON.parse(result.outputString)).toEqual({
      results: [
        { title: 'Ollama', url: 'https://ollama.com/', content: 'Cloud models are now available' },
      ],
    });
  });

  it('applies defaultMaxResults only when the model omits max_results', async () => {
    const client = fakeClient();
    const tool = createWebSearchTool(client, { defaultMaxResults: 4 });
    await tool.execute({ query: 'a' }, {});
    await tool.execute({ query: 'b', max_results: 2 }, {});
    expect(client.webSearch.mock.calls[0]?.[0]).toMatchObject({ query: 'a', max_results: 4 });
    expect(client.webSearch.mock.calls[1]?.[0]).toMatchObject({ query: 'b', max_results: 2 });
  });

  it('omits max_results entirely when neither the model nor the options set it (server default 5)', async () => {
    const client = fakeClient();
    await createWebSearchTool(client).execute({ query: 'a' }, {});
    expect(client.webSearch.mock.calls[0]?.[0]).not.toHaveProperty('max_results');
  });

  it('rejects out-of-range max_results at the registry boundary without calling the API', async () => {
    const client = fakeClient();
    const registry = new ToolRegistry(createWebTools(client));
    const result = await registry.executeToolCall({
      function: { name: 'web_search', arguments: { query: 'x', max_results: 11 } },
    });
    expect(result.success).toBe(false);
    expect(client.webSearch).not.toHaveBeenCalled();
  });

  it('rejects an empty query / url', async () => {
    const client = fakeClient();
    const registry = new ToolRegistry(createWebTools(client));
    const search = await registry.executeToolCall({
      function: { name: 'web_search', arguments: { query: '' } },
    });
    const fetched = await registry.executeToolCall({
      function: { name: 'web_fetch', arguments: { url: '' } },
    });
    expect(search.success).toBe(false);
    expect(fetched.success).toBe(false);
    expect(client.webSearch).not.toHaveBeenCalled();
    expect(client.webFetch).not.toHaveBeenCalled();
  });

  it('surfaces API failures as tool failures, not thrown errors', async () => {
    const client = fakeClient();
    client.webFetch.mockRejectedValueOnce(new Error('401 unauthorized'));
    const registry = new ToolRegistry(createWebTools(client));
    const result = await registry.executeToolCall({
      function: { name: 'web_fetch', arguments: { url: 'ollama.com' } },
    });
    expect(result.success).toBe(false);
    expect(result.outputString).toContain('401 unauthorized');
  });

  it('validates option values eagerly', () => {
    expect(() => createWebSearchTool(fakeClient(), { maxOutputChars: 0 })).toThrow(RangeError);
    expect(() => createWebFetchTool(fakeClient(), { maxLinks: 1.5 })).toThrow(RangeError);
    expect(() => createWebSearchTool(fakeClient(), { defaultMaxResults: -1 })).toThrow(RangeError);
  });
});

describe('web tool output bounding', () => {
  it('keeps web_search output within maxOutputChars and valid JSON', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      title: `t${i}`,
      url: `https://example.com/${i}`,
      content: 'x'.repeat(10_000),
    }));
    const out = formatWebSearchResult({ results }, 2_000);
    expect(out.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(out) as { results: { title: string; content: string }[] };
    expect(parsed.results).toHaveLength(5);
    expect(parsed.results.every((r) => r.content.endsWith('…[truncated]'))).toBe(true);
  });

  it('strips the deprecated snippet mirror from the model-visible output', () => {
    const out = formatWebSearchResult(
      { results: [{ title: 't', url: 'u', content: 'c', snippet: 'c' }] },
      1_000,
    );
    expect(JSON.parse(out)).toEqual({ results: [{ title: 't', url: 'u', content: 'c' }] });
  });

  it('handles an empty result set', () => {
    expect(JSON.parse(formatWebSearchResult({ results: [] }, 100))).toEqual({ results: [] });
  });

  it('keeps web_fetch output within maxOutputChars, valid JSON, and caps links', () => {
    const links = Array.from({ length: 100 }, (_, i) => `https://example.com/${i}`);
    const out = formatWebFetchResult(
      { title: 'Page', content: 'y'.repeat(50_000), links },
      4_000,
      10,
    );
    expect(out.length).toBeLessThanOrEqual(4_000);
    const parsed = JSON.parse(out) as { title: string; content: string; links: string[] };
    expect(parsed.title).toBe('Page');
    expect(parsed.links).toHaveLength(10);
    expect(parsed.content.endsWith('…[truncated]')).toBe(true);
  });

  it('normalizes a missing title and links', () => {
    expect(JSON.parse(formatWebFetchResult({ content: 'c' }, 1_000))).toEqual({
      title: '',
      content: 'c',
      links: [],
    });
  });
});

describe('web tools inside the Agent loop (docs "Building a search agent")', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs web_search against https://ollama.com with the API key and feeds the result back as a tool message', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://ollama.com/api/web_search') {
        return new Response(
          JSON.stringify({
            results: [{ title: 'Ollama', url: 'https://ollama.com/', content: 'New engine' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', apiKey: 'test-key' });
    let turn = 0;
    const chat = vi.fn(async () => {
      turn += 1;
      if (turn === 1) {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'web_search',
                  arguments: { query: "ollama's new engine", max_results: 1 },
                },
              },
            ],
          },
        };
      }
      return { message: { role: 'assistant' as const, content: 'Ollama shipped a new engine.' } };
    });

    const agent = new Agent(
      { chat },
      { tools: new ToolRegistry(createWebTools(client)), validateToolCapability: false },
    );
    const result = await agent.run({
      model: 'qwen3:4b',
      messages: [{ role: 'user', content: "what is ollama's new engine" }],
    });

    expect(result.finalMessage.content).toBe('Ollama shipped a new engine.');
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(init.body))).toEqual({ query: "ollama's new engine", max_results: 1 });

    const secondTurnMessages = (
      chat.mock.calls[1] as unknown as [
        { messages: { role: string; tool_name?: string; content: string }[] },
      ]
    )[0].messages;
    const toolMessage = secondTurnMessages.find((m) => m.role === 'tool');
    expect(toolMessage?.tool_name).toBe('web_search');
    expect(JSON.parse(toolMessage?.content ?? '{}')).toEqual({
      results: [{ title: 'Ollama', url: 'https://ollama.com/', content: 'New engine' }],
    });
  });
});
