/**
 * Standalone fetch-with-backoff helper.
 *
 * Ollama's server caps in-flight work via `OLLAMA_MAX_QUEUE` (default
 * 512); when the queue saturates, excess requests are rejected with
 * HTTP **503 Service Unavailable**. The same retry discipline applies
 * to **429 Too Many Requests** for rate-limited cloud endpoints.
 *
 * Callers running parallel agentic swarms (multi-turn tool loops,
 * fan-out embed batches, speculative-decoding pipelines) can't always
 * predict saturation ahead of time, so the SDK exposes this helper —
 * a thin wrapper around `fetch` that retries 503/429 responses with
 * the same jittered exponential backoff used by the SDK's internal
 * transport (see `./backoff.ts` and `./retry.ts`).
 *
 * The helper is intentionally standalone: it works with any
 * `fetch`-shaped function (browser `globalThis.fetch`, `undici`, an
 * Edge runtime polyfill, or a `vi.fn()` mock) and does not depend on
 * the wider `OllamaClient` / `HttpClient` machinery. Use it when you
 * want the SDK's retry ergonomics on raw HTTP traffic that doesn't go
 * through `OllamaClient` — for example, when calling the OpenAI / Anthropic
 * compatibility bridges directly, or when talking to a sibling Ollama
 * instance outside the configured endpoint registry.
 *
 * For SDK-routed traffic (`client.chat`, `client.generate`, …),
 * retry/backoff is already applied automatically by the transport
 * layer; you do NOT need to wrap those calls in `fetchWithBackoff`.
 */

import { calculateBackoff, DEFAULT_BACKOFF, type BackoffOptions } from './backoff.js';

/**
 * Configuration for {@link fetchWithBackoff}.
 *
 * All fields optional; sensible defaults are provided.
 */
export interface FetchWithBackoffConfig {
  /**
   * Maximum number of retry attempts after the initial request.
   * Defaults to `3` (i.e. up to 4 total HTTP requests).
   */
  readonly maxRetries?: number | undefined;
  /**
   * Backoff tuning. Defaults to {@link DEFAULT_BACKOFF}
   * (`initialDelayMs: 500`, `maxDelayMs: 30_000`, `backoffFactor: 2`).
   */
  readonly backoff?: BackoffOptions | undefined;
  /**
   * Optional callback fired before each retry sleep. Useful for
   * logging, OpenTelemetry span events, or surfacing the
   * backoff in observability dashboards.
   *
   * Receives the attempt index (0-based for the original request,
   * 1+ for retries), the HTTP status that triggered the retry
   * (or `0` for network-level failures), and the calculated delay
   * in milliseconds (already jittered).
   */
  readonly onRetry?:
    | ((attempt: number, status: number, delayMs: number) => void)
    | undefined;
  /**
   * Optional `AbortSignal` forwarded to the underlying `fetch`.
   * Aborting mid-backoff cancels the sleep and rejects with an
   * `AbortError`-shaped error (the same shape `fetch` itself
   * rejects with on abort).
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Optional `fetch` implementation to use. Defaults to
   * `globalThis.fetch`. Pass an explicit implementation when
   * running in environments without a global `fetch` (legacy
   * Node.js, custom sandboxes), or to inject a mock for testing.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * HTTP statuses that trigger a retry by default. Both indicate
 * transient, server-side saturation — the queue is full and the
 * request is rejected without consuming inference resources.
 *
 *   - `503 Service Unavailable` — Ollama queue saturated
 *     (`OLLAMA_MAX_QUEUE` exceeded).
 *   - `429 Too Many Requests` — rate limit hit (typically Ollama
 *     Cloud endpoints).
 */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 503]);

/**
 * Default retry configuration used when {@link FetchWithBackoffConfig}
 * is omitted entirely. Matches the SDK's internal transport defaults
 * so consumers see identical retry behavior whether they go through
 * `OllamaClient` or call `fetchWithBackoff` directly.
 */
export const DEFAULT_FETCH_BACKOFF_CONFIG = {
  maxRetries: 3,
} as const satisfies Pick<FetchWithBackoffConfig, 'maxRetries'>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        Object.assign(new Error('fetchWithBackoff aborted during backoff sleep'), {
          name: 'AbortError',
        }),
      );
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        Object.assign(new Error('fetchWithBackoff aborted during backoff sleep'), {
          name: 'AbortError',
        }),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wrapper around any `fetch`-shaped function that retries HTTP 429 / 503
 * responses with jittered exponential backoff (full-jitter strategy —
 * see `./backoff.ts` for the rationale and AWS Architecture Blog
 * citation).
 *
 * The wrapper:
 *   - forwards `input`/`init` unchanged to every attempt,
 *   - sleeps before each retry using the configured backoff,
 *   - retries up to `maxRetries` times (default 3), then returns the
 *     final `Response` (whatever its status) so the caller can
 *     branch on it,
 *   - rethrows network errors (TypeError under WHATWG fetch) only
 *     after exhausting retries — intermediate attempts also sleep,
 *   - honors `AbortSignal` for both the underlying `fetch` and the
 *     sleep between retries.
 *
 * @example
 *   ```ts
 *   const res = await fetchWithBackoff(
 *     'http://localhost:11434/api/chat',
 *     { method: 'POST', body: JSON.stringify(payload) },
 *     {
 *       maxRetries: 5,
 *       onRetry: (attempt, status, delayMs) =>
 *         console.warn(`retry ${attempt} (HTTP ${status}) in ${delayMs}ms`),
 *     },
 *   );
 *   if (!res.ok) throw new Error(`chat failed: HTTP ${res.status}`);
 *   ```
 */
export async function fetchWithBackoff(
  input: string | URL | Request,
  init?: RequestInit | undefined,
  config: FetchWithBackoffConfig = {},
): Promise<Response> {
  const fetchImpl = config.fetch ?? (globalThis.fetch as typeof globalThis.fetch | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'fetchWithBackoff: no global fetch is available. Pass a fetch implementation ' +
        'via config.fetch, or run in Node.js >= 18 / a browser-like environment.',
    );
  }

  const maxRetries: number = config.maxRetries ?? DEFAULT_FETCH_BACKOFF_CONFIG.maxRetries;
  const backoff = config.backoff ?? DEFAULT_BACKOFF;
  const signal = config.signal;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // Defensive guard: if the signal has already been aborted (e.g.
    // caller passed an already-aborted controller, or a prior iteration's
    // sleep-abort set this in-flight), bail out before issuing the next
    // HTTP attempt. WHATWG `fetch` would reject on its own, but we add
    // the explicit check so custom `fetch` implementations that don't
    // honor `signal` still can't accidentally fire a request after the
    // caller has cancelled.
    if (signal?.aborted) {
      throw Object.assign(new Error('fetchWithBackoff aborted'), { name: 'AbortError' });
    }
    try {
      const response = await fetchImpl(input, {
        ...init,
        ...(signal !== undefined ? { signal } : {}),
      });

      if (
        RETRYABLE_STATUS_CODES.has(response.status) &&
        attempt < maxRetries
      ) {
        const delayMs = calculateBackoff(attempt, backoff);
        config.onRetry?.(attempt, response.status, delayMs);
        await sleep(delayMs, signal);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;
      // WHATWG fetch rejects with an AbortError-shaped DOMException
      // when the signal fires. Never retry those — propagate immediately.
      if (
        signal?.aborted ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        throw err;
      }
      // Network-level failures (TypeError under WHATWG fetch, or
      // any thrown error from a custom fetchImpl) are treated as
      // retryable: a connection reset mid-flight is just as much a
      // sign of transient saturation as a 503.
      if (attempt < maxRetries) {
        const delayMs = calculateBackoff(attempt, backoff);
        config.onRetry?.(attempt, 0, delayMs);
        await sleep(delayMs, signal);
        continue;
      }
    }
  }

  // All retries exhausted. Re-throw the last network-level error.
  throw lastError ?? new Error('fetchWithBackoff: exhausted retry attempts');
}
