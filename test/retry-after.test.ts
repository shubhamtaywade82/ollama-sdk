import { describe, expect, it, vi } from 'vitest';
import {
  lookupHeader,
  mapError,
  OllamaOverloadedError,
  OllamaPaymentRequiredError,
  OllamaRateLimitError,
  OllamaServerError,
  parseRetryAfterMs,
} from '../src/errors.js';
import { retryDelayMs, withRetry } from '../src/transport/retry.js';
import { fetchWithBackoff } from '../src/transport/fetch-with-backoff.js';
import { HttpClient } from '../src/transport/http.js';

/**
 * Retry-After (RFC 9110 § 10.2.3) honoring — the 1.19.1 audit-parity fix.
 *
 * The daily audit's row 5 claimed "Native client methods with
 * OllamaRateLimitError.retryAfterMs and jittered 429 retries", but before
 * this change `retryAfterMs` was dead code: no transport site captured the
 * header, and `withRetry` never read the field. These tests cover the full
 * pipeline end to end:
 *
 *   parseRetryAfterMs / lookupHeader (src/errors.ts)
 *     → statusToError's 429 branch injecting retryAfterMs
 *     → HttpClient's three error-mapping sites capturing the header
 *     → withRetry sleeping the server's delay verbatim (jitter as fallback)
 *     → fetchWithBackoff honoring the header on 429s like the transport does
 *
 * All HTTP is mocked — no live endpoints, matching the suite's discipline.
 */

const TINY_BACKOFF = { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 } as const;

function fakeResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('parseRetryAfterMs', () => {
  it('parses delay-seconds into milliseconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('1')).toBe(1_000);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseRetryAfterMs('  30  ')).toBe(30_000);
    expect(parseRetryAfterMs('\t2\n')).toBe(2_000);
  });

  it('parses an IMF-fixdate HTTP-date relative to now', () => {
    const instant = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', 0)).toBe(instant);
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', instant - 5_000)).toBe(5_000);
  });

  it('clamps an already-past HTTP-date to 0, not a negative delay', () => {
    const past = 'Wed, 21 Oct 2026 07:28:00 GMT';
    const now = Date.parse('Thu, 22 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  it('returns undefined for missing or empty values', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
  });

  it('returns undefined for malformed values', () => {
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('P1D')).toBeUndefined(); // ISO-8601 duration: not a Retry-After format
    expect(parseRetryAfterMs('-30')).toBeUndefined();
    expect(parseRetryAfterMs('1.5')).toBeUndefined(); // V8's Date.parse would read this as a year-2001 date
    expect(parseRetryAfterMs('Wed, 21 Oct 26 07:28:00 GMT')).toBeUndefined(); // 2-digit year: obsolete form
  });

  it('returns undefined for delay-seconds too large to represent', () => {
    expect(parseRetryAfterMs('9'.repeat(400))).toBeUndefined();
  });

  it('never caps a parseable value — clamping is caller policy', () => {
    expect(parseRetryAfterMs('86400')).toBe(86_400_000);
  });
});

describe('lookupHeader', () => {
  it('matches header names case-insensitively', () => {
    expect(lookupHeader({ 'retry-after': '10' }, 'retry-after')).toBe('10');
    expect(lookupHeader({ 'Retry-After': '10' }, 'retry-after')).toBe('10');
    expect(lookupHeader({ 'RETRY-AFTER': '10' }, 'Retry-After')).toBe('10');
  });

  it('returns undefined for absent headers or records', () => {
    expect(lookupHeader(undefined, 'retry-after')).toBeUndefined();
    expect(lookupHeader({}, 'retry-after')).toBeUndefined();
    expect(lookupHeader({ 'content-type': 'application/json' }, 'retry-after')).toBeUndefined();
  });
});

describe('mapError: 429 Retry-After wiring', () => {
  it('injects retryAfterMs from a delay-seconds header', () => {
    const mapped = mapError(new Error('too many requests'), {
      response: { status: 429, headers: { 'retry-after': '2' } },
    });
    expect(mapped).toBeInstanceOf(OllamaRateLimitError);
    expect((mapped as OllamaRateLimitError).retryAfterMs).toBe(2_000);
  });

  it('injects retryAfterMs regardless of header name casing', () => {
    const mapped = mapError(new Error('too many requests'), {
      response: { status: 429, headers: { 'Retry-After': '3' } },
    });
    expect((mapped as OllamaRateLimitError).retryAfterMs).toBe(3_000);
  });

  it('injects retryAfterMs from an HTTP-date header', () => {
    const retryAt = new Date(Date.now() + 5_000).toUTCString();
    const mapped = mapError(new Error('too many requests'), {
      response: { status: 429, headers: { 'retry-after': retryAt } },
    });
    const retryAfterMs = (mapped as OllamaRateLimitError).retryAfterMs;
    expect(retryAfterMs).toBeGreaterThanOrEqual(4_000);
    expect(retryAfterMs).toBeLessThanOrEqual(5_000);
  });

  it('leaves retryAfterMs undefined when the header is absent or malformed', () => {
    const noHeader = mapError(new Error('too many requests'), { response: { status: 429 } });
    expect((noHeader as OllamaRateLimitError).retryAfterMs).toBeUndefined();

    const garbage = mapError(new Error('too many requests'), {
      response: { status: 429, headers: { 'retry-after': 'later' } },
    });
    expect((garbage as OllamaRateLimitError).retryAfterMs).toBeUndefined();
  });

  it('does not leak Retry-After parsing into non-429 status mappings', () => {
    const overloaded = mapError(new Error('queue saturated'), {
      response: { status: 503, headers: { 'retry-after': '2' } },
    });
    expect(overloaded).toBeInstanceOf(OllamaOverloadedError);
    expect((overloaded as OllamaOverloadedError).retryAfterMs).toBeUndefined();

    const payment = mapError(new Error('payment required'), {
      response: { status: 402, headers: { 'retry-after': '2' } },
    });
    expect(payment).toBeInstanceOf(OllamaPaymentRequiredError);
  });
});

describe('HttpClient: Retry-After capture across request shapes', () => {
  it('request() surfaces retryAfterMs from a 429 response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(fakeResponse(429, { error: 'rate limited' }, { 'Retry-After': '2' }));
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: mockFetch as never });

    const error = await http.request({ path: '/api/chat', body: {} }).then(
      () => {
        throw new Error('expected rejection');
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(OllamaRateLimitError);
    expect((error as OllamaRateLimitError).retryAfterMs).toBe(2_000);
  });

  it('requestStream() surfaces retryAfterMs from a 429 response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(fakeResponse(429, { error: 'rate limited' }, { 'Retry-After': '3' }));
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: mockFetch as never });

    const error = await http.requestStream({ path: '/api/chat', body: {} }).then(
      () => {
        throw new Error('expected rejection');
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(OllamaRateLimitError);
    expect((error as OllamaRateLimitError).retryAfterMs).toBe(3_000);
  });

  it('requestSseStream() surfaces retryAfterMs from a 429 response', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(fakeResponse(429, { error: 'rate limited' }, { 'Retry-After': '4' }));
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: mockFetch as never });

    const error = await http.requestSseStream({ path: '/api/chat', body: {} }).then(
      () => {
        throw new Error('expected rejection');
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(OllamaRateLimitError);
    expect((error as OllamaRateLimitError).retryAfterMs).toBe(4_000);
  });

  it('degrades gracefully when the response has no readable headers', async () => {
    // Minimal duck-typed Response without a Headers implementation — the
    // defensive capture must not throw while enriching the error.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate limited' }),
      text: async () => '{"error":"rate limited"}',
    });
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: mockFetch as never });

    const error = await http.request({ path: '/api/chat', body: {} }).then(
      () => {
        throw new Error('expected rejection');
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(OllamaRateLimitError);
    expect((error as OllamaRateLimitError).retryAfterMs).toBeUndefined();
  });
});

describe('retryDelayMs: server authority over jitter', () => {
  const backoff = { initialDelayMs: 10_000, maxDelayMs: 30_000, backoffFactor: 2 };

  it('returns a rate limit error retryAfterMs verbatim, without jitter', () => {
    const error = new OllamaRateLimitError('limited', { status: 429, retryAfterMs: 123 });
    expect(retryDelayMs(error, 0, backoff)).toBe(123);
  });

  it('falls back to jittered backoff when retryAfterMs is absent', () => {
    const error = new OllamaRateLimitError('limited', { status: 429 });
    const delay = retryDelayMs(error, 0, backoff);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(backoff.initialDelayMs);
  });

  it('uses jittered backoff for other retryable errors', () => {
    const error = new OllamaServerError('busy', { status: 503 });
    const delay = retryDelayMs(error, 0, backoff);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(backoff.initialDelayMs);
  });
});

describe('withRetry: Retry-After precedence', () => {
  it('sleeps the server-provided retryAfterMs instead of jittered backoff', async () => {
    const rateLimit = new OllamaRateLimitError('limited', { status: 429, retryAfterMs: 25 });
    const fn = vi.fn().mockRejectedValueOnce(rateLimit).mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    const startedAt = Date.now();

    const res = await withRetry(fn, {
      maxRetries: 2,
      // Jitter ceiling of 10s: if the server value were ignored, this test
      // would crawl (and the onRetry assertion below would fail first).
      backoff: { initialDelayMs: 10_000, maxDelayMs: 10_000, backoffFactor: 1 },
      onRetry,
    });

    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(rateLimit, 0, 25);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  it('falls back to jittered backoff when the 429 carries no Retry-After', async () => {
    const rateLimit = new OllamaRateLimitError('limited', { status: 429 });
    const fn = vi.fn().mockRejectedValueOnce(rateLimit).mockResolvedValueOnce('ok');
    const onRetry = vi.fn();

    await withRetry(fn, { maxRetries: 2, backoff: TINY_BACKOFF, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    const [, , delayMs] = onRetry.mock.calls[0]!;
    expect(delayMs).toBeGreaterThanOrEqual(0);
    expect(delayMs).toBeLessThanOrEqual(TINY_BACKOFF.initialDelayMs);
  });
});

describe('fetchWithBackoff: Retry-After on 429s', () => {
  it('honors a Retry-After delay-seconds value verbatim (no jitter, no clamp)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(429, { error: 'limited' }, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
    const onRetry = vi.fn();
    const startedAt = Date.now();

    const res = await fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        // A 10s jitter ceiling: ignoring the server's 1s would make this test crawl.
        backoff: { initialDelayMs: 10_000, maxDelayMs: 10_000, backoffFactor: 1 },
        onRetry,
      },
    );

    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(0, 429, 1_000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
  });

  it('treats Retry-After: 0 as retry-immediately', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(429, { error: 'limited' }, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
    const onRetry = vi.fn();

    const res = await fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        backoff: TINY_BACKOFF,
        onRetry,
      },
    );

    expect(res.status).toBe(200);
    expect(onRetry).toHaveBeenCalledWith(0, 429, 0);
  });

  it('keeps full-jitter backoff for 429s without the header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(429, { error: 'limited' }))
      .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
    const onRetry = vi.fn();

    await fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        backoff: TINY_BACKOFF,
        onRetry,
      },
    );

    const [, , delayMs] = onRetry.mock.calls[0]!;
    expect(delayMs).toBeGreaterThanOrEqual(0);
    expect(delayMs).toBeLessThanOrEqual(TINY_BACKOFF.initialDelayMs);
  });

  it('scopes Retry-After honoring to 429s: a 503 with the header keeps jitter', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(503, { error: 'saturated' }, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
    const onRetry = vi.fn();

    await fetchWithBackoff(
      'http://x/api',
      { method: 'GET' },
      {
        fetch: fetchImpl,
        backoff: TINY_BACKOFF,
        onRetry,
      },
    );

    const [, , delayMs] = onRetry.mock.calls[0]!;
    expect(delayMs).toBeLessThanOrEqual(TINY_BACKOFF.maxDelayMs);
  });
});
