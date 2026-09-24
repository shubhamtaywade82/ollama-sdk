/**
 * Native fetch HTTP transport client for Ollama API.
 */

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

function sameHeaders(actual: Record<string, string>, expected: Headers): boolean {
  const actualEntries = Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const expectedEntries = Object.fromEntries(expected.entries());
  const actualKeys = Object.keys(actualEntries);
  const expectedKeys = Object.keys(expectedEntries);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => actualEntries[key] === expectedEntries[key]),
  );
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
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
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

    const finalHandler = async (req: RequestContext): Promise<{
      status: number;
      headers: Record<string, string>;
      body: Response;
    }> => {
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body as NonNullable<RequestInit['body']> } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      };
      const response = await this.fetchImpl(req.url, init);
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
      const pipeline = composeMiddleware(this.middleware, finalHandler);
      const context = await pipeline(request);
      const response =
        context.body instanceof Response
          ? new Response(context.body.body, {
              status: context.status,
              headers: context.headers,
            })
          : new Response(context.body as RequestInit['body'], {
              status: context.status,
              headers: context.headers,
            });

      this.onLifecycleEvent?.({
        type: 'success',
        requestId,
        durationMs: Date.now() - startedAt,
        status: context.status,
        timestamp: Date.now(),
      });
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
    const url = `${this.baseUrl}${options.path}`;
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
            let errorBody: unknown;
            try {
              errorBody = await response.json();
            } catch {
              errorBody = await response.text();
            }
            const message =
              typeof errorBody === 'object' && errorBody !== null && 'error' in errorBody
                ? String((errorBody as { error: unknown }).error)
                : `HTTP ${response.status} ${response.statusText}`;

            throw mapError(new Error(message), {
              request: { method, url },
              response: { status: response.status, body: errorBody },
            });
          }

          if (options.method === 'HEAD' || response.status === 204) {
            return undefined as T;
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
    const url = `${this.baseUrl}${options.path}`;
    const method = options.method ?? 'POST';
    const headers = {
      ...this.buildHeaders(options.headers),
      Accept: 'text/event-stream',
    };

    return withSpan(
      `${method} ${routeTemplate(options.path)}`,
      httpSpanAttributes(method, url),
      async (span) => {
        try {
          const controller = new AbortController();
          const removeAbortListener =
            options.signal !== undefined
              ? (() => {
                  if (options.signal.aborted) {
                    controller.abort(options.signal.reason);
                  } else {
                    const onAbort = (): void => controller.abort(options.signal?.reason);
                    options.signal.addEventListener('abort', onAbort, { once: true });
                    return () => options.signal?.removeEventListener('abort', onAbort);
                  }
                  return undefined;
                })()
              : undefined;

          const response = await this.fetchWithMiddleware({
            url,
            method,
            headers,
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            signal: controller.signal,
          });
          span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

          if (!response.ok) {
            removeAbortListener?.();
            const errorText = await response.text();
            throw mapError(new Error(errorText || `HTTP ${response.status}`), {
              request: { method, url },
              response: { status: response.status, body: errorText },
            });
          }

          if (!response.body) {
            removeAbortListener?.();
            throw mapError(new Error('Response body is null, cannot stream SSE'), {
              request: { method, url },
            });
          }

          const stream = (async function* (): AsyncGenerator<SseEvent, void, undefined> {
            try {
              yield* parseSseStream(response.body!);
            } finally {
              removeAbortListener?.();
            }
          })();

          return {
            [Symbol.asyncIterator]() {
              return stream[Symbol.asyncIterator]();
            },
            abort: () => {
              removeAbortListener?.();
              controller.abort();
            },
          } as AbortableAsyncIterable<SseEvent>;
        } catch (err) {
          throw mapError(err, { request: { method, url } });
        }
      },
    );
  }

  async requestStream<T>(options: HttpRequestOptions): Promise<AbortableAsyncIterable<T>> {
    const url = `${this.baseUrl}${options.path}`;
    const method = options.method ?? 'POST';
    const headers = this.buildHeaders(options.headers);

    return withSpan(
      `${method} ${routeTemplate(options.path)}`,
      httpSpanAttributes(method, url),
      async (span) => {
        try {
          const controller = new AbortController();
          const removeAbortListener =
            options.signal !== undefined
              ? (() => {
                  if (options.signal.aborted) {
                    controller.abort(options.signal.reason);
                  } else {
                    const onAbort = (): void => controller.abort(options.signal?.reason);
                    options.signal.addEventListener('abort', onAbort, { once: true });
                    return () => options.signal?.removeEventListener('abort', onAbort);
                  }
                  return undefined;
                })()
              : undefined;

          const response = await this.fetchWithMiddleware({
            url,
            method,
            headers,
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            signal: controller.signal,
          });
          span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

          if (!response.ok) {
            removeAbortListener?.();
            const errorText = await response.text();
            throw mapError(new Error(errorText || `HTTP ${response.status}`), {
              request: { method, url },
              response: { status: response.status, body: errorText },
            });
          }

          if (!response.body) {
            removeAbortListener?.();
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
                  removeAbortListener?.();
                }
              })()[Symbol.asyncIterator]();
            },
            abort: () => {
              removeAbortListener?.();
              controller.abort();
            },
          };
          return abortable;
        } catch (err) {
          throw mapError(err, { request: { method, url } });
        }
      },
    );
  }
}
