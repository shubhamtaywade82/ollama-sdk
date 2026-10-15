import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { OllamaClient } from '../src/client.js';
import { OllamaNetworkError } from '../src/errors.js';

/**
 * Stale-socket / killed-connection recovery (digest NET-03, ADR 0031).
 *
 * Two recovery layers are pinned here against a server that terminates the
 * connection the moment it receives a request — the "daemon recycled this
 * pooled socket under us" scenario:
 *
 *   1. Real-transport recovery: the default (undici-backed) global fetch
 *      hits a socket kill, `mapError` classifies it, `withRetry` re-dispatches
 *      on a fresh connection. `client.models.list()` / `ps()` succeed without
 *      the caller ever seeing the reset.
 *   2. Classification recovery for non-`TypeError` socket errors: a custom
 *      `fetch` implementation rejecting with a raw `Error` carrying
 *      `code: 'ECONNRESET'` (the `node:http` shape — not a TypeError, so
 *      previously fell through to a non-retryable generic error) is now
 *      classified `OllamaNetworkError` → retried → succeeds.
 */

/** Per-path kill-once HTTP server: the first request per path has its socket destroyed on arrival. */
function createKillOnceServer(): {
  server: http.Server;
  start: () => Promise<string>;
  stop: () => Promise<void>;
  requestCounts: (path: string) => number;
} {
  const counts = new Map<string, number>();
  const killed = new Set<string>();
  const server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (!killed.has(path)) {
      killed.add(path);
      // Terminate the TCP connection mid-request — no status, no body.
      res.socket?.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
  });
  return {
    server,
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    requestCounts: (path) => counts.get(path) ?? 0,
  };
}

/** Fast retry config so backoff sleeps never dominate test time. */
const fastRetries = { maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 5 } };

let killServer: ReturnType<typeof createKillOnceServer>;

beforeEach(() => {
  killServer = createKillOnceServer();
});

afterEach(async () => {
  await killServer.stop();
});

describe('stale-socket recovery over the real transport (undici fetch)', () => {
  it('client.models.list() survives a socket kill on first /api/tags and re-dispatches', async () => {
    const baseUrl = await killServer.start();
    const client = new OllamaClient({ baseUrl, retries: fastRetries });
    const models = await client.models.list();
    expect(models).toEqual([]);
    // The server received the doomed request AND the retry — the reset never
    // surfaced to the caller.
    expect(killServer.requestCounts('/api/tags')).toBe(2);
  });

  it('client.models.ps() survives a socket kill on first /api/ps', async () => {
    const baseUrl = await killServer.start();
    const client = new OllamaClient({ baseUrl, retries: fastRetries });
    const ps = await client.models.ps();
    expect(ps.models).toEqual([]);
    expect(killServer.requestCounts('/api/ps')).toBe(2);
  });

  it('exhausted retries surface as OllamaNetworkError, not a raw reset', async () => {
    // A port with nothing listening: every attempt refuses (ECONNREFUSED —
    // also a classified network code). Retry exhausts, and the caller sees
    // the structured, retryable-marked network error.
    const deadClient = new OllamaClient({
      baseUrl: 'http://127.0.0.1:9', // discard port — connection refused
      retries: { maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 5 } },
    });
    await expect(deadClient.models.list()).rejects.toBeInstanceOf(OllamaNetworkError);
  });
});

describe('classification recovery for non-TypeError socket errors (custom fetch impls)', () => {
  it('retries a raw code-carrying ECONNRESET from an injected fetch — the digest checklist case', async () => {
    let calls = 0;
    const fetchImpl = (async (_input: unknown, _init?: unknown) => {
      calls += 1;
      if (calls === 1) {
        // node:http-shaped socket reset: NOT a TypeError. Before the
        // mapError network-code classification this became a non-retryable
        // generic error and list() failed outright.
        throw Object.assign(new Error('connect ECONNRESET 127.0.0.1:11434'), {
          code: 'ECONNRESET',
        });
      }
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://ollama.example',
      fetch: fetchImpl,
      retries: fastRetries,
    });
    const models = await client.models.list();
    expect(models).toEqual([]);
    expect(calls).toBe(2); // exactly one automatic re-dispatch
  });

  it('recovers through a cause chain: TypeError-wrapped UND_ERR_SOCKET classified as network', async () => {
    let calls = 0;
    const fetchImpl = (async (_input: unknown, _init?: unknown) => {
      calls += 1;
      if (calls === 1) {
        // Two levels deep: undici nests FetchError under TypeError. The
        // TypeError branch would already catch this, but the cause walk must
        // not misclassify it either way.
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' }),
        });
      }
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://ollama.example',
      fetch: fetchImpl,
      retries: fastRetries,
    });
    expect(await client.models.list()).toEqual([]);
    expect(calls).toBe(2);
  });

  it('non-network codes stay non-retryable (an EACCES is a bug, not a blip)', async () => {
    let calls = 0;
    const fetchImpl = (async (_input: unknown, _init?: unknown) => {
      calls += 1;
      throw Object.assign(new Error('access denied binding socket'), { code: 'EACCES' });
    }) as unknown as typeof fetch;

    const client = new OllamaClient({
      baseUrl: 'http://ollama.example',
      fetch: fetchImpl,
      retries: fastRetries,
    });
    // Retrying a permission error would just burn attempts — it must surface
    // on the first failure (single call).
    await expect(client.models.list()).rejects.toThrow('access denied binding socket');
    expect(calls).toBe(1);
  });
});
