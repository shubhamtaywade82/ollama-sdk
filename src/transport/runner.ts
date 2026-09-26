/**
 * Shared request-runner contract used by native and compatibility clients.
 */

import type { HttpClient } from './http.js';

export type RequestRunner = <T>(
  op: (http: HttpClient, signal: AbortSignal) => Promise<T>,
  opts?: {
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number | undefined;
    readonly singleEndpoint?: boolean | undefined;
    readonly model?: string | undefined;
    /** Defers endpoint capacity release until the returned promise settles. */
    readonly holdUntil?: ((result: T) => Promise<unknown>) | undefined;
  },
) => Promise<T>;
