import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { OLLAMA_CLOUD_BASE_URL } from '../src/config.js';

function jsonFetchMock(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

describe('webSearch / webFetch target Ollama Cloud correctly', () => {
  it('webSearch posts to https://ollama.com/api/web_search with max_results and an auth header', async () => {
    const fetchMock = jsonFetchMock({ results: [{ title: 't', url: 'https://x', content: 'c' }] });
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      apiKey: 'cloud-key',
      fetch: fetchMock as never,
    });

    const res = await client.webSearch({ query: 'ollama', max_results: 3 });

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(url).toBe(`${OLLAMA_CLOUD_BASE_URL}/api/web_search`);
    const body = JSON.parse(init.body);
    expect(body.query).toBe('ollama');
    expect(body.max_results).toBe(3);
    expect(init.headers['Authorization']).toBe('Bearer cloud-key');
    expect(res.results[0]?.content).toBe('c');
    // Deprecated back-compat mirror — see WebSearchResult.snippet's @deprecated note.
    expect(res.results[0]?.snippet).toBe('c');
  });

  it('webSearch maps the deprecated count field to max_results when max_results is unset', async () => {
    const fetchMock = jsonFetchMock({ results: [] });
    const client = new OllamaClient({ apiKey: 'k', fetch: fetchMock as never });

    await client.webSearch({ query: 'ollama', count: 7 });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.max_results).toBe(7);
    expect(body.count).toBeUndefined();
  });

  it('webFetch posts to https://ollama.com/api/web_fetch regardless of the configured local baseUrl', async () => {
    const fetchMock = jsonFetchMock({ title: 'Example', content: 'hello', links: ['https://x'] });
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      apiKey: 'cloud-key',
      fetch: fetchMock as never,
    });

    const res = await client.webFetch({ url: 'https://example.com' });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe(`${OLLAMA_CLOUD_BASE_URL}/api/web_fetch`);
    expect(JSON.parse(init.body).url).toBe('https://example.com');
    expect(res.content).toBe('hello');
    expect(res.links).toEqual(['https://x']);
  });

  it('webSearch/webFetch never contact secondary/local endpoints configured for inference failover', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === `${OLLAMA_CLOUD_BASE_URL}/api/web_search`) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      throw new Error(`unexpected request to ${url}`);
    });
    const client = new OllamaClient({
      endpoints: [
        { name: 'primary', baseUrl: 'http://primary:11434', priority: 10 },
        { name: 'secondary', baseUrl: 'http://secondary:11434', priority: 5 },
      ],
      apiKey: 'k',
      fetch: fetchMock as never,
    });

    await client.webSearch({ query: 'ollama' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('webSearch retries on a transient failure using the client default retry policy', async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({ error: 'busy' }) };
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    });
    const client = new OllamaClient({ apiKey: 'k', fetch: fetchMock as never });

    const res = await client.webSearch({ query: 'ollama' });
    expect(res.results).toEqual([]);
    expect(calls).toBe(2);
  });
});

describe('logprobs / top_logprobs pass-through on chat and generate', () => {
  it('forwards logprobs/top_logprobs request fields and parses the response array for chat', async () => {
    const fetchMock = jsonFetchMock({
      model: 'llama3.2',
      created_at: '2026-08-24T00:00:00Z',
      message: { role: 'assistant', content: 'hi' },
      done: true,
      logprobs: [{ token: 'hi', logprob: -0.1, top_logprobs: [{ token: 'hi', logprob: -0.1 }] }],
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const res = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hello' }],
      logprobs: true,
      top_logprobs: 3,
      stream: false,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.logprobs).toBe(true);
    expect(body.top_logprobs).toBe(3);
    expect(res.logprobs?.[0]?.token).toBe('hi');
    expect(res.logprobs?.[0]?.top_logprobs?.[0]?.logprob).toBe(-0.1);
  });

  it('forwards logprobs/top_logprobs request fields and parses the response array for generate', async () => {
    const fetchMock = jsonFetchMock({
      model: 'llama3.2',
      created_at: '2026-08-24T00:00:00Z',
      response: 'hi',
      done: true,
      logprobs: [{ token: 'hi', logprob: -0.2 }],
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const res = await client.generate({
      model: 'llama3.2',
      prompt: 'hello',
      logprobs: true,
      top_logprobs: 5,
      stream: false,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.logprobs).toBe(true);
    expect(body.top_logprobs).toBe(5);
    expect(res.logprobs?.[0]?.token).toBe('hi');
    expect(res.logprobs?.[0]?.logprob).toBe(-0.2);
  });
});
