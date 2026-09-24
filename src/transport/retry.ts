/**
 * Retry policy and execution runner.
 */

import { OllamaAbortError, OllamaClientError } from '../errors.js';
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new OllamaAbortError('Retry backoff aborted'),
      );
      return;
    }

    const timerId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      if (timerId !== undefined) clearTimeout(timerId);
      signal?.removeEventListener('abort', onAbort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new OllamaAbortError('Retry backoff aborted'),
      );
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Executes an async operation with retries according to config.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) {
      throw (
        signal.reason instanceof Error
          ? signal.reason
          : new OllamaAbortError('Retry aborted before attempt')
      );
    }
    try {
      return await operation(attempt);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const shouldRetry = config.shouldRetry ?? isRetryableDefault;
      if (attempt >= config.maxRetries || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = calculateBackoff(attempt, config.backoff);
      config.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs, signal);
      attempt += 1;
    }
  }
}
