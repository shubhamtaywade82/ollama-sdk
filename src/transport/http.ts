/**
 * Native fetch HTTP transport client for Ollama API.
 */

import { normalizeBaseUrl } from './host.js';
import { joinUrlPath } from './url.js';
import { mapError } from '../errors.js';
import { composeMiddleware, type Middleware, type RequestContext } from '../middleware.js';
import type { RequestLifecycleHook } from '../logger.js';
import { parseNdjsonStream } from '../streaming/ndjson.js';
import { parseSseStream, type SseEvent } from '../streaming/sse.js';
import type { AbortableAsyncIterable } from '../streaming/types.js';
import {
  withSpan,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_URL_FULL,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  type SpanAttributes,
} from '../telemetry/index.js';

/** Collapses path segments with high-cardinality values (e.g. blob digests) for span names. */
function routeTemplate(path: string): string {
  return path.replace(/^\/api\/blobs\/.+$/, '/api/blobs/{digest}');
}

function httpSpanAttributes(method: string, url: string): SpanAttributes {
  const target = new URL(url);
  return {
    [ATTR_HTTP_REQUEST_METHOD]: method,
    [ATTR_URL_FULL]: url,
    [ATTR_SERVER_ADDRESS]: target.hostname,
    [ATTR_SERVER_PORT]: target.port ? Number(target.port) : undefined,
  };
}

export type FetchLike = typeof globalThis.fetch;
export type BinaryBody = Uint8Array | ArrayBuffer | string | Blob | ReadableStream<Uint8Array>;
export type HttpBody = unknown;

let requestSequence = 0;

function createRequestId(): string {
  requestSequence += 1;
  return `ollama-http-${requestSequence}`;
}

/**
 * Structural (realm-safe) guard for web `ReadableStream` bodies. Undici
 * requires `duplex: 'half'` on the fetch init whenever the body is a stream
 * (Node 18+; without it the request throws before any bytes hit the wire),
 * and the same init member is now part of the WHATWG fetch spec — harmless
 * in browsers. Duck-typing on `getReader` avoids cross-realm `instanceof`
 * misses: a stream created inside a worker/VM context is still a stream to
 * undici, and `instanceof` across realms would silently skip the member.
 */
function isWebReadableStreamBody(body: unknown): body is ReadableStream<Uint8Array> {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { getReader?: unknown }).getReader === 'function'
  );
}

/**
 * `RequestInit` plus the `duplex` member this project's `@types/node`
 * `RequestInit` doesn't carry yet (`@types/node` 22's undici types predate
 * its promotion into the shared init shape). Node's fetch reads it at
 * runtime regardless of the TS declaration — the intersection type just
 * makes the assignment legal at compile time. Assignable to plain
 * `RequestInit`, so `FetchLike` call sites need no casts.
 */
type FetchInitWithDuplex = RequestInit & { readonly duplex?: 'half' };

/** Shared fetch-init builder for the middleware and no-middleware paths. */
function buildFetchInit(req: RequestContext): FetchInitWithDuplex {
  return {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body as NonNullable<RequestInit['body']> } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
    ...(isWebReadableStreamBody(req.body) ? { duplex: 'half' } : {}),
  };
}

function sameHeaders(actual: Record<string, string>, expected: Headers): boolean {
  const actualEntries = Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const expectedEntries = Object.fromEntries(expected.entries());
  const actualKeys = Object.keys(actualEntries);
  const expectedKeys = Object.keys(expectedEntries);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => actualEntries[key] === expectedEntries[key])
  );
}

/**
 * Extracts the `Retry-After` response header (RFC 9110 § 10.2.3) into a
 * minimal headers record for error contexts: `{ 'retry-after': value }`.
 *
 * Deliberately captures ONLY this one header — the single field the error
 * hierarchy interprets (429 → `OllamaRateLimitError.retryAfterMs` via
 * `parseRetryAfterMs` in `src/errors.ts`) — rather than enumerating every
 * response header, so sensitive fields (`set-cookie`, auth echoes) never
 * leak into thrown error objects that callers may log.
 *
 * Defensive by design: error paths must never throw while enriching errors.
 * Mock `Response` shapes and alternative fetch implementations may not
 * implement `headers.get` uniformly, so every access is guarded and failure
 * degrades to `undefined` — the pre-1.19.1 error-context shape.
 */
function retryAfterHeaderFrom(response: Response): Record<string, string> | undefined {
  try {
    const headers = response?.headers as Headers | null | undefined;
    if (headers === null || headers === undefined || typeof headers.get !== 'function') {
      return undefined;
    }
    const value = headers.get('retry-after');
    if (value === null || value === '') {
      return undefined;
    }
    return { 'retry-after': value };
  } catch {
    return undefined;
  }
}

/** Error-body text plus its structured form. */
interface ErrorBody {
  /** Exact body text; `''` when the body is empty or cannot be read. */
  readonly raw: string;
  /** JSON-decoded value when the text parses, otherwise the original text. */
  readonly parsed: unknown;
}

function parseJsonOrText(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isAbortLike(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Reads a non-2xx response body exactly once.
 *
 * A body can be consumed only once. The previous `json()`-then-`text()` fallback
 * threw "Body is unusable" on its second read, and that TypeError was then
 * classified as a retryable network error, hiding the real HTTP status.
 *
 * A body that is absent, truncated or otherwise unreadable degrades to an empty
 * body: the HTTP status line is authoritative for classification, so a failed
 * body read must never change the error's class. Abort is the one exception and
 * is rethrown so cancellation keeps its `OllamaAbortError` semantics.
 *
 * `json()`-only response shapes (non-standard fetch implementations, test
 * doubles) remain supported.
 */
async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    if (typeof response.text === 'function') {
      const raw = await response.text();
      return { raw, parsed: parseJsonOrText(raw) };
    }
    if (typeof response.json === 'function') {
      const parsed: unknown = await response.json();
      return { raw: JSON.stringify(parsed) ?? '', parsed };
    }
  } catch (err) {
    if (isAbortLike(err)) throw err;
  }
  return { raw: '', parsed: '' };
}

/**
 * Bridges a caller-owned `AbortSignal` into a transport-owned `AbortController`,
 * so the transport can cancel its own fetch and stream.
 *
 * The caller's `abort` listener is registered eagerly, before the fetch is
 * awaited, so every exit path must release it:
 * - initialization failure: the catch path calls `detach()`;
 * - normal stream completion or cancellation: the stream teardown calls `detach()`.
 *
 * `detach()` is idempotent, so overlapping teardown paths cannot double-remove.
 */
interface SignalBridge {
  readonly controller: AbortController;
  readonly detach: () => void;
}

function bridgeAbortSignal(signal: AbortSignal | undefined): SignalBridge {
  const controller = new AbortController();
  if (signal === undefined) {
    return { controller, detach: () => undefined };
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
    return { controller, detach: () => undefined };
  }
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  let attached = true;
  return {
    controller,
    detach: () => {
      if (!attached) return;
      attached = false;
      signal.removeEventListener('abort', onAbort);
    },
  };
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly middleware?: readonly Middleware[] | undefined;
  readonly onLifecycleEvent?: RequestLifecycleHook | undefined;
  /** Reuse a logical request id across endpoint failover/retry attempts. */
  readonly requestId?: string | undefined;
}

export interface HttpRequestOptions {
  readonly path: string;
  readonly method?: 'GET' | 'POST' | 'DELETE' | 'HEAD' | undefined;
  readonly body?: HttpBody;
  readonly rawBody?: BinaryBody | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * When `true`, return the raw {@link Response} object instead of parsing
   * the body as JSON. Used by callers that need direct access to the
   * streaming body (e.g. {@link src/generated/runtime/runtime.ts} for
   * NDJSON streaming through the runtime seam).
   *
   * The returned `Response` is the same one middleware/retry/telemetry
   * have already processed, so this option does NOT bypass any of the
   * transport-layer concerns.
   */
  readonly raw?: boolean | undefined;
}

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey?: string | undefined;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly middleware: readonly Middleware[];
  private readonly onLifecycleEvent: RequestLifecycleHook | undefined;
  private readonly requestId?: string | undefined;

  constructor(options: HttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.defaultHeaders = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.middleware = options.middleware ?? [];
    this.onLifecycleEvent = options.onLifecycleEvent;
    this.requestId = options.requestId;
  }

  private buildHeaders(customHeaders?: Record<string, string> | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...customHeaders,
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async fetchWithMiddleware(request: RequestContext): Promise<Response> {
    const requestId = this.requestId ?? createRequestId();
    const startedAt = Date.now();
    let rawResponse: unknown;
    this.onLifecycleEvent?.({
      type: 'start',
      requestId,
      method: request.method,
      url: request.url,
      timestamp: startedAt,
    });

    const finalHandler = async (
      req: RequestContext,
    ): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Response;
    }> => {
      const response = await this.fetchImpl(req.url, buildFetchInit(req));
      rawResponse = response;
      const responseHeaders =
        response.headers && typeof response.headers.entries === 'function'
          ? Object.fromEntries(response.headers.entries())
          : {};
      return {
        status: response.status,
        headers: responseHeaders,
        body: response,
      };
    };

    try {
      if (this.middleware.length === 0) {
        const response = await this.fetchImpl(request.url, buildFetchInit(request));
        if (response.status >= 200 && response.status < 300) {
          this.onLifecycleEvent?.({
            type: 'success',
            requestId,
            durationMs: Date.now() - startedAt,
            status: response.status,
            timestamp: Date.now(),
          });
        } else {
          this.onLifecycleEvent?.({
            type: 'error',
            requestId,
            durationMs: Date.now() - startedAt,
            error: mapError(new Error(`HTTP ${response.status}`), {
              request: { method: request.method, url: request.url },
              // Mirrors the middleware path, which reports context.headers:
              // a 429 lifecycle event carries the server's Retry-After.
              response: {
                status: response.status,
                headers: retryAfterHeaderFrom(response),
              },
            }),
            timestamp: Date.now(),
          });
        }
        return response;
      }

      const pipeline = composeMiddleware(this.middleware, finalHandler);
      const context = await pipeline(request);

      let response: Response;
      if (rawResponse !== undefined && context.body === rawResponse) {
        response = rawResponse as Response;
        if (context.status !== response.status || !sameHeaders(context.headers, response.headers)) {
          const cloned = response.clone();
          response = new Response(cloned.body, {
            status: context.status,
            headers: context.headers,
          });
        }
      } else if (context.body instanceof Response) {
        if (
          context.status === context.body.status &&
          sameHeaders(context.headers, context.body.headers)
        ) {
          response = context.body;
        } else {
          const cloned = context.body.clone();
          response = new Response(cloned.body, {
            status: context.status,
            headers: context.headers,
          });
        }
      } else if (
        context.body === undefined ||
        typeof context.body === 'string' ||
        context.body instanceof ArrayBuffer ||
        ArrayBuffer.isView(context.body) ||
        context.body instanceof Blob ||
        context.body instanceof ReadableStream
      ) {
        response = new Response(context.body as RequestInit['body'], {
          status: context.status,
          headers: context.headers,
        });
      } else {
        response = new Response(JSON.stringify(context.body), {
          status: context.status,
          headers: context.headers,
        });
      }

      if (context.status >= 200 && context.status < 300) {
        this.onLifecycleEvent?.({
          type: 'success',
          requestId,
          durationMs: Date.now() - startedAt,
          status: context.status,
          timestamp: Date.now(),
        });
      } else {
        this.onLifecycleEvent?.({
          type: 'error',
          requestId,
          durationMs: Date.now() - startedAt,
          error: mapError(new Error(`HTTP ${context.status}`), {
            request: { method: request.method, url: request.url },
            response: { status: context.status, headers: context.headers },
          }),
          timestamp: Date.now(),
        });
      }
      return response;
    } catch (error) {
      const mapped = mapError(error, {
        request: { method: request.method, url: request.url },
      });
      this.onLifecycleEvent?.({
        type: 'error',
        requestId,
        durationMs: Date.now() - startedAt,
        error: mapped,
        timestamp: Date.now(),
      });
      throw mapped;
    }
  }

  async request<T>(options: HttpRequestOptions): Promise<T> {
    const url = joinUrlPath(this.baseUrl, options.path);
    const method =
      options.method ??
      (options.body !== undefined || options.rawBody !== undefined ? 'POST' : 'GET');
    const headers = this.buildHeaders(options.headers);

    if (options.rawBody !== undefined && !options.headers?.['Content-Type']) {
      delete headers['Content-Type'];
    }

    return withSpan(
      `${method} ${routeTemplate(options.path)}`,
      httpSpanAttributes(method, url),
      async (span) => {
        try {
          const bodyInit =
            options.rawBody !== undefined
              ? (options.rawBody as never)
              : options.body !== undefined
                ? JSON.stringify(options.body)
                : undefined;

          const response = await this.fetchWithMiddleware({
            url,
            method,
            headers,
            ...(bodyInit !== undefined ? { body: bodyInit } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          });
          span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

          if (!response.ok) {
            const { parsed: errorBody } = await readErrorBody(response);
            const message =
              typeof errorBody === 'object' && errorBody !== null && 'error' in errorBody
                ? String((errorBody as { error: unknown }).error)
                : `HTTP ${response.status} ${response.statusText}`;

            throw mapError(new Error(message), {
              request: { method, url },
              response: {
                status: response.status,
                headers: retryAfterHeaderFrom(response),
                body: errorBody,
              },
            });
          }

          if (options.method === 'HEAD' || response.status === 204) {
            return undefined as T;
          }

          // Raw mode: return the Response object directly so callers can
          // access the streaming body. Middleware, retry, telemetry, and
          // error-mapping have already run by this point.
          if (options.raw === true) {
            return response as unknown as T;
          }

          if (typeof response.text === 'function') {
            const text = await response.text();
            return (text ? JSON.parse(text) : undefined) as T;
          }
          if (typeof response.json === 'function') {
            return (await response.json()) as T;
          }
          return undefined as T;
        } catch (err) {
          throw mapError(err, { request: { method, url } });
        }
      },
    );
  }

  /**
   * Opens an event-stream response and exposes parsed SSE events.
   *
   * This is intentionally schema-agnostic so OpenAI and Anthropic compatibility layers
   * can decode their provider-specific event payloads without duplicating transport logic.
   */
  async requestSseStream(options: HttpRequestOptions): Promise<AbortableAsyncIterable<SseEvent>> {
    const url = joinUrlPath(this.baseUrl, options.path);
    const method = options.method ?? 'POST';
    const headers = {
      ...this.buildHeaders(options.headers),
      Accept: 'text/event-stream',
    };

    return withSpan(
      `${method} ${routeTemplate(options.path)}`,
      httpSpanAttributes(method, url),
      async (span) => {
        // Registered before fetch is awaited: the catch below must release it
        // if initialization fails, since no stream teardown will ever run.
        const bridge = bridgeAbortSignal(options.signal);
        try {
          const response = await this.fetchWithMiddleware({
            url,
            method,
            headers,
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            signal: bridge.controller.signal,
          });
          span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

          if (!response.ok) {
            const errorText = (await readErrorBody(response)).raw;
            throw mapError(new Error(errorText || `HTTP ${response.status}`), {
              request: { method, url },
              response: {
                status: response.status,
                headers: retryAfterHeaderFrom(response),
                body: errorText,
              },
            });
          }

          if (!response.body) {
            throw mapError(new Error('Response body is null, cannot stream SSE'), {
              request: { method, url },
            });
          }

          const body = response.body;
          // The listener stays attached for the whole consumption window and is
          // released on completion, error, or consumer cancellation.
          const stream = (async function* (): AsyncGenerator<SseEvent, void, undefined> {
            try {
              yield* parseSseStream(body);
            } finally {
              bridge.detach();
            }
          })();

          return {
            [Symbol.asyncIterator]() {
              return stream[Symbol.asyncIterator]();
            },
            abort: () => {
              bridge.detach();
              bridge.controller.abort();
            },
          } as AbortableAsyncIterable<SseEvent>;
        } catch (err) {
          bridge.detach();
          throw mapError(err, { request: { method, url } });
        }
      },
    );
  }

  async requestStream<T>(options: HttpRequestOptions): Promise<AbortableAsyncIterable<T>> {
    const url = joinUrlPath(this.baseUrl, options.path);
    const method = options.method ?? 'POST';
    const headers = this.buildHeaders(options.headers);

    return withSpan(
      `${method} ${routeTemplate(options.path)}`,
      httpSpanAttributes(method, url),
      async (span) => {
        // Registered before fetch is awaited: the catch below must release it
        // if initialization fails, since no stream teardown will ever run.
        const bridge = bridgeAbortSignal(options.signal);
        try {
          const response = await this.fetchWithMiddleware({
            url,
            method,
            headers,
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            signal: bridge.controller.signal,
          });
          span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

          if (!response.ok) {
            const errorText = (await readErrorBody(response)).raw;
            throw mapError(new Error(errorText || `HTTP ${response.status}`), {
              request: { method, url },
              response: {
                status: response.status,
                headers: retryAfterHeaderFrom(response),
                body: errorText,
              },
            });
          }

          if (!response.body) {
            throw mapError(new Error('Response body is null, cannot stream'), {
              request: { method, url },
            });
          }

          const stream = parseNdjsonStream<T>(response.body);
          const abortable: AbortableAsyncIterable<T> = {
            [Symbol.asyncIterator]() {
              return (async function* (): AsyncGenerator<T, void, undefined> {
                try {
                  yield* stream;
                } finally {
                  bridge.detach();
                }
              })()[Symbol.asyncIterator]();
            },
            abort: () => {
              bridge.detach();
              bridge.controller.abort();
            },
          };
          return abortable;
        } catch (err) {
          bridge.detach();
          throw mapError(err, { request: { method, url } });
        }
      },
    );
  }
}
