import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FETCH_BACKOFF_CONFIG,
  RETRYABLE_STATUS_CODES,
  fetchWithBackoff,
} from '../src/transport/fetch-with-backoff.js';

/**
 * fetchWithBackoff — see `src/transport/fetch-with-backoff.ts`.
 *
 * The helper wraps any fetch-shaped function with jittered exponential
 * backoff for HTTP 503 (Ollama queue saturation) and 429 (rate-limit)
 * responses. Network-level failures (TypeError under WHATWG fetch)
 * are also retried — they're just as much a sign of transient
 * saturation as a 503.
 *
 * These tests stub `fetch` to verify the retry loop, sleep timing,
 * and abort-signal propagation without making real HTTP requests.
 */

/** Build a fake Response object compatible with WHATWG fetch. */
function fakeResponse(status: number, body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchWithBackoff: defaults', () => {
  it('exposes maxRetries=3 as the documented default', () => {
    expect(DEFAULT_FETCH_BACKOFF_CONFIG.maxRetries).toBe(3);
  });

  it('RETRYABLE_STATUS_CODES includes 429 and 503', () => {
    expect(RETRYABLE_STATUS_CODES.has(429)).toBe(true);
    expect(RETRYABLE_STATUS_CODES.has(503)).toBe(true);
    expect(RETRYABLE_STATUS_CODES.has(500)).toBe(false);
    expect(RETRYABLE_STATUS_CODES.has(504)).toBe(false);
    expect(RETRYABLE_STATUS_CODES.has(200)).toBe(false);
  });
});

describe('fetchWithBackoff: retry behavior', () => {
  it('returns the response on first success without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200));
    const res = await fetchWithBackoff('http://x/api', { method: 'GET' }, { fetch: fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP 503 and returns the eventual success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(200));
    const onRetry = vi.fn();
    const res = await fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        maxRetries: 3,
        backoff: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 },
        onRetry,
      },
    );
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    // onRetry receives (attempt, status, delayMs)
    expect(onRetry).toHaveBeenLastCalledWith(1, 503, expect.any(Number));
  });

  it('retries on HTTP 429 the same way as 503', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(429))
      .mockResolvedValueOnce(fakeResponse(200));
    const res = await fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        maxRetries: 2,
        backoff: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 },
      },
    );
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns the final 503 response when retries are exhausted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(503));
    const res = await fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        maxRetries: 2,
        backoff: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 },
      },
    );
    // Helper returns the final response — caller is expected to
    // check res.ok and branch. We do NOT throw on retry exhaustion
    // because the response object is still useful (Retry-After header,
    // error body, etc).
    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does NOT retry on non-503/429 server errors (e.g. 500)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(500));
    const res = await fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        maxRetries: 3,
        backoff: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 },
      },
    );
    expect(res.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on client errors (e.g. 400, 404, 401)', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(status));
      const res = await fetchWithBackoff(
        'http://x/api',
        { method: 'GET' },
        {
          fetch: fetchImpl,
          maxRetries: 3,
          backoff: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 },
        },
      );
      expect(res.status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});

describe('fetchWithBackoff: network-level failures', () => {
  it('retries when fetch rejects with a TypeError (network failure)', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(fakeResponse(200));
    const onRetry = vi.fn();
    const res = await fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        maxRetries: 2,
        backoff: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 },
        onRetry,
      },
    );
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // status=0 indicates a network-level failure (no HTTP response received)
    expect(onRetry).toHaveBeenCalledWith(0, 0, expect.any(Number));
  });

  it('throws the last network error when retries are exhausted', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      fetchWithBackoff(
        'http://x/api',
        { method: 'GET' },
        {
          fetch: fetchImpl,
          maxRetries: 2,
          backoff: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 },
        },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('fetchWithBackoff: abort signal', () => {
  it('aborts immediately when signal is already aborted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200));
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchWithBackoff(
        'http://x/api',
        { method: 'GET' },
        {
          fetch: fetchImpl,
          signal: controller.signal,
          maxRetries: 3,
          backoff: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 },
        },
      ),
    ).rejects.toThrow();
    // Note: fetch may or may not be called depending on whether
    // the runtime aborts before or after the first fetchImpl call.
  });

  it('aborts mid-backoff-sleep when signal fires during retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(503));
    const controller = new AbortController();
    const retryPromise = fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        signal: controller.signal,
        maxRetries: 5,
        backoff: { initialDelayMs: 10_000, maxDelayMs: 10_000, backoffFactor: 1 },
      },
    );
    // Let the first attempt land and the retry sleep begin, then abort.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(retryPromise).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchWithBackoff: missing fetch implementation', () => {
  it('throws a helpful error when no fetch is available', async () => {
    // Save and clear globalThis.fetch to simulate a no-fetch environment.
    const savedFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      await expect(fetchWithBackoff('http://x/api')).rejects.toThrow(
        /no global fetch is available/,
      );
    } finally {
      (globalThis as { fetch?: unknown }).fetch = savedFetch;
    }
  });
});
