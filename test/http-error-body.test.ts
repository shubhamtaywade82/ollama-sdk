import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/transport/http.js';
import { withRetry } from '../src/transport/retry.js';
import {
  OllamaAbortError,
  OllamaBadGatewayError,
  OllamaGenericClientError,
  OllamaNetworkError,
  OllamaNotFoundError,
  OllamaOverloadedError,
  OllamaServerError,
} from '../src/errors.js';

/**
 * Regression pins for HTTP error-body handling (review finding F1).
 *
 * Every mock returns a fresh WHATWG `Response` so body-consumption semantics
 * match production: a body can be read exactly once. The pre-fix code called
 * `response.json()` and then `response.text()` on failure, which threw
 * "Body is unusable" and was misclassified as a network error (retryable).
 */

const BASE_URL = 'http://localhost:11434';

function errorResponse(status: number, statusText: string, body: string): Response {
  return new Response(body, {
    status,
    statusText,
    headers: body.startsWith('{') ? { 'content-type': 'application/json' } : {},
  });
}

function clientWith(responder: () => Response): {
  http: HttpClient;
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn().mockImplementation(async () => responder());
  const http = new HttpClient({ baseUrl: BASE_URL, fetch: fetch as never });
  return { http, fetch };
}

describe('HttpClient error-body classification (F1)', () => {
  it('maps a plain-text 400 to a non-retryable generic client error, preserving the body', async () => {
    const { http } = clientWith(() => errorResponse(400, 'Bad Request', 'invalid model name'));

    const error = await http.request({ path: '/api/show', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaGenericClientError);
    expect(error).not.toBeInstanceOf(OllamaNetworkError);
    expect(error).toMatchObject({
      status: 400,
      retryable: false,
      message: 'HTTP 400 Bad Request',
      response: { status: 400, body: 'invalid model name' },
    });
  });

  it('maps an HTML 404 to OllamaNotFoundError rather than a network error', async () => {
    const html = '<!doctype html><html><body>404 page not found</body></html>';
    const { http } = clientWith(() => errorResponse(404, 'Not Found', html));

    const error = await http.request({ path: '/api/show', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaNotFoundError);
    expect(error).toMatchObject({ status: 404, retryable: false, response: { body: html } });
  });

  it('maps an HTML 502 to OllamaBadGatewayError and keeps it retryable', async () => {
    const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';
    const { http } = clientWith(() => errorResponse(502, 'Bad Gateway', html));

    const error = await http.request({ path: '/api/chat', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaBadGatewayError);
    expect(error).toMatchObject({ status: 502, retryable: true, response: { body: html } });
  });

  it('maps an empty 500 body to OllamaServerError with an empty body preserved', async () => {
    const { http } = clientWith(() => errorResponse(500, 'Internal Server Error', ''));

    const error = await http.request({ path: '/api/chat', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaServerError);
    expect(error).toMatchObject({
      status: 500,
      retryable: true,
      message: 'HTTP 500 Internal Server Error',
      response: { body: '' },
    });
  });

  it('still parses a JSON error body and surfaces its `error` field as the message', async () => {
    const { http } = clientWith(() =>
      errorResponse(404, 'Not Found', '{"error":"model \\"llama3\\" not found"}'),
    );

    const error = await http.request({ path: '/api/show', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaNotFoundError);
    expect(error).toMatchObject({
      message: 'model "llama3" not found',
      response: { body: { error: 'model "llama3" not found' } },
    });
  });

  it('keeps HTTP classification when the error body cannot be read', async () => {
    // Simulates a connection that drops mid-error-body: the status line already
    // arrived, so the status — not the unreadable body — decides the class.
    const truncated = {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: new Headers(),
      text: async () => {
        throw new TypeError('terminated');
      },
    } as unknown as Response;
    const { http } = clientWith(() => truncated);

    const error = await http.request({ path: '/api/chat', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaBadGatewayError);
    expect(error).not.toBeInstanceOf(OllamaNetworkError);
    expect(error).toMatchObject({ status: 502, retryable: true });
  });

  it('does not retry a plain-text 400 (permanent client error)', async () => {
    const { http, fetch } = clientWith(() => errorResponse(400, 'Bad Request', 'invalid input'));

    await expect(
      withRetry(() => http.request({ path: '/api/show', body: {} }), {
        maxRetries: 3,
        backoff: { initialDelayMs: 1, maxDelayMs: 2, backoffFactor: 1 },
      }),
    ).rejects.toBeInstanceOf(OllamaGenericClientError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries an HTML 502 up to the retry budget (transient gateway failure)', async () => {
    const { http, fetch } = clientWith(() => errorResponse(502, 'Bad Gateway', '<html>502</html>'));

    await expect(
      withRetry(() => http.request({ path: '/api/chat', body: {} }), {
        maxRetries: 2,
        backoff: { initialDelayMs: 1, maxDelayMs: 2, backoffFactor: 1 },
      }),
    ).rejects.toBeInstanceOf(OllamaBadGatewayError);

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('applies the same single-read classification to streaming error responses', async () => {
    const sseFetch = vi
      .fn()
      .mockImplementation(async () => errorResponse(503, 'Service Unavailable', 'queue full'));
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: sseFetch as never });

    const error = await http
      .requestSseStream({ path: '/v1/chat/completions', body: {} })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaOverloadedError);
    expect(error).toMatchObject({ status: 503, response: { body: 'queue full' } });
  });

  it('a caller abort while reading the error body surfaces as OllamaAbortError, not an HTTP error', async () => {
    // Cancellation must keep its abort semantics even though the status line
    // already arrived; only non-abort body failures fall back to the status.
    const abortedBody = {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      text: async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    } as unknown as Response;
    const { http } = clientWith(() => abortedBody);

    const error = await http.request({ path: '/api/chat', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaAbortError);
    expect(error).not.toBeInstanceOf(OllamaServerError);
  });
});
