/**
 * Zero-copy stream observation — the safe alternative to `ReadableStream.tee()`
 * for multi-sink consumption (audit logging, token counting, telemetry taps).
 *
 * ## The `tee()` hazard this exists for
 *
 * Developers streaming to a UI while also feeding a logger (or a token
 * counter, or an OpenTelemetry exporter) typically reach for:
 *
 * ```ts
 * // VULNERABLE PATTERN — do not do this
 * const [forUi, forLogger] = response.body.tee();
 * ```
 *
 * WHATWG `tee()` branches share a single upstream pull mechanism: a branch
 * that reads slower than its sibling forces every intermediate chunk to be
 * retained in that branch's internal queue until it catches up. If the slow
 * consumer is a logger waiting on a database write — or never drains at all —
 * the queue grows without bound, and because both branches apply shared
 * backpressure, the *fast* consumer is throttled by the slowest one. In a
 * long-lived streaming server this is a slow, silent heap leak.
 *
 * ## What `observeStream` does instead
 *
 * A single-pass wrapper: chunks flow from the source through the observer
 * callbacks to the primary consumer with **no second queue and no forked
 * stream**. The contract is deliberately one-sided in favor of the primary
 * consumer:
 *
 *   - **Never blocks.** Observer callbacks run on a serialized microtask
 *     chain, not on the hot path. A slow async observer (a logger waiting on
 *     I/O) delays only its own tail — the primary consumer keeps receiving
 *     chunks at source speed.
 *   - **Never fails.** An observer that throws (sync) or rejects (async) is
 *     routed to `onListenerError` and otherwise discarded. Observer failures
 *     can never poison the primary pipeline.
 *   - **Never leaks via the wrapper.** There is no second branch to
 *     backpressure. The only retained state is one closure per backlogged
 *     observer callback; if your observer can stall *forever*, bound it on
 *     your side (queue, drop policy) — the wrapper will keep enqueueing
 *     otherwise, exactly like any fire-and-forget log sink.
 *   - **Ordered.** Observer callbacks run strictly FIFO, one at a time —
 *     async sinks see chunks in stream order, and `onDone` is enqueued only
 *     after the last chunk's callback settles. (This is intentionally
 *     stricter than a naive `void onChunk(chunk)` fire-and-forget, which
 *     runs concurrent, out-of-order observers and turns a rejected async
 *     callback into an unhandled rejection.)
 *
 * ## Lifecycle
 *
 *   - Source completes naturally → `onDone` (enqueued after the last chunk
 *     callback settles, so a logger has flushed everything it saw).
 *   - Source throws → `onError(err)` immediately, then the error re-throws to
 *     the primary consumer (the observer is transparent, not a circuit
 *     breaker).
 *   - Primary consumer stops early (`break` / `return` / `throw` inside the
 *     `for await` loop) → `onAbandon()` immediately. This is distinct from
 *     completion: the source's iterator-`return()` has already closed the
 *     underlying transport by the time `onAbandon` fires.
 *
 * Works over any `AsyncIterable<T>` — the SDK's `OllamaStream` (streaming
 * `chat`/`generate`), the raw NDJSON chunk iterables, or your own sources.
 * Note that `OllamaStream` itself is dual-mode but mode-exclusive (`.on()`
 * listeners cannot be combined with `for await`); `observeStream` is the
 * supported way to tap a stream you are already iterating.
 */

/**
 * Lifecycle phase an observer failure came from. `'chunk'` and `'done'`
 * failures arrive from the serialized callback chain; `'error'` and
 * `'abandon'` failures come from those terminal hooks themselves.
 */
export type StreamObserverPhase = 'chunk' | 'done' | 'error' | 'abandoned';

/** Passive, best-effort observer hooks — see the module docs for semantics. */
export interface StreamObserverCallbacks<T> {
  /**
   * Called once per chunk, in stream order, FIFO, never overlapping with a
   * previous still-running call. May be sync (`void`) or async
   * (`Promise<void>`); async return values are awaited *on the observer
   * chain only* — they never delay the primary consumer. Rejections (and
   * sync throws) route to {@link StreamObserverCallbacks.onListenerError}.
   */
  onChunk?: ((chunk: T) => void | Promise<void>) | undefined;
  /**
   * Called with the source's error immediately before that error is re-thrown
   * to the primary consumer. A throwing `onError` hook cannot mask the
   * original error — it is reported via {@link StreamObserverCallbacks.onListenerError}
   * and the original error still propagates.
   */
  onError?: ((error: unknown) => void) | undefined;
  /**
   * Called when the source completes naturally — enqueued after the last
   * chunk's observer callback settles, so a flushed logger has seen every
   * chunk before its "done" marker.
   */
  onDone?: (() => void | Promise<void>) | undefined;
  /**
   * Called when the primary consumer stops early (`break`/`return`/`throw` in
   * the consuming loop). The source has already been closed via the
   * iterator-`return()` protocol when this fires. `onDone` does not fire in
   * this case.
   */
  onAbandon?: (() => void) | undefined;
  /**
   * The observation failure channel: any observer hook that throws or rejects
   * is reported here together with the phase it came from, and then
   * discarded. If this hook itself throws, the failure is swallowed — an
   * error reporter must never become the next unhandled rejection.
   */
  onListenerError?: ((error: unknown, phase: StreamObserverPhase) => void) | undefined;
}

/**
 * Wraps an `AsyncIterable` with passive observer hooks without creating a
 * secondary buffered stream queue — avoiding the memory retention and shared
 * backpressure penalties of `ReadableStream.tee()`.
 *
 * @example
 * ```ts
 * const stream = await client.chat({ model: 'llama4', messages, stream: true });
 * let tokens = 0;
 * const observed = observeStream(stream, {
 *   onChunk: (event) => {
 *     if (event.type === 'token') tokens += 1;
 *     auditLog.write(event); // slow async sink — never delays the consumer
 *   },
 *   onDone: () => auditLog.flush(),
 *   onListenerError: (err) => telemetry.count('audit_log_failure', err),
 * });
 * for await (const event of observed) {
 *   ui.render(event); // primary consumer — full speed, full order
 * }
 * ```
 */
export async function* observeStream<T>(
  source: AsyncIterable<T>,
  callbacks: StreamObserverCallbacks<T> = {},
): AsyncGenerator<T, void, unknown> {
  const { onChunk, onError, onDone, onAbandon, onListenerError } = callbacks;

  /** Reports a failing observer hook without ever throwing ourselves. */
  const reportListenerFailure = (error: unknown, phase: StreamObserverPhase): void => {
    try {
      onListenerError?.(error, phase);
    } catch {
      // The error reporter itself failed — nothing further we can safely do.
    }
  };

  // Serialized observer chain: every queued callback runs FIFO, one at a
  // time, on microtasks. Sync observers pay one hop; async observers queue
  // behind each other (bounded concurrency of exactly one); failures are
  // routed to `onListenerError` instead of surfacing as unhandled
  // rejections. The chain is never awaited on the primary path.
  let observerChain: Promise<void> = Promise.resolve();
  const dispatch = (phase: StreamObserverPhase, task: () => void | Promise<void>): void => {
    observerChain = observerChain.then(task).then(
      () => undefined,
      (error: unknown) => {
        reportListenerFailure(error, phase);
      },
    );
  };

  // 'running' while the source is being consumed; flipped to a terminal
  // state before the natural/error paths complete so the `finally` block can
  // distinguish "consumer walked away" (the only case that still reads
  // 'running' there) from completion and failure.
  let state: 'running' | 'done' | 'error' | 'abandoned' = 'running';
  try {
    for await (const chunk of source) {
      if (onChunk !== undefined) {
        dispatch('chunk', () => onChunk(chunk));
      }
      yield chunk;
    }
    state = 'done';
    if (onDone !== undefined) {
      // Enqueued after the last chunk callback has settled (FIFO chain), so
      // sinks observe their "done" marker only after every chunk was handed
      // over — even when the last async sink was still draining.
      dispatch('done', () => onDone());
    }
  } catch (error) {
    state = 'error';
    // Terminal hooks fire immediately rather than joining the chain: the
    // source has stopped, so there is nothing left to stay ordered with, and
    // error surfacing should not wait behind a slow logger.
    try {
      onError?.(error);
    } catch (listenerError) {
      reportListenerFailure(listenerError, 'error');
    }
    throw error;
  } finally {
    if (state === 'running') {
      // The only way to land here still 'running' is an early exit at the
      // `yield` (break/return/throw in the consuming loop): the for-await's
      // iterator-close protocol has already called `source.return()` and
      // awaited it, so the transport is closed by the time this fires.
      state = 'abandoned';
      try {
        onAbandon?.();
      } catch (listenerError) {
        reportListenerFailure(listenerError, 'abandoned');
      }
    }
  }
}
