/**
 * Failover-aware HttpClient wrapper for OllamaRuntime.
 *
 * Wave 14: The generated OllamaRuntime takes a single HttpClient and uses
 * it for all requests. Previously, OllamaClient.runtime bound the runtime
 * to the registry's first candidate endpoint — meaning the generated API
 * surface (NativeApi, OpenAIApi, AnthropicApi) didn't participate in
 * multi-endpoint failover. If the first endpoint was down, the generated
 * API failed outright instead of failing over to the next candidate.
 *
 * This class wraps OllamaClient's failover machinery in an object that
 * implements the HttpClient surface OllamaRuntime needs. Each request()
 * call is routed through executeWithFailover, which picks the best
 * healthy endpoint, applies retry/backoff, and fails over on retryable
 * errors — exactly matching the behavior of the hand-written
 * OllamaClient methods (chat, generate, embed, etc.).
 *
 * The runtime's version-gating (enforceVersion: 'auto'/'strict') also
 * benefits: the cached server version is now probed against whichever
 * endpoint the first version-gated call lands on, and subsequent calls
 * reuse that cache. If the cached endpoint goes down, the next call
 * fails over to a healthy endpoint and the version cache is refreshed.
 */
import type { HttpRequestOptions } from './transport/http.js';
import type { OllamaClient } from './client.js';

/**
 * Minimal HttpClient surface that OllamaRuntime consumes.
 *
 * OllamaRuntime only calls http.request() — it doesn't use
 * requestStream() or requestSseStream() (those are used directly by
 * the hand-written OllamaClient methods, not the generated runtime).
 * This interface captures just what the runtime needs, so the
 * FailoverHttpClient doesn't have to implement the full HttpClient.
 */
export interface RuntimeHttpClient {
  readonly baseUrl: string;
  request<T>(options: HttpRequestOptions): Promise<T>;
}

/**
 * A failover-aware HttpClient that routes each request through
 * OllamaClient.executeWithFailover.
 *
 * The `baseUrl` property reflects the first candidate endpoint's URL —
 * this is used by inferRuntimeMode() to determine local vs cloud mode.
 * The actual request routing picks the best healthy endpoint per call,
 * not necessarily the first one.
 */
export class FailoverHttpClient implements RuntimeHttpClient {
  /**
   * The first candidate endpoint's base URL. Used for inferRuntimeMode()
   * checks (local vs cloud). The actual request routing picks the best
   * healthy endpoint per call.
   */
  readonly baseUrl: string;

  constructor(
    private readonly client: OllamaClient,
    baseUrl: string,
  ) {
    this.baseUrl = baseUrl;
  }

  /**
   * Route a request through OllamaClient's failover machinery.
   *
   * Each call to request() goes through executeWithFailover, which:
   *   - Picks the best healthy endpoint from the registry
   *   - Applies retry/backoff within that endpoint
   *   - Fails over to the next candidate on retryable errors
   *   - Reports success/failure to the endpoint health tracker
   *
   * Wave 15 (P1): the model is extracted from the request body by the
   * runtime and passed via the `model` field on the options. This lets
   * the failover layer filter endpoints by `OllamaEndpoint.models`
   * (credential-scoped routing). If no model is provided, all endpoints
   * are considered.
   *
   * The `raw` option (for streaming responses) is passed through
   * unchanged — executeWithFailover returns whatever the operation
   * callback returns, including raw Response objects.
   */
  async request<T>(options: HttpRequestOptions & { model?: string }): Promise<T> {
    const { model, ...httpOptions } = options;
    return this.client.executeWithFailover(
      async (http, signal) => {
        const mergedOptions: HttpRequestOptions = {
          ...httpOptions,
          ...(httpOptions.signal !== undefined ? { signal } : { signal }),
        };
        return http.request<T>(mergedOptions);
      },
      {
        singleEndpoint: false,
        ...(model !== undefined ? { model } : {}),
      },
    );
  }
}
