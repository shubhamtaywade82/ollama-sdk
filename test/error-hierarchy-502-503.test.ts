import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import {
  OllamaBadGatewayError,
  OllamaClientError,
  OllamaGenericClientError,
  OllamaNotFoundError,
  OllamaOverloadedError,
  OllamaRateLimitError,
  OllamaServerError,
  mapError,
} from '../src/errors.js';

/**
 * HTTP-status-to-error-class mapping — see `src/errors.ts`'s
 * `statusToError()` function.
 *
 * Ollama's documented error codes:
 *   - 400 Bad Request      — missing parameters, unparsable JSON
 *   - 404 Not Found        — model does not exist locally or in registry
 *   - 429 Too Many Requests — rate limit exceeded
 *   - 502 Bad Gateway       — cloud model cannot be reached
 *   - 503 Service Unavailable — server queue exceeded (OLLAMA_MAX_QUEUE)
 *
 * The SDK now specializes 502 and 503 into dedicated subclasses so
 * callers can branch on the failure mode rather than parsing messages.
 * Both still inherit from OllamaServerError so existing
 * `instanceof OllamaServerError` handlers continue to catch them.
 */

function mockFetchReturning(status: number, errorBody: unknown): typeof globalThis.fetch {
  // Use a real Response object so HttpClient's body-reading pipeline
  // (response.text() / response.json()) works correctly. Plain object
  // mocks fail with "Body is unusable" under undici's strict checks.
  const fetchImpl: typeof globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(errorBody), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;
  return vi.fn(fetchImpl) as unknown as typeof globalThis.fetch;
}

describe('error hierarchy: HTTP 502 → OllamaBadGatewayError', () => {
  it('maps a 502 response to OllamaBadGatewayError', async () => {
    const fetchImpl = mockFetchReturning(502, { error: 'cloud model unreachable' });
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: fetchImpl });
    await expect(
      client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    ).rejects.toBeInstanceOf(OllamaBadGatewayError);
  });

  it('OllamaBadGatewayError extends OllamaClientError (NOT OllamaServerError)', () => {
    // See src/errors.ts: OllamaBadGatewayError extends OllamaClientError
    // directly (not OllamaServerError) because OllamaServerError's
    // constructor forces code='server_error', which would override
    // the subclass-specific code='bad_gateway'. Callers wanting to
    // catch any 5xx should branch on `error.status >= 500` rather
    // than `instanceof OllamaServerError`.
    const err = new OllamaBadGatewayError('x');
    expect(err).toBeInstanceOf(OllamaClientError);
    expect(err).toBeInstanceOf(Error);
    // NOT instanceof OllamaServerError — see the note above.
    expect(err).not.toBeInstanceOf(OllamaServerError);
  });

  it('OllamaBadGatewayError carries code="bad_gateway", status=502, retryable=true', () => {
    const err = new OllamaBadGatewayError('cloud model unreachable');
    expect(err.code).toBe('bad_gateway');
    expect(err.status).toBe(502);
    expect(err.retryable).toBe(true);
  });
});

describe('error hierarchy: HTTP 503 → OllamaOverloadedError', () => {
  it('maps a 503 response to OllamaOverloadedError', async () => {
    const fetchImpl = mockFetchReturning(503, { error: 'queue full' });
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: fetchImpl });
    await expect(
      client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    ).rejects.toBeInstanceOf(OllamaOverloadedError);
  });

  it('OllamaOverloadedError extends OllamaClientError (NOT OllamaServerError)', () => {
    // See src/errors.ts: same rationale as OllamaBadGatewayError above.
    const err = new OllamaOverloadedError('x');
    expect(err).toBeInstanceOf(OllamaClientError);
    expect(err).not.toBeInstanceOf(OllamaServerError);
  });

  it('OllamaOverloadedError carries code="overloaded", status=503, retryable=true', () => {
    const err = new OllamaOverloadedError('queue full');
    expect(err.code).toBe('overloaded');
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });
});

describe('error hierarchy: existing specializations remain intact', () => {
  it('HTTP 404 still maps to OllamaNotFoundError', async () => {
    const fetchImpl = mockFetchReturning(404, { error: 'model "ghost" not found' });
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: fetchImpl });
    await expect(
      client.chat({ model: 'ghost', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    ).rejects.toBeInstanceOf(OllamaNotFoundError);
  });

  it('HTTP 429 still maps to OllamaRateLimitError', async () => {
    const fetchImpl = mockFetchReturning(429, { error: 'rate limit exceeded' });
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: fetchImpl });
    await expect(
      client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    ).rejects.toBeInstanceOf(OllamaRateLimitError);
  });

  it('HTTP 500 still maps to OllamaServerError (generic, not specialized)', async () => {
    const fetchImpl = mockFetchReturning(500, { error: 'internal server error' });
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: fetchImpl });
    const err = await client
      .chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OllamaServerError);
    expect(err).not.toBeInstanceOf(OllamaOverloadedError);
    expect(err).not.toBeInstanceOf(OllamaBadGatewayError);
  });

  it('HTTP 400 maps to OllamaGenericClientError (no specialization needed)', async () => {
    const fetchImpl = mockFetchReturning(400, { error: 'missing model' });
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: fetchImpl });
    await expect(
      client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    ).rejects.toBeInstanceOf(OllamaGenericClientError);
  });
});

describe('error hierarchy: callers can branch on specialization without losing catch-all behavior', () => {
  it('callers wanting "any 5xx" should branch on status range, not instanceof', () => {
    // Because OllamaOverloadedError and OllamaBadGatewayError extend
    // OllamaClientError directly (NOT OllamaServerError — see the
    // rationale in src/errors.ts), `instanceof OllamaServerError` does
    // NOT catch 502/503. Callers wanting to catch any 5xx should use
    // the status-code range check below.
    const overloaded = new OllamaOverloadedError('q');
    const badGateway = new OllamaBadGatewayError('c');
    // OllamaServerError's constructor signature (Omit<OllamaClientErrorOptions,
    // 'code' | 'retryable'>) allows passing `status` via options.
    const generic = new OllamaServerError('internal', { status: 500 });

    const isAny5xx = (err: OllamaClientError): boolean =>
      typeof err.status === 'number' && err.status >= 500 && err.status < 600;

    expect(isAny5xx(overloaded)).toBe(true);
    expect(isAny5xx(badGateway)).toBe(true);
    expect(isAny5xx(generic)).toBe(true);
  });

  it('callers can branch on the specialized class for differentiated handling', () => {
    const handleErr = (err: OllamaClientError): string => {
      if (err instanceof OllamaOverloadedError) return 'back-off-and-retry';
      if (err instanceof OllamaBadGatewayError) return 'fail-over-to-different-model';
      if (err instanceof OllamaServerError) return 'generic-5xx-retry';
      return 'unhandled';
    };

    expect(handleErr(new OllamaOverloadedError('q'))).toBe('back-off-and-retry');
    expect(handleErr(new OllamaBadGatewayError('c'))).toBe('fail-over-to-different-model');
    expect(handleErr(new OllamaServerError('internal'))).toBe('generic-5xx-retry');
  });
});

describe('mapError: passes through 502/503 specializations when context.response.status is set', () => {
  it('mapError on a 503 context produces OllamaOverloadedError', () => {
    const err = mapError(new Error('queue full'), {
      response: { status: 503, body: { error: 'queue full' } },
    });
    expect(err).toBeInstanceOf(OllamaOverloadedError);
    expect(err.code).toBe('overloaded');
  });

  it('mapError on a 502 context produces OllamaBadGatewayError', () => {
    const err = mapError(new Error('cloud unreachable'), {
      response: { status: 502, body: { error: 'cloud unreachable' } },
    });
    expect(err).toBeInstanceOf(OllamaBadGatewayError);
    expect(err.code).toBe('bad_gateway');
  });
});
