import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { OLLAMA_CLOUD_BASE_URL } from '../src/config.js';
import { OllamaAuthError } from '../src/errors.js';
import type { UsageResponse } from '../src/types.js';

function jsonFetchMock(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

const usagePayload: UsageResponse = {
  range: '24h',
  scope: 'self',
  granularity: 'hour',
  from: '2026-09-30T02:00:00Z',
  until: '2026-10-01T02:30:00Z',
  totals: {
    request_count: 15,
    usage_usd: 0.01718,
    input_tokens: 106000,
    cached_input_tokens: 46000,
    output_tokens: 13600,
  },
  buckets: [
    {
      from: '2026-10-01T00:00:00Z',
      until: '2026-10-01T01:00:00Z',
      request_count: 8,
      usage_usd: 0.0088,
      input_tokens: 64000,
      cached_input_tokens: 40000,
      output_tokens: 8000,
    },
    {
      from: '2026-10-01T02:00:00Z',
      until: '2026-10-01T02:30:00Z',
      partial: true,
      request_count: 3,
      usage_usd: 0.00318,
      input_tokens: 18000,
      cached_input_tokens: 6000,
      output_tokens: 2400,
    },
  ],
};

describe('usage / balance target Ollama Cloud correctly', () => {
  it('usage() GETs https://ollama.com/api/usage with no query string when called without options', async () => {
    const fetchMock = jsonFetchMock(usagePayload);
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      apiKey: 'cloud-key',
      fetch: fetchMock as never,
    });

    const res = await client.usage();

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body?: string; headers: Record<string, string> },
    ];
    expect(url).toBe(`${OLLAMA_CLOUD_BASE_URL}/api/usage`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['Authorization']).toBe('Bearer cloud-key');
    // Omitted options are left unset so the server applies its own defaults
    // (range=7d, scope=self).
    expect(url).not.toContain('?');
    expect(res.totals.request_count).toBe(15);
    expect(res.totals.cached_input_tokens).toBe(46000);
  });

  it('usage() forwards range and scope as query parameters', async () => {
    const fetchMock = jsonFetchMock(usagePayload);
    const client = new OllamaClient({ apiKey: 'k', fetch: fetchMock as never });

    await client.usage({ range: '24h', scope: 'team' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${OLLAMA_CLOUD_BASE_URL}/api/usage?range=24h&scope=team`);
  });

  it('usage() sends only the parameters provided', async () => {
    const fetchMock = jsonFetchMock(usagePayload);
    const client = new OllamaClient({ apiKey: 'k', fetch: fetchMock as never });

    await client.usage({ range: '30d' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${OLLAMA_CLOUD_BASE_URL}/api/usage?range=30d`);
  });

  it('usage() parses buckets including the partial (in-progress) bucket', async () => {
    const fetchMock = jsonFetchMock(usagePayload);
    const client = new OllamaClient({ apiKey: 'k', fetch: fetchMock as never });

    const res = await client.usage({ range: '24h' });

    expect(res.buckets).toHaveLength(2);
    expect(res.buckets[0]?.partial).toBeUndefined();
    expect(res.buckets[1]?.partial).toBe(true);
    expect(res.granularity).toBe('hour');
  });

  it('usage() never contacts local or secondary endpoints configured for inference failover', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === `${OLLAMA_CLOUD_BASE_URL}/api/usage`) {
        return { ok: true, status: 200, json: async () => usagePayload };
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

    await client.usage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('usage() retries a transient 503 using the client default retry policy', async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({ error: 'busy' }) };
      return { ok: true, status: 200, json: async () => usagePayload };
    });
    const client = new OllamaClient({ apiKey: 'k', fetch: fetchMock as never });

    const res = await client.usage();
    expect(res.totals.request_count).toBe(15);
    expect(calls).toBe(2);
  });

  it('usage() surfaces 401 as OllamaAuthError without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid key' }),
    });
    const client = new OllamaClient({ apiKey: 'bad', fetch: fetchMock as never });

    await expect(client.usage()).rejects.toBeInstanceOf(OllamaAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('balance() GETs https://ollama.com/api/balance with no query string', async () => {
    const fetchMock = jsonFetchMock({
      included: {
        balance_usd: 72.5,
        allowance_usd: 100,
        period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' },
      },
      purchased: { balance_usd: 25 },
    });
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      apiKey: 'cloud-key',
      fetch: fetchMock as never,
    });

    const res = await client.balance();

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body?: string; headers: Record<string, string> },
    ];
    expect(url).toBe(`${OLLAMA_CLOUD_BASE_URL}/api/balance`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['Authorization']).toBe('Bearer cloud-key');
    expect(res.included.balance_usd).toBe(72.5);
    expect(res.included.period.until).toBe('2026-10-15T09:30:00Z');
    expect(res.purchased.balance_usd).toBe(25);
  });

  it('balance() parses the legacy session/weekly included shape', async () => {
    const fetchMock = jsonFetchMock({
      included: {
        session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
        weekly: { remaining_percent: 40, resets_at: '2026-10-05T00:00:00Z' },
      },
      purchased: { balance_usd: 25 },
    });
    const client = new OllamaClient({ apiKey: 'k', fetch: fetchMock as never });

    const res = await client.balance();

    expect(res.included.session.remaining_percent).toBe(75);
    expect(res.included.weekly.resets_at).toBe('2026-10-05T00:00:00Z');
    expect(res.purchased.balance_usd).toBe(25);
  });

  it('usage() and balance() share the cloud request pipeline (timeout, retry, lifecycle events)', async () => {
    const events: string[] = [];
    const fetchMock = jsonFetchMock(usagePayload);
    const client = new OllamaClient({
      apiKey: 'k',
      fetch: fetchMock as never,
      onLifecycleEvent: (event) => {
        if (event.type === 'start' || event.type === 'success' || event.type === 'error') {
          events.push(event.type);
        }
      },
    });

    await client.usage({ timeoutMs: 5_000 });
    await client.balance();

    expect(events).toEqual(['start', 'success', 'start', 'success']);
  });
});
