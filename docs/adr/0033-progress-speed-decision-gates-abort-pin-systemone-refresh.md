# ADR 0033: Progress speed tracking, decision confidence gates, abort-safety pin, System One contract refresh

**Status**: Accepted
**Date**: 2026-10-15
**Context**: October 15 digest — "Structured Output Type Inference (TYP-04), Stream Cancellation Memory Barriers (STR-03), Model Pull/Push Progress Multiplexing (OPR-01)" + morning upstream-specs digest (System One confidence calibration, zero-truncation 413 rule)

## Context

The audit digest's three findings and the companion upstream-specs digest's System One
claims were each audited against the codebase before any implementation, per house
discipline. Two were stale, one was a real packaging gap, and the upstream-specs
digest mixed a fabricated specification with one genuinely useful idea — while its
"OpenAPI Parity Inspection" focus item, taken seriously, surfaced a real contract
drift: upstream tightened System One score criteria from 2–26 to 2–10 levels between
the 2026-10-11 pin and today.

## Findings & verdicts

1. **TYP-04 (P2): "Missing generic inference for structured output formats"** —
   **stale.** `chatWithSchema<T>()` / `generateWithSchema<T>()` already provide
   exactly this: full Zod type inference (`schema: z.ZodType<T>` → `Promise<T>`),
   validation on the parsed payload (`OllamaToolValidationError` with Zod issues),
   and resilient JSON extraction from markdown-fenced model output. All three pieces
   (`zodToJsonSchema`, `parseStructuredOutput`, `SupportedSchema`) are root-exported
   and README-documented. The digest's proposed redesign — a `structured?: T` field
   injected into `TypedChatMessage` — is declined twice over: its own sketch uses a
   blind `JSON.parse(...) as T` (no runtime validation, precisely the unsafety the
   finding complains about), and injecting SDK-computed fields into the wire-contract
   response types would break the contract-parity discipline (`ChatResponse` mirrors
   the server shape; SDK conveniences live at the method layer, like `chatText`).

2. **STR-03 (P1): "Unhandled rejection when stream aborted during in-flight
   microtask"** — **stale as a defect; pinned as an invariant.** Every seam the
   digest describes is already guarded: `requestStream` wires the caller signal to
   an `AbortController` and removes its listener in the generator's `finally`;
   `parseNdjsonStream` runs under `await using disposableReader` (whose
   `reader.cancel()` rejections are swallowed and whose lock is released);
   `OllamaStream.abort()` cancels the source _then_ rejects `finalResult`; and —
   the load-bearing piece — `executeWithFailover` attaches
   `holdUntil(stream) → void promise.catch(() => undefined)` to every client-produced
   stream's `finalResult` synchronously, before the stream is returned, so the
   internally-held promise can never surface as a process-level `unhandledRejection`.
   The digest's `guardedStreamReader` sketch re-implements this stack with weaker
   structure (per-call readers instead of `await using`, manual flag booleans).
   The real residual gap — no test pins the invariant — is closed BUF-01-style:
   `test/stream-abort-mid-read.test.ts` aborts a real wire stream with the next
   frame genuinely in flight (mock server, 50 ms chunk delays) in both iterator and
   events mode, and asserts the mapped `OllamaAbortError` delivery, zero
   process-level `unhandledRejection` events, and endpoint-slot release (plus a
   follow-up request on a `maxConcurrentPerEndpoint: 1` client proving the slot
   freed).

3. **OPR-01 (P2): "Unstructured layer-progress reporting during model pull/push"** —
   **partially stale; the residual is real.** `onProgress()`, `PullProgressEvent`
   (with a pre-computed, clamped, 2-decimal `percent`), `computeProgressPercent()`,
   and `toPullProgressEvent()` existed in `src/streaming/progress.ts` with 13 tests —
   but none of it was exported from the root `src/index.ts`, so npm consumers could
   not reach any of it (the v1.15.0 packaging pattern: capable engine, sealed hatch).
   The digest's "transfer speed" ask had no implementation. Both are closed: root
   exports for the four functions + three types, and a new
   `createProgressSpeedTracker()` — the stateful byte counter the digest correctly
   said consumers were being forced to hand-roll — wired into `onProgress` so every
   callback event now carries `bytesPerSecond` and `etaSeconds`.

   Design choices for the tracker:
   - **Cumulative average, not instantaneous.** Speed is measured from the layer's
     first byte-bearing frame. Frame-to-frame rates jitter wildly (network bursts,
     server-side buffering) and make progress bars twitch; a since-start average is
     what CLIs render.
   - **Per-layer epochs.** A pull transfers several layers; `completed` restarts
     near zero when the next layer begins. The tracker resets whenever `digest`
     changes or `completed` regresses, so speed never averages across layers — the
     most common bug in hand-rolled counters.
   - **`performance.now()`, not `Date.now()`.** Monotonic, immune to wall-clock
     adjustments (NTP steps, laptop sleep).
   - **The pure wrapper stays pure.** `toPullProgressEvent` never measures time;
     only `onProgress` (and consumer-side tracker use) attach speed. Deterministic
     tests mock `performance.now()`; the pure path needs no clock.
   - Declined: a `client.pullWithProgress()` method or progress "multiplexer"
     object. The stream already _is_ the multiplexed channel (typed dual-mode
     `OllamaStream`); a callback helper over it composes without forking the
     request path (same promote-don't-fork rule as ADR 0030's benchmark verdict).

4. **Upstream-specs digest (System One "confidence calibration" + "zero-truncation
   413 rule")** — **specification fabricated; kernel adopted.** The claimed rules —
   HTTP 413 for requests exceeding the _context window_, a two-token
   scoring-head reservation, an `input + 2 ≤ context length` invariant, and a
   `{value, score, confidence}` answer shape — appear nowhere in the official
   decision capability docs or the OpenAPI spec. The real 413 on `/v1/systemone`
   is the _request-byte_ cap (64 KiB without images, 32 MiB with), which the SDK
   has enforced client-side since the System One waves
   (`MAX_SYSTEM_ONE_REQUEST_BYTES` / `MAX_SYSTEM_ONE_IMAGES_BYTES` +
   `estimateSystemOneRequestBytes`). Declined: the proposed
   `ContextBudgetGuard` token estimator (a pre-flight guard against a spec that
   does not exist — inventing an estimation formula for undocumented server
   behavior would produce false confidence in both directions) and the
   `SystemOneDecisionHelper.evaluateDecisions` wrapper class (zero config, wraps
   one map iteration). Adopted: the kernel — **opt-in confidence gates on the six
   existing decision helpers**. `choice`/`score`/`route`/`rank` accept
   `minConfidence` (inclusive lower bound in (0, 1], `RangeError` otherwise,
   validated before any request is sent) and flag results with
   `isConfident: confidence >= minConfidence`; `noul`/`verify` accept
   `minProbability` which raises the bar their derived boolean must clear
   (default 0.5 unchanged). The distinction is deliberate: choice/score answers
   carry a separate `confidence` field, noul answers carry only the probability of
   true — so for noul the threshold _is_ the boolean bar, and a redundant
   `isConfident` would always equal `bool`. Gates are opt-in so every existing
   caller's behavior is byte-identical.

5. **Contract refresh (the one honest catch in the morning digest).** The
   "OpenAPI Parity Inspection" focus item was taken literally: the live upstream
   `docs/openapi.yaml` now natively carries the System One schemas (the pin
   previously hand-assembled them from rendered docs), and it tightens **score
   criteria to `maxItems: 10`** (answer `maximum: 9`), drops the noul criteria's
   hardcoded `'Yes'`/`'No'` defaults ("omitted entries use model-specific
   defaults"), and simplifies the model/images descriptions. The pin
   (`contracts/sources/ollama.openapi.yaml`) was hand-edited in its cleaned style
   and the contract regenerated: `SystemOneScoreQuestion` / `SystemOneScoreAnswer`
   models, their Zod schemas (`score: z.number().min(0).max(9)`), the IR, and the
   MCP tool descriptors. Boundary tests updated (11-criteria reject; 10-criteria
   accept). Note: `npm run contract:fetch` was **not** used — it writes the raw
   upstream body verbatim and would clobber the pin's documented intentional
   deviations (repaired enum literals, `families: [array, null]`); hand-curation
   is the established refresh path for this file.

## Consequences

- Progress speed/ETA is now a public, tested surface with defined reset semantics;
  any future progress-bearing endpoint (e.g. `/api/create` streams) can reuse the
  tracker unchanged.
- The abort-safety story is pinned by tests, so refactors of the stream teardown
  path (or of `holdUntil`) fail CI if they reintroduce unhandled rejections.
- Decision gates give autonomous flows a one-parameter guard against
  barely-majority actions without changing any default behavior.
- The SDK now enforces the tightened 2–10 score-criteria limit client-side;
  servers that still accept 26-level rubrics will be rejected by request
  validation before the round-trip — correct per contract-first discipline, and
  the boundary tests document the upstream change date.
