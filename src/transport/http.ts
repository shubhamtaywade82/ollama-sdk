/**
 * Native fetch HTTP transport client for Ollama API.
 */

import { mapError } from '../errors.js';
import { parseNdjsonStream } from '../streaming/ndjson.js';
import { parseSseStream } from '../streaming/sse.js';
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

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly fetch?: FetchLike | undefined;
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

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.defaultHeaders = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;
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

          const init: RequestInit = {
            method,
            headers,
            ...(bodyInit !== undefined ? { body: bodyInit } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          };

          const response = await this.fetchImpl(url, init);
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


  async requestSseStream<T>(options: HttpRequestOptions): Promise<AbortableAsyncIterable<T>> {
    const url = `${this.baseUrl}${options.path}`;
    const method = options.method ?? 'POST';
    const headers = { ...this.buildHeaders(options.headers), Accept: 'text/event-stream' };

    return withSpan(
      `${method} ${routeTemplate(options.path)}`,
      httpSpanAttributes(method, url),
      async (span) => {
        try {
          const init: RequestInit = {
            method,
            headers,
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          };
          const response = await this.fetchImpl(url, init);
          span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

          if (!response.ok) {
            const errorText = await response.text();
            throw mapError(new Error(errorText || `HTTP ${response.status}`), {
              request: { method, url },
              response: { status: response.status, body: errorText },
            });
          }
          if (!response.body) {
            throw mapError(new Error('Response body is null, cannot stream'), {
              request: { method, url },
            });
          }

          const stream = parseSseStream<T>(response.body);
          return {
            [Symbol.asyncIterator]() {
              return stream[Symbol.asyncIterator]();
            },
          } as AbortableAsyncIterable<T>;
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
          const init: RequestInit = {
            method,
            headers,
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          };

          const response = await this.fetchImpl(url, init);
          span?.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);

          if (!response.ok) {
            const errorText = await response.text();
            throw mapError(new Error(errorText || `HTTP ${response.status}`), {
              request: { method, url },
              response: { status: response.status, body: errorText },
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
              return stream[Symbol.asyncIterator]();
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
