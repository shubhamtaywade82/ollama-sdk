/**
 * Batch-constrained embedding generation for high-volume ingestion pipelines.
 *
 * Ollama's `/api/embed` accepts an array of inputs, but two independent limits
 * make naive usage fragile at corpus scale:
 *
 * 1. **Concurrency.** `Promise.all(inputs.map(...))` fires every request at
 *    once; against a local Ollama daemon this contends sockets, saturates the
 *    request queue (`OLLAMA_MAX_QUEUE`, surfacing as 503 `overloaded`), and —
 *    worst case — exhausts GPU VRAM as the model instance serves N prompts
 *    simultaneously.
 * 2. **Context window.** Ollama truncates any input string longer than the
 *    model's context window (`num_ctx`) *silently* unless `truncate: false` is
 *    set — degraded vectors with no error, no warning, nothing on the wire.
 *
 * {@link batchEmbed} addresses the first with a fixed-size worker pool over
 * `client.embed()` (so every batch still rides the client's full pipeline:
 * failover, retry, auth, logging, telemetry). The client-level
 * `embedBatch()` wrapper addresses the second with a pre-flight per-string
 * token estimate against the resolved `num_ctx` window (see
 * {@link findOversizedEmbedInputs}).
 *
 * Semantics:
 * - **Order-preserving** — result index `i` is always the embedding of
 *   `input[i]`, regardless of which batch completed first.
 * - **Fail-fast** — the first batch error aborts every sibling in-flight
 *   batch (surfaces the *original* error, not the derived aborts) and rejects
 *   the whole operation. Vector indexing that half-succeeds is a corrupted
 *   index; callers re-running an ingestion prefer all-or-nothing.
 * - **Abortable** — the caller's `signal` cancels queued and in-flight batches
 *   alike and rejects with `code: 'aborted'`.
 */

import { estimateTokens } from './context-safety.js';
import { OllamaAbortError, OllamaClientError } from './errors.js';
import type { ModelOptions } from './types.js';
import type { EmbedRequestOptions, EmbedResponse } from './types.js';
import type { OllamaClient } from './client.js';

/**
 * Default number of input strings per `/api/embed` request. 32 keeps a single
 * request's prompt comfortably inside typical embedding-model context windows
 * (2048+) while amortizing HTTP overhead across the corpus.
 */
export const DEFAULT_EMBED_BATCH_SIZE = 32;

/**
 * Default number of batches kept in flight concurrently. 3 is deliberately
 * conservative: a local Ollama daemon serves one model instance per GPU, so
 * 3 concurrent embedding prompts bound queue depth and VRAM pressure without
 * leaving the hardware idle between batches. Raise for multi-endpoint
 * clients or remote daemons; lower (to 1) for constrained devices.
 */
export const DEFAULT_EMBED_CONCURRENCY = 3;

export interface EmbedBatchOptions {
  /** Model to embed with (e.g. `'nomic-embed-text:latest'`). */
  readonly model: string;
  /** Input strings, in corpus order. Result index `i` matches `input[i]`. */
  readonly input: readonly string[];
  /**
   * Inputs per `/api/embed` request. Default {@link DEFAULT_EMBED_BATCH_SIZE}
   * (32). Must be a positive integer.
   */
  readonly batchSize?: number | undefined;
  /**
   * Batches kept in flight simultaneously. Default
   * {@link DEFAULT_EMBED_CONCURRENCY} (3). Must be a positive integer.
   */
  readonly concurrency?: number | undefined;
  /** Passed through to each batch request — `false` makes oversized inputs
   * a server-side error instead of a silent truncation. */
  readonly truncate?: boolean | undefined;
  /** Passed through to each batch request (dimensionality truncation). */
  readonly dimensions?: number | undefined;
  /** Passed through to each batch request (model unload policy). */
  readonly keep_alive?: string | number | undefined;
  /** Ollama model options (`num_ctx`, …) passed through to each batch request. */
  readonly options?: ModelOptions | undefined;
  /** Aborts the whole batch operation — queued and in-flight alike. */
  readonly signal?: AbortSignal | undefined;
  /** Per-request timeout applied to each individual batch request. */
  readonly timeoutMs?: number | undefined;
  /**
   * Progress callback invoked after each successfully embedded batch as
   * `onBatchComplete(completedBatches, totalBatches)`. Never called after the
   * operation rejects.
   */
  readonly onBatchComplete?: ((completedBatches: number, totalBatches: number) => void) | undefined;
}

export interface EmbedBatchResult {
  readonly model: string;
  /**
   * Embeddings in input order — `embeddings[i]` corresponds to
   * `options.input[i]`, independent of batch completion order.
   */
  readonly embeddings: readonly (readonly number[])[];
  /** Number of `/api/embed` requests the corpus was split into. */
  readonly batchCount: number;
}

/** An input string whose estimated token count exceeds the context window. */
export interface OversizedEmbedInput {
  /** Index into the input array. */
  readonly index: number;
  /** Estimated token count for `input[index]`. */
  readonly estimate: number;
}

/**
 * Finds input strings whose heuristic token estimate exceeds `contextLength`
 * (typically the resolved `num_ctx`). Unlike chat/generate pre-flight there is
 * no warning margin and no output-token headroom: an embedding request's
 * prompt IS the whole input, so the exact window is the trip point, and
 * crossing it means silent truncation (or, with `truncate: false`, a
 * server-side rejection).
 */
export function findOversizedEmbedInputs(
  input: readonly string[],
  contextLength: number,
): OversizedEmbedInput[] {
  const oversized: OversizedEmbedInput[] = [];
  for (let index = 0; index < input.length; index++) {
    const text = input[index];
    if (text === undefined) continue;
    const estimate = estimateTokens(text);
    if (estimate > contextLength) {
      oversized.push({ index, estimate });
    }
  }
  return oversized;
}

/**
 * Builds the warn/throw message for oversized embed inputs (mirrors
 * `contextWarningMessage` for chat/generate).
 */
export function embedBatchOverflowMessage(
  oversized: readonly OversizedEmbedInput[],
  totalInputs: number,
  contextLength: number,
  truncateFalse: boolean,
): string {
  const shown = oversized.slice(0, 5).map((entry) => `#${entry.index} (~${entry.estimate} tokens)`);
  const elided = oversized.length > 5 ? `, +${oversized.length - 5} more` : '';
  const outcome = truncateFalse
    ? 'the server will reject them (`truncate: false`)'
    : 'Ollama will silently truncate them, producing degraded vectors';
  return (
    `embedBatch: ${oversized.length} of ${totalInputs} input strings exceed the ` +
    `${contextLength}-token context window (${shown.join(', ')}${elided}). ` +
    `${outcome}. Raise \`options.num_ctx\`, pre-split long inputs, or set ` +
    `\`truncate: true\` explicitly to acknowledge truncation.`
  );
}

function assertPositiveInteger(value: number, field: 'batchSize' | 'concurrency'): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new OllamaClientError(
      `embedBatch: \`${field}\` must be a positive integer (got ${value}).`,
      { code: 'invalid_request' },
    );
  }
}

/**
 * Splits `input` into `batchSize` slices and embeds them through `client.embed()`
 * with at most `concurrency` batches in flight. Order-preserving and fail-fast —
 * see the module doc for the full semantics.
 *
 * Prefer the {@link OllamaClient.embedBatch} wrapper, which additionally
 * injects `defaultContextLength` as `num_ctx` and enforces the client's
 * `onContextOverflow` policy against per-string estimates before any request
 * is sent.
 */
export async function batchEmbed(
  client: OllamaClient,
  options: EmbedBatchOptions,
): Promise<EmbedBatchResult> {
  const { model, input } = options;
  const batchSize = options.batchSize ?? DEFAULT_EMBED_BATCH_SIZE;
  const concurrency = options.concurrency ?? DEFAULT_EMBED_CONCURRENCY;
  assertPositiveInteger(batchSize, 'batchSize');
  assertPositiveInteger(concurrency, 'concurrency');

  if (input.length === 0) {
    return { model, embeddings: [], batchCount: 0 };
  }

  // Partition in corpus order — result index math below depends on it.
  const batches: string[][] = [];
  for (let start = 0; start < input.length; start += batchSize) {
    batches.push(input.slice(start, start + batchSize) as string[]);
  }

  const embeddings: (readonly number[] | undefined)[] = new Array(input.length);

  // Internal controller: aborted by the caller's `signal` OR by the first
  // batch failure. Every in-flight `client.embed()` receives it, so a single
  // failure (or caller abort) cancels siblings immediately instead of letting
  // them finish — fail-fast, not fail-slow.
  const controller = new AbortController();
  const propagateExternalAbort = (): void => {
    controller.abort(options.signal?.reason);
  };
  if (options.signal) {
    if (options.signal.aborted) {
      propagateExternalAbort();
    } else {
      options.signal.addEventListener('abort', propagateExternalAbort, { once: true });
    }
  }

  let nextBatch = 0;
  let completedBatches = 0;
  /** The first failure, rethrown by every sibling worker so the caller always
   *  sees the root cause rather than a cascade of derived `AbortError`s. */
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted) {
        throw failure?.error ?? new OllamaAbortError('Embed batch aborted');
      }
      const batchIndex = nextBatch;
      nextBatch++;
      if (batchIndex >= batches.length) return;
      const batch = batches[batchIndex];
      if (!batch) return;

      try {
        const request: EmbedRequestOptions = {
          model,
          input: batch,
          ...(options.truncate !== undefined ? { truncate: options.truncate } : {}),
          ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {}),
          ...(options.keep_alive !== undefined ? { keep_alive: options.keep_alive } : {}),
          ...(options.options !== undefined ? { options: options.options } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          signal: controller.signal,
        };
        const response: EmbedResponse = await client.embed(request);

        if (response.embeddings.length !== batch.length) {
          throw new OllamaClientError(
            `embedBatch: server returned ${response.embeddings.length} embeddings for a ` +
              `batch of ${batch.length} inputs (batch ${batchIndex}).`,
            { code: 'invalid_response' },
          );
        }
        const offset = batchIndex * batchSize;
        for (let j = 0; j < batch.length; j++) {
          embeddings[offset + j] = response.embeddings[j];
        }
        completedBatches++;
        options.onBatchComplete?.(completedBatches, batches.length);
      } catch (error) {
        if (!failure) {
          failure = { error };
          controller.abort(error);
          throw error;
        }
        // A sibling already failed and aborted us — surface ITS error so the
        // caller diagnoses the root cause, not the derived cancellation.
        throw failure.error;
      }
    }
  };

  try {
    const workerCount = Math.min(concurrency, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', propagateExternalAbort);
    }
  }

  // Defensive completeness check — every index must have been written by the
  // batch that owned it (Promise.all resolving implies every batch resolved).
  for (let i = 0; i < embeddings.length; i++) {
    if (embeddings[i] === undefined) {
      throw new OllamaClientError(
        `embedBatch: internal invariant violated — no embedding produced for input #${i}.`,
        { code: 'invalid_response' },
      );
    }
  }

  return {
    model,
    embeddings: embeddings as readonly (readonly number[])[],
    batchCount: batches.length,
  };
}
