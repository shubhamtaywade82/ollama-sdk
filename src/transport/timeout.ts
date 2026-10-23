/**
 * AbortSignal and timeout management for HTTP requests.
 */

import { OllamaAbortError, OllamaTimeoutError } from '../errors.js';

export interface TimeoutSignal {
  readonly signal: AbortSignal;
  readonly cancel: () => void;
}

/**
 * Combines an optional timeout with an optional caller-provided AbortSignal.
 */
export function createTimeoutSignal(timeoutMs?: number, userSignal?: AbortSignal): TimeoutSignal {
  if (!timeoutMs && !userSignal) {
    const controller = new AbortController();
    return { signal: controller.signal, cancel: () => undefined };
  }

  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs && timeoutMs > 0) {
    timerId = setTimeout(() => {
      controller.abort(
        new OllamaTimeoutError(`Request timed out after ${timeoutMs}ms`, { timeoutMs }),
      );
    }, timeoutMs);
  }

  const onUserAbort = (): void => {
    if (timerId) clearTimeout(timerId);
    controller.abort(userSignal?.reason);
  };

  if (userSignal) {
    if (userSignal.aborted) {
      if (timerId) clearTimeout(timerId);
      controller.abort(userSignal.reason);
    } else {
      userSignal.addEventListener('abort', onUserAbort, { once: true });
    }
  }

  const cancel = (): void => {
    if (timerId) clearTimeout(timerId);
    if (userSignal) {
      userSignal.removeEventListener('abort', onUserAbort);
    }
  };

  return { signal: controller.signal, cancel };
}

/**
 * Waits for `promise`, rejecting with an {@link OllamaAbortError} as soon as
 * `signal` aborts. The promise itself is not cancelled: it may be shared with
 * other callers (the cached cloud-model version probe is one), so one caller's
 * abort must not reject it for everyone.
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new OllamaAbortError(message));
    // Always subscribe, even when already aborted: a probe that later rejects
    // then has a handler and cannot surface as an unhandled rejection.
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
