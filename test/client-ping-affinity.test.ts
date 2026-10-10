import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';

type Init = { method?: string; headers?: Record<string, string> };

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const chatBody = (host: string) => ({
  model: 'llama3',
  created_at: '2026-10-10T00:00:00Z',
  message: { role: 'assistant', content: `from:${host}` },
  done: true,
});

describe('OllamaClient.ping', () => {
  it('sends HEAD / to the best candidate and reports healthy with latency', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: Init) => okJson({}));
    const client = new OllamaClient({ baseUrl: 'http://host-a', fetch: fetchMock });
    const result = await client.ping();
    expect(result.healthy).toBe(true);
    expect(result.baseUrl).toBe('http://host-a');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(url).host).toBe('host-a');
    expect(new URL(url).pathname).toBe('/');
    expect(init.method).toBe('HEAD');
  });

  it('resolves healthy:false with an error instead of throwing on connection failure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new OllamaClient({ baseUrl: 'http://down', fetch: fetchMock, retries: 0 });
    const result = await client.ping();
    expect(result.healthy).toBe(false);
    expect(result.baseUrl).toBe('http://down');
    expect(result.error).toBeTruthy();
  });

  it('is single-shot: no failover to a second endpoint', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new OllamaClient({
      endpoints: [
        { name: 'a', baseUrl: 'http://a', priority: 2 },
        { name: 'b', baseUrl: 'http://b', priority: 1 },
      ],
      fetch: fetchMock,
      retries: 0,
    });
    const result = await client.ping();
    expect(result.baseUrl).toBe('http://a');
    expect(new Set(fetchMock.mock.calls.map(([url]) => new URL(url as string).host))).toEqual(
      new Set(['a']),
    );
  });

  it('rejects when the caller aborts', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: Init & { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          // The caller may abort before fetch runs; a listener added to an
          // already-aborted signal never fires.
          if (init.signal?.aborted) return reject(init.signal.reason);
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const client = new OllamaClient({ baseUrl: 'http://slow', fetch: fetchMock as never });
    const controller = new AbortController();
    const pending = client.ping({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe('OllamaClient model-affinity routing', () => {
  function poolFetch(resident: Record<string, string[]>) {
    return vi.fn(async (url: string, _init: Init) => {
      const { host, pathname } = new URL(url);
      if (pathname === '/api/ps') {
        return okJson({ models: (resident[host] ?? []).map((name) => ({ name, model: name })) });
      }
      if (pathname === '/api/chat') return okJson(chatBody(host));
      throw new Error(`unexpected ${url}`);
    });
  }

  const endpoints = [
    { name: 'a', baseUrl: 'http://a' },
    { name: 'b', baseUrl: 'http://b' },
  ];

  it('issues no /api/ps probes when modelAffinity is not configured', async () => {
    const fetchMock = poolFetch({ b: ['llama3:latest'] });
    const client = new OllamaClient({ endpoints, fetch: fetchMock });
    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    await client.warmModelAffinity();
    expect(fetchMock.mock.calls.some(([url]) => (url as string).endsWith('/api/ps'))).toBe(false);
    expect(client.modelAffinityStatus()).toEqual([]);
  });

  it('routes to the host already holding the model after warmModelAffinity()', async () => {
    const fetchMock = poolFetch({ b: ['llama3:latest'] });
    const client = new OllamaClient({
      endpoints,
      fetch: fetchMock,
      endpointHealth: { modelAffinity: { ttlMs: 60_000 } },
    });
    await client.warmModelAffinity();
    const res = await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.message.content).toBe('from:b');

    const status = client.modelAffinityStatus();
    expect(status.map((s) => [s.endpointName, s.loadedModels, s.fresh])).toEqual([
      ['a', [], true],
      ['b', ['llama3:latest'], true],
    ]);
  });

  it('never delays a cold-cache request: it uses the original order', async () => {
    const fetchMock = poolFetch({ b: ['llama3:latest'] });
    const client = new OllamaClient({
      endpoints,
      fetch: fetchMock,
      endpointHealth: { modelAffinity: {} },
    });
    const res = await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.message.content).toBe('from:a');
  });
});
