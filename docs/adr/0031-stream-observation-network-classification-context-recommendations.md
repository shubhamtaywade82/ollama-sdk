# ADR 0031: Stream observation, network-error classification, context-window recommendations

**Status**: Accepted
**Date**: 2026-10-13
**Context**: October 13 digest (second) — "Stream Multi-Sink Teeing, Context Window Overflow, Socket Hangup Recovery"

## Context

The digest's header framed three prior items as implemented upstream (IPC-01
Unix-socket dispatch, OBS-01 TTFT telemetry, CON-02 concurrency rate
limiting). None of that history exists in this repo — IPC-01/OBS-01 were
never on its roadmap, and CON-02's substance already ships as
`EndpointRegistry`'s `maxConcurrentPerEndpoint` + `'least-connections'` +
`waitForCapacity`. The findings matrix itself contained three claims, each
audited against `main` before any implementation:

1. **MEM-02 (P1): "Unbounded buffering in naive stream.tee() usage"** —
   **real, but narrower than the digest's framing.** Nothing in `src/`
   observes streams (`tee`/`observeStream`/`onChunk`: zero hits), and
   `OllamaStream` is dual-mode _exclusive_ — `.on()` throws once async
   iteration starts and vice versa — so "yield to the UI while feeding a
   logger" has no supported path at all. The digest's sketch had three
   defects of its own: `void callbacks.onChunk(chunk)` turns a rejecting
   async callback into an unhandled rejection; there is no lifecycle hook
   for a consumer that breaks early; and fire-and-forget async observers run
   concurrent and out of order (the digest's own stated hazard, restated as
   an API).
2. **CTX-02 (P2): "Silent prefix truncation on num_ctx overflow … add an
   optional client-side token count estimator"** — **stale, comprehensively.**
   `src/context-safety.ts` (commit `54ea517`, v1.9.0-era) already ships a
   strictly superior estimator: CJK-aware `estimateTokens` (~1 token per CJK
   char, ~4 chars/token — the digest's flat `length / 4` miscounts CJK by
   ~4×), per-message framing overhead, tool-schema and image budgets,
   three-tier window resolution (`request num_ctx` → client
   `defaultContextLength` → conservative server fallback _without_ margin,
   to avoid false positives), `chat()`/`generate()` pre-flight with
   `onContextOverflow: 'warn' | 'throw'`, and
   `client.models.getContextLength()`'s four-tier server-side discovery.
   The one nugget the digest had that the repo didn't: a _concrete_
   recommended window in the check result.
3. **NET-03 (P1): "Stale persistent socket re-use causes transient
   ECONNRESET … implement automatic one-time retry for idempotent GET/HEAD
   calls"** — **inverted on the headline; real in a narrow seam.** Every
   SDK-routed operation already runs inside `executeWithFailover` →
   `withRetry` (default 3 retries, jittered backoff, `config.retries`
   tunable), and `mapError` classifies fetch's `TypeError` rejections as
   retryable `OllamaNetworkError` — which is in `DEFAULT_FAILOVER_CODES`.
   Idempotent calls (`list`, `show`, `ps`, `version`, `ping`) already
   auto-retry _and_ fail over; the digest asked for one retry where the SDK
   gives three plus failover. The real gap: classification was
   `TypeError`-only, so a socket error that carries a `code` but not the
   `TypeError` shape — exactly what a custom `fetch` built on `node:http`
   rejects with (`Error` + `code: 'ECONNRESET'`), and what nested undici
   `cause` chains hold (`UND_ERR_SOCKET`) — fell through to
   `OllamaGenericClientError`: not retryable, not failover-eligible.

## Decision

### 1. `observeStream` — root-exported, serialized-chain semantics

Shipped `src/streaming/observe.ts`: `observeStream<T>(source, callbacks)`
returning an `AsyncGenerator<T>` with `onChunk` / `onError` / `onDone` /
`onAbandon` / `onListenerError`. Deviations from the digest's sketch, all
fixing its own defects:

- **Serialized microtask chain instead of `void onChunk(chunk)`.** Observer
  callbacks run FIFO with concurrency of exactly one, off the hot path.
  Sync observers pay one microtask hop; async observers queue behind each
  other — a slow logger throttles only its own tail, never the primary
  consumer. A rejecting observer routes to `onListenerError(phase)` and is
  discarded; a failing `onListenerError` is swallowed (an error reporter
  must never become the next unhandled rejection). This makes the FIFO
  guarantee testable (`maxActive === 1`, order preserved under
  adversarial deferred resolution) instead of best-effort.
- **`onDone` enqueued after the last chunk's observer settles** — a logger
  sees every chunk before its "done" marker, even when its last write was
  still draining.
- **`onAbandon` for early consumer exit.** The only way to land in the
  `finally` still `running` is a `break`/`return`/`throw` at the `yield`;
  by then the for-await iterator-close protocol has already closed the
  source (asserted in tests). Distinct from `onDone` (natural completion)
  and `onError` (source failure, rethrown — the observer is transparent,
  not a circuit breaker).
- **Root export, not a `./stream` subpath.** The digest's checklist asked
  for `@nemesis-oss/ollama-sdk/stream`; the streaming toolkit
  (`OllamaStream`, adapters, `toResponse`, …) has always lived on the root
  entry, and subpaths are reserved for distinct runtimes/concerns
  (`./testing`, `./mcp/*`, `./generated/*`). One function does not justify
  fragmenting the surface — same reasoning as ADR 0030's decline of a
  `client.benchmark` namespace.

Documented non-goal: the wrapper does not bound a sink that _never_
settles — that state is one closure per backlogged callback, identical in
kind to any fire-and-forget log sink; bounding it is the sink's job
(queue, drop policy). `tee()`'s hazard was _shared backpressure_ delaying
the primary consumer plus double-buffering the stream; both are
structurally absent here.

### 2. `recommendedNumCtx` — the one nugget worth taking from a stale claim

`ContextCheck` gains an optional `recommendedNumCtx`, present exactly when
`exceedsThreshold` is true, computed by the new exported
`recommendContextWindow(estimatedTokens)`: the smallest power-of-two window
covering `estimate × 1.3`, floored at 4096. `contextWarningMessage` now
appends the concrete number **with the native-ceiling caveat** — verify via
`client.models.getContextLength()` before adopting it — because a
recommendation that ignores the model's native maximum invites a different
failure (a window the GGUF can't honor). Implementation uses an exact
doubling loop, not the digest's `Math.pow(2, Math.ceil(Math.log2(x)))`:
float `log2` of exact powers of two can land marginally above the integer,
which rounds a perfect fit up a whole power of two. Non-finite and
non-positive inputs degrade to the 4096 floor rather than throwing — the
function is advisory, invoked after the caller's own estimate already
flagged a problem.

### 3. `mapError` network classification — structural, not string matching

`mapError` now classifies, ahead of the `TypeError` branch, any error whose
`code` — or a `code` nested in its `cause` chain (bounded at depth 4, so
cause cycles can't spin) — is in the new exported `NETWORK_ERROR_CODES`:
the stale-socket family (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`,
`UND_ERR_CLOSED`), never-established connections (`ECONNREFUSED`,
`EAI_AGAIN`, `ENOTFOUND`), and dispatcher timeouts
(`UND_ERR_CONNECT_TIMEOUT`/`UND_ERR_HEADERS_TIMEOUT`/`UND_ERR_BODY_TIMEOUT`).
Result: `OllamaNetworkError` — retryable _and_ failover-eligible, closing
the custom-`fetch`-impl seam where a raw `ECONNRESET` previously died as a
non-retryable generic error on its first attempt.

- **Structural over the digest's `String(err).includes(...)`:** message
  wording is not a contract across undici/Node versions; `error.code` is.
  (The predicate is exported as `isNetworkLevelError` for consumers.)
- **`UND_ERR_ABORTED` deliberately excluded:** it is undici's
  caller-initiated abort shape; classifying it as network would re-dispatch
  requests the user explicitly cancelled.
- **Non-transport codes (`EACCES`, …) deliberately stay non-retryable:**
  retrying a permission error just burns attempts.
- **"Pre-flight health validation on stale sockets" declined:** undici owns
  the connection pool and exposes no staleness introspection; a pre-flight
  probe would double the request count on the happy path to detect a
  condition whose cheapest detector is the failed request itself.
  `client.ping()` remains the manual pre-flight for callers who want one.
- **No per-method idempotency gating change:** the digest's
  `executeWithSocketRecovery(action, isIdempotent)` sketch retried _less_
  than current behavior (one retry, idempotent-only). The existing retry
  window is the pre-response phase — in the daemon-restart scenario the
  server lost the work anyway, so re-dispatch doesn't double-charge, and
  mid-stream failures (post-headers) are never retried because partial
  generation can't be replayed. Tightening to idempotent-only would trade
  real restart-resilience for a theoretical double-dispatch the transport
  can't distinguish anyway; users with stronger requirements already have
  `config.retries` / `shouldRetry` per client.

## Testing

35 new tests: `test/stream-observe.test.ts` (15 — passthrough identity,
sync/async observer ordering with adversarial deferred resolution,
`maxActive === 1`, unhandled-rejection guards via `process` listeners,
observer-throw isolation, `onError` transparency, `onAbandon` after source
closure, `onDone` gated on the last sink, never-blocks-primary with a
never-resolving sink, and a full daemonless round trip over a streaming
`client.chat()` through the public mock server with single-dispatch
assertion); `test/stale-socket-recovery.test.ts` (6 — a real `node:http`
server that kills the socket on first request per path:
`list()`/`ps()` recover via re-dispatch; injected `fetch` rejecting with
raw `code: 'ECONNRESET'` retries exactly once; cause-chain
`UND_ERR_SOCKET` classification; `EACCES` stays single-attempt; exhausted
retries surface as `OllamaNetworkError`); `test/errors.test.ts` (+8 —
classification matrix, abort exclusion, cause-depth bound, cycle safety);
`test/context-safety.test.ts` (+6 — recommendation math incl. the 4096
floor and power-of-two sweep, `recommendedNumCtx` presence across all
three window sources, warning-text assertions). Full suite: 104 files,
1012 passed + 14 skipped, zero regressions.
