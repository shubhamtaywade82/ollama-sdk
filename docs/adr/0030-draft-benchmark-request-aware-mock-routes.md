# ADR 0030: Draft benchmark utility & request-aware mock routes

**Status**: Accepted
**Date**: 2026-10-13
**Context**: October 13 digest — "Speculative Performance & Telemetry Observations"

## Context

The digest made three claims, audited against the codebase before any
implementation:

1. **"Developers manually calculate nanosecond ratios across runs"
   (speculative benchmarking)** — **partially stale**. `formatTelemetry`
   (v1.12.0) already derives `tokensPerSecond` from the raw counters using
   the official Usage-doc formula, and `lab/15-speculative-draft` implements
   the digest's full deterministic protocol (warm-up discard, multiple
   samples, median, 0/4/8/16 sweep) — but the lab is repo-internal: the
   package publishes only `dist/`, so npm consumers have neither. The real
   gap is packaging, not math: a tested, importable comparison harness.
2. **"Downstream CI tests struggle to simulate multi-tool turns"** —
   **stale**. `mockToolCallChunks` ships parallel tool calls complete in one
   frame (the native shape) since v1.14.0, and malformed-argument cases are
   already expressible: `MockToolCallSpec.arguments` accepts a pre-encoded
   string (including invalid JSON — the OpenAI-style stringified-arguments
   hazard), and `register()` accepts arbitrary raw frames for any other
   malformed shape.
3. **"Difficult to test error recovery in consumer pipelines"
   (`simulateStreamFailure`)** — **stale**. `injectErrorFrame` (v1.14.0)
   _is_ mid-stream failure injection with strictly better semantics than a
   one-shot `simulateStreamFailure(errorMessage)`: positional
   (`after: N`), HTTP-200 in-band, done-frame suppression (an error frame
   after `done` is unread), raising `OllamaStreamError` with the partial
   content. `dropConnectionMidStream` covers transport-level faults;
   `status: 503` covers overload bodies.

The audit did surface one genuine engine limitation the digest's
`ScenarioMockOllamaServer` sketch was groping toward: routes could not vary
their response **per request** — no fail-twice-then-succeed retry drills, no
body-dependent payloads.

## Decision

### `compareDraftPerformance` — a standalone utility, not a client namespace

The digest recommended `client.benchmark.compareDraftPerformance()` and
sketched a `SpeculativeBenchmarkRunner` class. Shipped instead: a standalone
`compareDraftPerformance(client, options)` export taking a **structural**
`DraftBenchmarkClient` (`{ generate }` with the non-streaming overload
signature) — the same discipline as the affinity router's structural
client. Reasons:

- The client's surface stays transport + state; a benchmark is a _derived_
  utility that composes `generate` + `formatTelemetry`, and a function with
  an options object composes without dragging a namespace onto
  `OllamaClient`.
- A structural dependency is testable and transport-agnostic. The sketched
  class holds only the client — zero reusable config — so it bought nothing
  the function doesn't.
- The sketch's single-shot measurement was statistically weaker than what
  the repo already learned shipping `lab/15` (noisy small-model runs make
  single samples mislead). The utility keeps the lab's protocol: warm-up
  discard, multiple samples (default 5), median. It also forces
  `temperature: 0` and stamps a fixed seed — the digest's own deterministic
  protocol.

The multi-setting sweep (0/4/8/16) stays in the lab: it is an
experimentation concern, not an API — the utility's A/B answers the
decision ("enable drafting?") in one call.

### Scenario mocks — composable per-request responses, not a scenario subclass

The digest's `ScenarioMockOllamaServer extends MockOllamaServer` with a
one-shot `queueScenario()` was **declined**: it forks the engine's request
path (exactly what ADR 0029's promote-don't-fork protects), queues scenario
state that races with per-route registration, and hardcodes three
scenarios. Every one of its scenarios was already expressible on the
promoted engine; the one thing missing was per-request variation.

Shipped instead: `MockEndpointOptions.responder(record) =>
MockRouteResponse | undefined`. The responder receives the same
`MockRequestRecord` that lands in `server.requests` and returns the
complete response for that request (or `undefined` to fall back to the
route's static fields). Fail-twice-then-succeed, body-dependent payloads,
and call-count behavior become closure-local one-liners on the same
emission pipeline (`chunkDelayMs`, `injectErrorFrame`,
`dropConnectionMidStream`, `rawBody` unchanged). Type-level only, the
response fields moved to `MockRouteResponse`, which `MockEndpointOptions`
extends — existing routes are unaffected.

## Consequences

- The SDK's own benchmark tests run daemonless against responder routes —
  the exact consumer CI pattern the digest describes, exercising the public
  engine rather than test-only fixtures.
- `DraftPerformanceComparison` reports self-consistent numbers (the
  multiplier divides the two reported medians; `effectiveGain` compares the
  reported multiplier), so consumers can recompute the math from the
  output.
- A side with zero usable samples throws
  `OllamaClientError('draft_benchmark_no_valid_samples')` rather than
  reporting a fabricated 0x/Infinity speedup — wrong model names fail
  loudly.
- The "no draft network" reading (speedup ≈ 1.0 because the server silently
  ignores `draft_num_predict`) is documented on the utility, in the README,
  and in the lab, because it is the most common way this benchmark "fails"
  without anything being broken.
