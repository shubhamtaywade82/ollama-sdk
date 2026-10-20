/**
 * Retry policy and execution runner.
 */

import { OllamaAbortError, OllamaClientError, OllamaRateLimitError } from '../errors.js';
import { calculateBackoff, type BackoffOptions, DEFAULT_BACKOFF } from './backoff.js';

export interface RetryConfig {
  readonly maxRetries: number;
  readonly backoff: BackoffOptions;
  readonly shouldRetry?: (error: Error, attempt: number) => boolean;
  readonly onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  backoff: DEFAULT_BACKOFF,
};

function isRetryableDefault(error: Error): boolean {
  if (error instanceof OllamaClientError) {
    return error.retryable;
  }
  return false;
}

function abortError(
  signal: AbortSignal | undefined,
  fallbackMessage: string,
): OllamaAbortError | OllamaClientError {
  const reason = signal?.reason;
  if (reason instanceof OllamaClientError) return reason;
  return new OllamaAbortError(
    reason instanceof Error && reason.message ? reason.message : fallbackMessage,
    { cause: reason },
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal, 'Retry backoff aborted'));
      return;
    }

    const timerId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      if (timerId !== undefined) clearTimeout(timerId);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal, 'Retry backoff aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Computes the pre-retry delay for a failed attempt.
 *
 * When the error is an `OllamaRateLimitError` carrying `retryAfterMs` —
 * parsed from the server's `Retry-After` header (RFC 9110 § 10.2.3) — the
 * server's value is authoritative and is honored verbatim: no jitter, and no
 * clamping to `maxDelayMs`. The server has explicitly said when the client
 * may retry, and re-issuing earlier than that would only compound the rate
 * limiting the 429 is protecting against; callers who consider a server
 * value excessive should bail out via `shouldRetry`, the abort signal, or a
 * `maxRetries` budget rather than silently shrinking the delay.
 *
 * Every other retryable error falls back to full-jitter exponential backoff
 * (`calculateBackoff`), since only the server knows its own 429 cadence.
 */
export function retryDelayMs(error: Error, attempt: number, backoff: BackoffOptions): number {
  if (error instanceof OllamaRateLimitError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return calculateBackoff(attempt, backoff);
}

/**
 * Executes an async operation with retries according to config.
 *
 * Retry pacing: a 429 whose `Retry-After` header produced
 * `OllamaRateLimitError.retryAfterMs` sleeps exactly that long before the
 * next attempt (server authority — see {@link retryDelayMs}); all other
 * retryable errors sleep a full-jitter exponential backoff. The delay
 * actually used is reported to `onRetry` either way, and remains abortable
 * through `signal` for the whole wait.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation(attempt);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const shouldRetry = config.shouldRetry ?? isRetryableDefault;
      if (attempt >= config.maxRetries || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = retryDelayMs(error, attempt, config.backoff);
      config.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs, signal);
      attempt += 1;
    }
  }
}
