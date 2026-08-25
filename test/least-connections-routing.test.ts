import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { EndpointRegistry } from '../src/providers/endpoint-registry.js';

describe('EndpointRegistry: least-connections strategy', () => {
  it('orders candidates by ascending active count within a priority tier', () => {
    const registry = new EndpointRegistry(
      [
        { name: 'a', baseUrl: 'http://a' },
        { name: 'b', baseUrl: 'http://b' },
        { name: 'c', baseUrl: 'http://c' },
      ],
      { strategy: 'least-connections' },
    );

    expect(registry.candidates().map((e) => e.name)).toEqual(['a', 'b', 'c']);

    registry.acquire('a');
    registry.acquire('a');
    registry.acquire('b');
    expect(registry.candidates().map((e) => e.name)).toEqual(['c', 'b', 'a']);

    registry.release('a');
    registry.release('a');
    expect(registry.candidates().map((e) => e.name)).toEqual(['a', 'c', 'b']);
  });

  it('never lets least-connections promote a lower-priority candidate above a higher one', () => {
    const registry = new EndpointRegistry(
      [
        { name: 'high', baseUrl: 'http://high', priority: 10 },
        { name: 'low-a', baseUrl: 'http://low-a' },
        { name: 'low-b', baseUrl: 'http://low-b' },
      ],
      { strategy: 'least-connections' },
    );
    registry.acquire('high');
    registry.acquire('low-b');
    // "high" still leads despite being busy; only the low tier reorders by active count.
    expect(registry.candidates().map((e) => e.name)).toEqual(['high', 'low-a', 'low-b']);
  });

  it('status() reports activeRequests per endpoint', () => {
    const registry = new EndpointRegistry([
      { name: 'a', baseUrl: 'http://a' },
      { name: 'b', baseUrl: 'http://b' },
    ]);
    registry.acquire('a');
    registry.acquire('a');
    let statuses = registry.status();
    expect(statuses.find((s) => s.endpoint.name === 'a')?.activeRequests).toBe(2);
    expect(statuses.find((s) => s.endpoint.name === 'b')?.activeRequests).toBe(0);

    registry.release('a');
    statuses = registry.status();
    expect(statuses.find((s) => s.endpoint.name === 'a')?.activeRequests).toBe(1);
  });

  it('release() never drops the active count below zero', () => {
    const registry = new EndpointRegistry([{ name: 'a', baseUrl: 'http://a' }]);
    registry.release('a');
    registry.release('a');
    expect(registry.status()[0]?.activeRequests).toBe(0);
  });
});

describe('OllamaClient: least-connections across a free-tier account pool', () => {
  it('deterministically spreads N concurrent requests across N one-slot accounts (no 429s)', async () => {
    // Each account allows exactly one concurrent request; a second concurrent hit on the
    // same account simulates the real Ollama Cloud free-tier 429.
    const inFlightByAccount = new Map<string, number>();
    const seenAccountPerCall: string[] = [];

    const fetchMock = vi.fn().mockImplementation(
      async (_url: string, init: { headers?: Record<string, string> }) => {
        const account = init.headers?.['Authorization'] ?? 'none';
        const current = (inFlightByAccount.get(account) ?? 0) + 1;
        inFlightByAccount.set(account, current);
        seenAccountPerCall.push(account);
        if (current > 1) {
          inFlightByAccount.set(account, current - 1);
          return { ok: false, status: 429, json: async () => ({ error: 'rate_limited' }) };
        }

        // Hold the "slot" for a tick to simulate an in-flight cloud request, so a second
        // concurrent call that (incorrectly) picked the same account would collide here.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlightByAccount.set(account, (inFlightByAccount.get(account) ?? 1) - 1);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'any-model',
            created_at: '2026-08-25T00:00:00Z',
            message: { role: 'assistant', content: `ok:${account}` },
            done: true,
          }),
        };
      },
    );

    const client = new OllamaClient({
      baseUrl: 'https://ollama.com',
      credentials: {
        account1: { apiKey: 'KEY_1' },
        account2: { apiKey: 'KEY_2' },
        account3: { apiKey: 'KEY_3' },
      },
      endpointHealth: { strategy: 'least-connections' },
      retries: 0,
      fetch: fetchMock as never,
    });

    const results = await Promise.all([
      client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'a' }] }),
      client.chat({ model: 'qwen2.5', messages: [{ role: 'user', content: 'b' }] }),
      client.chat({ model: 'mistral', messages: [{ role: 'user', content: 'c' }] }),
    ]);

    expect(new Set(seenAccountPerCall).size).toBe(3);
    expect(results.map((r) => r.message.content).sort()).toEqual([
      'ok:Bearer KEY_1',
      'ok:Bearer KEY_2',
      'ok:Bearer KEY_3',
    ]);
  });

  it('releases the slot after failure, so a later request can reuse that account', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('http://a.local')) {
        return { ok: false, status: 503, json: async () => ({ error: 'overloaded' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'llama3',
          created_at: '2026-08-25T00:00:00Z',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }),
      };
    });

    const client = new OllamaClient({
      endpoints: [
        { name: 'a', baseUrl: 'http://a.local' },
        { name: 'b', baseUrl: 'http://b.local' },
      ],
      endpointHealth: { strategy: 'least-connections' },
      retries: 0,
      fetch: fetchMock as never,
    });

    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });

    const statuses = client.endpointStatus();
    expect(statuses.find((s) => s.endpoint.name === 'a')?.activeRequests).toBe(0);
    expect(statuses.find((s) => s.endpoint.name === 'b')?.activeRequests).toBe(0);
  });
});
