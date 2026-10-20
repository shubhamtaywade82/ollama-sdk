import { describe, expect, it } from 'vitest';
import {
  mapError,
  isNetworkLevelError,
  NETWORK_ERROR_CODES,
  lookupHeader,
  parseRetryAfterMs,
  OllamaAbortError,
  OllamaAuthError,
  OllamaGenericClientError,
  OllamaNetworkError,
  OllamaNotFoundError,
  OllamaRateLimitError,
  OllamaServerError,
} from '../src/errors.js';

describe('Error Hierarchy & Mapping', () => {
  it('preserves existing OllamaClientError instances', () => {
    const original = new OllamaAuthError('Unauthorized');
    const mapped = mapError(original);
    expect(mapped).toBe(original);
    expect(mapped.code).toBe('auth_error');
    expect(mapped.retryable).toBe(false);
  });

  it('maps DOMException AbortError to OllamaAbortError', () => {
    const abort = new DOMException('The operation was aborted', 'AbortError');
    const mapped = mapError(abort);
    expect(mapped).toBeInstanceOf(OllamaAbortError);
    expect(mapped.code).toBe('aborted');
    expect(mapped.retryable).toBe(false);
  });

  it('maps TypeError to OllamaNetworkError', () => {
    const network = new TypeError('fetch failed');
    const mapped = mapError(network);
    expect(mapped).toBeInstanceOf(OllamaNetworkError);
    expect(mapped.code).toBe('network_error');
    expect(mapped.retryable).toBe(true);
  });

  it('maps HTTP 404 to OllamaNotFoundError', () => {
    const mapped = mapError(new Error('model not found'), { response: { status: 404 } });
    expect(mapped).toBeInstanceOf(OllamaNotFoundError);
    expect(mapped.code).toBe('not_found');
    expect(mapped.status).toBe(404);
  });

  it('maps HTTP 429 to OllamaRateLimitError', () => {
    const mapped = mapError(new Error('too many requests'), { response: { status: 429 } });
    expect(mapped).toBeInstanceOf(OllamaRateLimitError);
    expect(mapped.code).toBe('rate_limited');
    expect(mapped.retryable).toBe(true);
    expect((mapped as OllamaRateLimitError).retryAfterMs).toBeUndefined();
  });

  it('maps HTTP 429 with a Retry-After header into retryAfterMs', () => {
    const mapped = mapError(new Error('too many requests'), {
      response: { status: 429, headers: { 'Retry-After': '2' } },
    });
    expect(mapped).toBeInstanceOf(OllamaRateLimitError);
    expect((mapped as OllamaRateLimitError).retryAfterMs).toBe(2_000);
  });

  it('parses Retry-After wire formats (delay-seconds and HTTP-date)', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(lookupHeader({ 'Retry-After': '10' }, 'retry-after')).toBe('10');
    expect(lookupHeader(undefined, 'retry-after')).toBeUndefined();
  });

  it('maps HTTP 500 to OllamaServerError', () => {
    const mapped = mapError(new Error('internal error'), { response: { status: 500 } });
    expect(mapped).toBeInstanceOf(OllamaServerError);
    expect(mapped.code).toBe('server_error');
    expect(mapped.retryable).toBe(true);
  });
});

describe('Network-error classification (structural code matching, ADR 0031)', () => {
  it('maps a raw code-carrying ECONNRESET to OllamaNetworkError (retryable, failover-eligible)', () => {
    const reset = Object.assign(new Error('connect ECONNRESET 127.0.0.1:11434'), {
      code: 'ECONNRESET',
    });
    const mapped = mapError(reset);
    expect(mapped).toBeInstanceOf(OllamaNetworkError);
    expect(mapped.code).toBe('network_error');
    expect(mapped.retryable).toBe(true);
    expect((mapped.cause as Error).message).toBe('connect ECONNRESET 127.0.0.1:11434');
  });

  it('maps undici dispatcher codes (UND_ERR_SOCKET family) the same way', () => {
    for (const code of ['UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT']) {
      const mapped = mapError(Object.assign(new Error('undici socket failure'), { code }));
      expect(mapped).toBeInstanceOf(OllamaNetworkError, `code=${code}`);
      expect(mapped.retryable).toBe(true);
    }
  });

  it('walks the cause chain to find network codes nested under wrappers', () => {
    const nested = new Error('request pipeline failed', {
      cause: new Error('inner transport failure', {
        cause: Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' }),
      }),
    });
    expect(isNetworkLevelError(nested)).toBe(true);
    expect(mapError(nested)).toBeInstanceOf(OllamaNetworkError);
  });

  it('keeps abort-classified errors aborts even though undici shapes them with codes', () => {
    // UND_ERR_ABORTED is deliberately NOT in the network set: it is the
    // dispatcher's caller-abort shape; retrying it would re-dispatch a
    // request the user explicitly cancelled.
    expect(NETWORK_ERROR_CODES.has('UND_ERR_ABORTED')).toBe(false);
    const aborted = Object.assign(new Error('The operation was aborted'), {
      code: 'UND_ERR_ABORTED',
    });
    expect(isNetworkLevelError(aborted)).toBe(false);
    // Not a DOMException AbortError either (custom fetch impl shape) — falls
    // through to the generic client error, which is NOT retryable.
    const mapped = mapError(aborted);
    expect(mapped).toBeInstanceOf(OllamaGenericClientError);
    expect(mapped.retryable).toBe(false);
  });

  it('leaves non-network codes to the generic mapping (no retry for EACCES)', () => {
    const denial = Object.assign(new Error('access denied'), { code: 'EACCES' });
    expect(isNetworkLevelError(denial)).toBe(false);
    const mapped = mapError(denial);
    expect(mapped).toBeInstanceOf(OllamaGenericClientError);
    expect(mapped.retryable).toBe(false);
  });

  it('bounds the cause walk: codes deeper than MAX_CAUSE_DEPTH are not classified', () => {
    let deepest = Object.assign(new Error('level 5'), { code: 'ECONNRESET' });
    for (let i = 0; i < 5; i += 1) {
      deepest = new Error(`level ${4 - i}`, { cause: deepest });
    }
    expect(isNetworkLevelError(deepest)).toBe(false);
  });

  it('tolerates cause cycles without spinning', () => {
    const a: { cause?: unknown; code?: string } = { code: 'ENOENT' };
    const b = { cause: a };
    a.cause = b;
    expect(isNetworkLevelError(a)).toBe(false);
  });

  it('non-object errors and empty codes are not network failures', () => {
    expect(isNetworkLevelError(undefined)).toBe(false);
    expect(isNetworkLevelError(null)).toBe(false);
    expect(isNetworkLevelError('ECONNRESET')).toBe(false); // string, not an error object
    expect(isNetworkLevelError({ code: 123 })).toBe(false); // non-string code
    expect(isNetworkLevelError({ code: 'SOMETHING_ELSE' })).toBe(false);
  });
});
