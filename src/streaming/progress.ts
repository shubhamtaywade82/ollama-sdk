/**
 * Typed progress callback helpers for `/api/pull` and `/api/push` streams.
 *
 * Ollama emits newline-delimited progress frames of the shape:
 *
 * ```json
 * {"status":"pulling manifest"}
 * {"status":"downloading","digest":"sha256:...","total":1234567,"completed":123}
 * {"status":"verifying sha256 digest"}
 * {"status":"writing manifest","digest":"sha256:...","total":42,"completed":42}
 * {"status":"success"}
 * ```
 *
 * The SDK already exposes these as a typed {@link OllamaStream} via
 * {@link ModelsClient.pull} / {@link ModelsClient.push} when called
 * with `{ stream: true }`. This file adds a higher-level helper that
 * invokes a typed callback on every progress event with a pre-computed
 * `percent` field — for callers who want a fire-and-forget pull/push
 * without manually iterating the stream.
 *
 * ## When to use this vs. the raw `OllamaStream`
 *
 * - **`onProgress(stream, cb)`** — best for download/upload UIs that
 *   just need to render a progress bar. Resolves on `success`,
 *   rejects on stream error.
 * - **Raw `for await ... of stream`** — best for callers who want
 *   every chunk as a typed event (e.g. for structured logging, or
 *   to react to specific `status` values like `"downloading"` vs
 *   `"verifying sha256 digest"`).
 */

import { OllamaStreamError } from '../errors.js';
import type { ProgressResponse } from '../types.js';
import type { OllamaStream } from './stream.js';
import type { ProgressStreamResult } from './types.js';

/**
 * A single progress event delivered to {@link onProgress}'s callback.
 *
 * `percent` is `undefined` when the server hasn't reported byte
 * totals (e.g. for `pulling manifest`, `verifying sha256 digest`,
 * `success` — these status lines carry no `total`/`completed`).
 * For `downloading` / `writing manifest` / `writing layer` style
 * events, `percent` is the ratio of `completed / total`, clamped
 * to `[0, 100]` and rounded to two decimals.
 */
export interface PullProgressEvent {
  /** Ollama's status string (`"pulling manifest"`, `"downloading"`, `"success"`, …). */
  readonly status: string;
  /** SHA-256 digest of the layer being transferred, when applicable. */
  readonly digest?: string | undefined;
  /** Total bytes for this transfer, when the server has reported it. */
  readonly total?: number | undefined;
  /** Bytes transferred so far, when the server has reported it. */
  readonly completed?: number | undefined;
  /** Completion percentage in `[0, 100]`, or `undefined` when no byte total. */
  readonly percent?: number | undefined;
  /** The raw upstream frame, for callers who need fields this helper skips. */
  readonly raw: ProgressResponse;
}

/**
 * Callback shape accepted by {@link onProgress}.
 */
export type ProgressCallback = (event: PullProgressEvent) => void;

/**
 * Compute the completion percentage from a progress chunk.
 *
 * Returns `undefined` when either `total` or `completed` is missing
 * or zero (the server emits byte totals only for `downloading` /
 * `writing manifest` / `writing layer` style events; for
 * `pulling manifest`, `verifying sha256 digest`, `success`, etc. the
 * totals are absent and percent is undefined).
 *
 * When both are present, returns `Math.round((completed / total) * 10000) / 100`
 * — i.e. percent with two decimal places (e.g. `42.37`), clamped to
 * `[0, 100]` to guard against upstream reporting inconsistencies
 * (sometimes the server briefly reports `completed > total` during
 * dedup / verification phases).
 */
export function computeProgressPercent(chunk: ProgressResponse): number | undefined {
  if (typeof chunk.total !== 'number' || typeof chunk.completed !== 'number') return undefined;
  if (chunk.total <= 0) return undefined;
  const ratio = chunk.completed / chunk.total;
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * 10000) / 100;
}

/**
 * Wrap a {@link ProgressResponse} into a {@link PullProgressEvent}
 * with a pre-computed `percent` field.
 */
export function toPullProgressEvent(chunk: ProgressResponse): PullProgressEvent {
  return {
    status: chunk.status,
    ...(chunk.digest !== undefined ? { digest: chunk.digest } : {}),
    ...(chunk.total !== undefined ? { total: chunk.total } : {}),
    ...(chunk.completed !== undefined ? { completed: chunk.completed } : {}),
    percent: computeProgressPercent(chunk),
    raw: chunk,
  };
}

/**
 * Subscribe to a pull/push stream with a typed progress callback.
 *
 * Iterates the stream, invokes `callback` on every progress event
 * with a pre-computed `percent` field, and resolves when the stream
 * completes (`success` status). Rejects with {@link OllamaStreamError}
 * if the stream emits an in-band `{"error": "..."}` frame, or with
 * whatever error the underlying transport surfaces for HTTP-level
 * failures.
 *
 * @example
 *   ```ts
 *   const stream = await client.models.pull({ model: 'llama3.2', stream: true });
 *   await onProgress(stream, (event) => {
 *     if (event.percent !== undefined) {
 *       console.log(`${event.status}: ${event.percent}% (${event.digest?.slice(0, 12) ?? '-'})`);
 *     } else {
 *       console.log(event.status);
 *     }
 *   });
 *   console.log('pull complete');
 *   ```
 *
 * @param stream The `OllamaStream` returned by `models.pull({ stream: true })`.
 * @param callback Invoked on every progress event.
 * @returns A promise that resolves to the final {@link ProgressStreamResult}
 *          (carrying `status: 'success'`) when the stream completes.
 */
export async function onProgress(
  stream: OllamaStream<ProgressResponse, ProgressStreamResult>,
  callback: ProgressCallback,
): Promise<ProgressStreamResult> {
  // Attach a no-op catch handler to the finalResult promise so that
  // when the iterator's catch block rejects it (on in-band error or
  // abnormal termination), Node doesn't log an "unhandled rejection"
  // warning. The actual error is surfaced via the throw below — we
  // just need to prevent the unawaited finalResult from being marked
  // unhandled.
  void stream.finalResult.catch(() => undefined);

  for await (const event of stream) {
    if (event.type === 'message') {
      callback(toPullProgressEvent(event.data.chunk));
    }
    if (event.type === 'done') {
      return event.data.result;
    }
    if (event.type === 'error') {
      throw event.data.error;
    }
  }
  // The stream ended without emitting `done` — this is an abnormal
  // termination. Surface it as an OllamaStreamError so callers can
  // branch on it consistently with in-band errors.
  throw new OllamaStreamError('Pull/push stream ended before reporting success');
}
