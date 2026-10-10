import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { OllamaAbortError } from '../src/errors.js';

/**
 * OllamaClient.ping() — the official root liveness probe: `HEAD /` answers
 * HTTP 200 (a GET / would carry the plain-text body "Ollama is running").
 * Ultra-lightweight, single-endpoint (no failover — the answer is about one
 * concrete host), single-shot (no retry), resolves instead of throwing except
 * for caller-initiated cancellation. See ADR 0028.
 */

const ok = (): Promise<Response> =>
  Promise.resolve(new Response(null, { status: 200, headers: { 'Content-Type': 'text/plain' } }));

describe('OllamaClient.ping()', () => {
  it('HEADs the root path and reports healthy with latency', async () => {
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return ok();
    });
    const client = new OllamaClient({
      baseUrl: 'http://ollama-a:11434',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.ping();
    expect(result.healthy).toBe(true);
    expect(result.baseUrl).toBe('http://ollama-a:11434');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    // joinUrlPath renders the root path as the bare origin — the same HTTP
    // request as "GET /"; servers treat them identically.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://ollama-a:11434');
  });

  it('resolves — never throws — with healthy:false + error on connection failure', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('fetch failed (ECONNREFUSED)')));
    const client = new OllamaClient({
      baseUrl: 'http://dead-host:11434',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.ping();
    expect(result).toMatchObject({
      healthy: false,
      baseUrl: 'http://dead-host:11434',
    });
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('resolves healthy:false on an HTTP error status (non-2xx daemon/proxy)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('boom', { status: 500 })));
    const client = new OllamaClient({
      baseUrl: 'http://sick:11434',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await client.ping();
    expect(result.healthy).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('resolves healthy:false when the probe times out', async () => {
    // Fetch that hangs until its signal aborts, then rejects — real fetch semantics.
    const fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (!signal) return;
          signal.addEventListener('abort', () => reject(new Error('Request timed out')), {
            once: true,
          });
        }),
    );
    const client = new OllamaClient({
      baseUrl: 'http://slow:11434',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.ping({ timeoutMs: 25 });
    expect(result.healthy).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects on caller-initiated cancellation — abort is not unhealthiness', async () => {
    // Fetch that mirrors real semantics: rejects immediately when handed an
    // already-aborted signal, and on abort otherwise.
    const fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (!signal) return;
          const abort = (): void =>
            reject(
              signal.reason instanceof Error ? signal.reason : new OllamaAbortError('aborted'),
            );
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
        }),
    );
    const client = new OllamaClient({
      baseUrl: 'http://slow:11434',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const controller = new AbortController();
    const pending = client.ping({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('is single-shot: exactly one fetch, no retry, no failover — even on failure', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    const client = new OllamaClient({
      endpoints: [
        { name: 'a', baseUrl: 'http://a:11434' },
        { name: 'b', baseUrl: 'http://b:11434' },
      ],
      fetch: fetchMock as unknown as typeof fetch,
      retries: 5,
    });

    const result = await client.ping();
    expect(result.healthy).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // not 2 endpoints × retries
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://a:11434'); // best candidate only
  });

  it('probes the current best candidate — priority is respected, not round-robined', async () => {
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      return ok();
    });
    const client = new OllamaClient({
      endpoints: [
        { name: 'primary', baseUrl: 'http://primary:11434', priority: 10 },
        { name: 'backup', baseUrl: 'http://backup:11434', priority: 1 },
      ],
      fetch: fetchMock as unknown as typeof fetch,
    });

    const first = await client.ping();
    const second = await client.ping();
    expect(first.baseUrl).toBe('http://primary:11434');
    expect(second.baseUrl).toBe('http://primary:11434'); // liveness probe, not load spreading
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the client middleware pipeline like every other request', async () => {
    const seen: string[] = [];
    const client = new OllamaClient({
      baseUrl: 'http://mw:11434',
      fetch: (() => ok()) as unknown as typeof fetch,
      middleware: [
        async (ctx, next) => {
          seen.push(`${ctx.request.method} ${ctx.request.url}`);
          return next();
        },
      ],
    });
    await client.ping();
    expect(seen).toEqual(['HEAD http://mw:11434']); // bare origin = root path
  });
});
