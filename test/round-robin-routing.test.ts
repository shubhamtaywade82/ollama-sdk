import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { EndpointRegistry } from '../src/providers/endpoint-registry.js';

function jsonFetchMock(handler: (init: { headers?: Record<string, string> }) => unknown) {
  return vi.fn().mockImplementation(async (_url: string, init: { headers?: Record<string, string> }) => ({
    ok: true,
    status: 200,
    json: async () => handler(init),
  }));
}

describe('EndpointRegistry: round-robin strategy', () => {
  it('defaults to fixed priority order (same candidate first every time)', () => {
    const registry = new EndpointRegistry([
      { name: 'a', baseUrl: 'http://a' },
      { name: 'b', baseUrl: 'http://b' },
      { name: 'c', baseUrl: 'http://c' },
    ]);
    expect(registry.candidates().map((e) => e.name)).toEqual(['a', 'b', 'c']);
    expect(registry.candidates().map((e) => e.name)).toEqual(['a', 'b', 'c']);
  });

  it('rotates the first candidate by one position per call', () => {
    const registry = new EndpointRegistry(
      [
        { name: 'a', baseUrl: 'http://a' },
        { name: 'b', baseUrl: 'http://b' },
        { name: 'c', baseUrl: 'http://c' },
      ],
      { strategy: 'round-robin' },
    );
    expect(registry.candidates().map((e) => e.name)).toEqual(['a', 'b', 'c']);
    expect(registry.candidates().map((e) => e.name)).toEqual(['b', 'c', 'a']);
    expect(registry.candidates().map((e) => e.name)).toEqual(['c', 'a', 'b']);
    expect(registry.candidates().map((e) => e.name)).toEqual(['a', 'b', 'c']); // wraps
  });

  it('never lets round-robin promote a lower-priority candidate above a higher one', () => {
    const registry = new EndpointRegistry(
      [
        { name: 'high', baseUrl: 'http://high', priority: 10 },
        { name: 'low-a', baseUrl: 'http://low-a' },
        { name: 'low-b', baseUrl: 'http://low-b' },
      ],
      { strategy: 'round-robin' },
    );
    // "high" always leads; only the low-priority tier rotates behind it.
    expect(registry.candidates().map((e) => e.name)).toEqual(['high', 'low-a', 'low-b']);
    expect(registry.candidates().map((e) => e.name)).toEqual(['high', 'low-b', 'low-a']);
  });

  it('rotates independently per same-priority tier when tiers differ in size', () => {
    const registry = new EndpointRegistry(
      [
        { name: 'a', baseUrl: 'http://a', priority: 5 },
        { name: 'b', baseUrl: 'http://b', priority: 5 },
        { name: 'c', baseUrl: 'http://c' },
        { name: 'd', baseUrl: 'http://d' },
        { name: 'e', baseUrl: 'http://e' },
      ],
      { strategy: 'round-robin' },
    );
    expect(registry.candidates().map((e) => e.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(registry.candidates().map((e) => e.name)).toEqual(['b', 'a', 'd', 'e', 'c']);
  });

  it('still respects model scoping under round-robin', () => {
    const registry = new EndpointRegistry(
      [
        { name: 'scoped', baseUrl: 'http://scoped', models: ['only-me'] },
        { name: 'free-a', baseUrl: 'http://free-a' },
        { name: 'free-b', baseUrl: 'http://free-b' },
      ],
      { strategy: 'round-robin' },
    );
    // "scoped" is restricted to only-me; free-a/free-b have no restriction so remain
    // eligible for every model, same as unscoped endpoints always have.
    expect(registry.candidates('only-me').map((e) => e.name).sort()).toEqual([
      'free-a',
      'free-b',
      'scoped',
    ]);
    expect(registry.candidates('anything').map((e) => e.name).sort()).toEqual(['free-a', 'free-b']);
  });
});

describe('OllamaClient: round-robin across a free credential pool', () => {
  it('spreads consecutive requests across unbound credentials', async () => {
    const seenAuth: string[] = [];
    const fetchMock = jsonFetchMock((init) => {
      seenAuth.push(init.headers?.['Authorization'] ?? 'none');
      return {
        model: 'any-model',
        created_at: '2026-08-25T00:00:00Z',
        message: { role: 'assistant', content: 'ok' },
        done: true,
      };
    });

    const client = new OllamaClient({
      baseUrl: 'https://ollama.com',
      credentials: {
        key1: { apiKey: 'KEY_1' },
        key2: { apiKey: 'KEY_2' },
        key3: { apiKey: 'KEY_3' },
      },
      endpointHealth: { strategy: 'round-robin' },
      fetch: fetchMock as never,
    });

    for (let i = 0; i < 6; i++) {
      await client.chat({ model: 'any-model', messages: [{ role: 'user', content: 'hi' }] });
    }

    expect(seenAuth).toEqual([
      'Bearer KEY_1',
      'Bearer KEY_2',
      'Bearer KEY_3',
      'Bearer KEY_1',
      'Bearer KEY_2',
      'Bearer KEY_3',
    ]);
  });

  it('still fails over to the next candidate in the rotated order on error', async () => {
    const attemptedHosts: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      attemptedHosts.push(url);
      if (url.startsWith('http://b.local')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'any-model',
            created_at: '2026-08-25T00:00:00Z',
            message: { role: 'assistant', content: 'from b' },
            done: true,
          }),
        };
      }
      return { ok: false, status: 503, json: async () => ({ error: 'overloaded' }) };
    });

    const client = new OllamaClient({
      endpoints: [
        { name: 'a', baseUrl: 'http://a.local' },
        { name: 'b', baseUrl: 'http://b.local' },
      ],
      endpointHealth: { strategy: 'round-robin' },
      retries: 0,
      fetch: fetchMock as never,
    });

    const res = await client.chat({ model: 'any-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.message.content).toBe('from b');
    expect(attemptedHosts.some((u) => u.startsWith('http://a.local'))).toBe(true);
    expect(attemptedHosts.some((u) => u.startsWith('http://b.local'))).toBe(true);
  });
});
