# ADR 0028: Telemetry normalization, dynamic host model-affinity routing, and root liveness probing

Date: 2026-10-10

## Status

Accepted

## Context

The October 10 documentation digest ("Daemon Liveness & Telemetry
Standardization") reviewed the official server-level operational surfaces —
the root liveness probe (`HEAD /` → HTTP 200; `GET /` answers the
plain-text body "Ollama is running"), engine metadata (`GET /api/version`),
runner introspection (`GET /api/ps` with `size_vram`/`context_length`), and
the nanosecond duration counters on every generation response — and proposed
three SDK upgrades: a standardized telemetry normalizer, a
`LoadBalancedOllamaClient`, and model-affinity routing to the host already
holding the target model in VRAM. Per house discipline, every claim was
verified against the codebase before implementing; two of the digest's gap
assessments were stale:

1. **"Single-host static URL (`baseUrl`) restricts horizontal scaling."**
   Stale. Multi-host pooling has shipped for several versions: an
   `endpoints` array (each with its own `baseUrl`/`apiKey`/`priority`/
   `models` allow-list), `credentials`/`modelBindings` config sugar, and
   `EndpointRegistry` with `'priority'`/`'round-robin'`/`'least-connections'`
   candidate strategies, `maxConcurrentPerEndpoint` capacity caps with FIFO
   queueing, and a circuit breaker with cooldown. The proposed
   `LoadBalancedOllamaClient` class would re-implement a _subset_ of this
   engine as a parallel, divergent code path — the exact API-fork mistake
   ADR 0027 declined with `runToolLoop`.

2. **"Requests fail immediately if the target daemon is overloaded."**
   Stale. `'overloaded'` — the 503 `OLLAMA_MAX_QUEUE`-saturation error — is
   in `DEFAULT_FAILOVER_CODES`; saturation triggers same-host retry (with
   backoff) and then failover to the next candidate, plus circuit-breaker
   cooldown past the failure threshold.

3. **Telemetry math left to consumers.** Real gap. The nanosecond counters
   (`total_duration`, `load_duration`, `prompt_eval_duration`,
   `eval_duration`) and token counts (`prompt_eval_count`,
   `prompt_eval_cached_count`, `eval_count`) are typed on every response,
   but nothing derived the human-scale summary (ms latencies, tokens/s,
   cache-hit ratio) — every consumer reimplemented the same division and
   rounding, and the easy mistakes (integer division by 1e9, `NaN` on
   missing counters, cache ratio dividing by the wrong denominator) were
   left to each caller.

4. **Model-affinity routing across hosts.** Real gap — and the digest's own
   "tomorrow's focus" item. `ModelAffinityScheduler` (ADR 0026) provides
   affinity for a _single_ client's task queues, and static
   `OllamaEndpoint.models` allow-lists scope credentials to models, but
   nothing dynamically consulted `GET /api/ps` **per endpoint** to prefer
   the host already holding the requested model in VRAM — the multi-host
   equivalent of the anti-thrashing argument, since dispatching to a host
   without the model forces an unload/cold-load swap under
   `OLLAMA_MAX_LOADED_MODELS`.

5. **Root liveness probing.** Partial gap. `client.healthCheck()` probes
   every endpoint via `GET /api/version` (also returning the version), but
   the documentation's _ultra-lightweight_ probe — `HEAD /` — had no SDK
   surface, and `healthCheck` is fleet-wide by design: no single-host
   "is my daemon up" one-liner existed.

## Decision

### No `LoadBalancedOllamaClient` — extend the existing engine instead

The multi-host pool already is a load-balanced client: `endpoints` +
`endpointHealth: { strategy: 'least-connections' }` is exactly the digest's
proposed feature set (host array, least-connections routing, health-driven
exclusion), with the circuit breaker, capacity queueing, model-scoped
routing, streaming slot accounting, `destroy()` teardown, and OpenTelemetry
spans that a separate class would have to re-implement or lose. A
`dispatch(fn)`-style helper adds nothing the existing per-method routing
doesn't already provide — every client method already routes through
`executeWithFailover`. We therefore extend the engine with the two real
gaps below and document the pooling surface as the answer to the digest's
matrix, rather than forking it.

### `formatTelemetry` — one normalizer, house cache-ratio semantics

`src/telemetry/metrics.ts` adds a pure `formatTelemetry(raw)` producing
`{ totalLatencyMs, modelLoadMs, promptEvalMs, generationMs,
tokensPerSecond, promptTokensPerSecond, cacheHitRatio }` from the raw
nanosecond/token counters, with the official Usage-doc formulas
(`eval_count / (eval_duration / 1e9)`, etc.), 2-decimal ms and 1-decimal
rate rounding, and missing counters reading as `0` — never `NaN`/`Infinity`.
The input type is structural: any response object carrying the optional
counters (`ChatResponse`, `GenerateResponse`, the final
`GenerateStreamEvent`, `EmbedResponse`) is accepted as-is, no plucking.

One deliberate deviation from the digest's sketch:
**`cacheHitRatio = cached / (cached + evaluated)`**, not
`cached / prompt_eval_count`. Ollama reports `prompt_eval_count: 0` on a
_full_ cache hit (all prompt tokens served from the KV prefix cache), so
the digest's formula divides by zero and would read a perfect cache as "no
caching." The sum denominator is already the SDK's established semantics —
`ConversationSession.cacheStats.hitRate` (ADR 0026 era) computes exactly
this — and consistency between the two surfaces is worth more than fidelity
to a snippet that misreports the edge case it exists to measure.

### `ModelAffinityRouter` — zero-latency, cache-only reordering

Dynamic host affinity is implemented **inside** `executeWithFailover`,
opt-in via `endpointHealth.modelAffinity: { ttlMs?, failureRetryMs? }`:

- **Synchronous, cache-only reorder.** After the registry's
  `candidates()`/`filterWithCapacity()` produce the runnable set, a
  `ModelAffinityRouter.reorder(runnable, model)` moves endpoints whose
  _fresh_ `/api/ps` snapshot shows the model resident to the front
  (relative order preserved within groups, so priority and
  least-connections decisions stay intact). No `await` sits between the
  reorder and the endpoint's `acquire()` — the least-connections
  race-free guarantee (no two concurrent calls observe the same idle
  snapshot) is preserved by construction.
- **Zero added request latency.** A request never waits for a probe: on a
  cache miss the request proceeds with the unchanged order while the
  refresh runs in the background, warming the cache for subsequent
  requests. `client.warmModelAffinity()` pre-warms at startup for callers
  that want first-request routing; `client.modelAffinityStatus()`
  exposes the snapshots for observability.
- **Partial knowledge suppresses the reorder.** If any candidate's
  snapshot is stale or unknown, the order is left alone — routing on
  partial residency data risks the exact unload/cold-load swap the
  feature exists to avoid (the model may have been evicted since).
- **Probes never interfere with the request path.** The `/api/ps` fetch
  bypasses `executeWithFailover` entirely: no reentry into the machinery
  it informs, no circuit-breaker bookkeeping (a dead host's probe failing
  must not cool it down beyond what its real traffic does), no failover
  (the answer is per-host by definition). Failures are never cached as
  data — the endpoint reads as "unknown" — and a `failureRetryMs` backoff
  (default 5s) prevents probing a dead host on every request. Probes are
  bounded by their own 5s timeout and are not registered in
  `activeRequests`, so `destroy()` doesn't wait on them; a fire-and-forget
  refresh may briefly outlive a destroy call, at most until that timeout.
- **Matching semantics are shared, not duplicated.** "Resident" uses the
  same matcher as context-window discovery (`isModelResident`, refactored
  out of `findRunningModelContextLength`): exact `name`/`model` match, or
  tag-less prefix (`llama3` ↔ `llama3:latest`) — and _not_ a bare string
  prefix, so `llama` never matches `llama3.1`. The two features can never
  disagree about whether a model is loaded.
- **Off unless configured.** Without `modelAffinity`, the router isn't
  constructed: the reorder is a no-op and no `/api/ps` probes are ever
  issued — zero overhead, zero behavior change for existing users.

### `client.ping()` — the root probe, single-shot by design

`ping(options?)` issues `HEAD /` against the current best candidate
endpoint and resolves `{ healthy, latencyMs, baseUrl, error? }`. It
deliberately does **not** fail over or retry: a liveness probe's value is
that it answers about _one concrete host_ — "some endpoint eventually
answered" is precisely the ambiguity a health check exists to remove.
Fleet audits remain `healthCheck()`'s job (every endpoint, plus version).
`ping` resolves rather than throws on failure (monitoring loops treat it
as a datapoint); only caller cancellation rejects, like any other aborted
request.

## Consequences

- The digest's use-case matrix is fully served by one routing engine:
  pooling (`endpoints` + strategies), saturation failover
  (`DEFAULT_FAILOVER_CODES`), telemetry (`formatTelemetry`), and now
  dynamic residency affinity (`modelAffinity`) — with no second client
  class to keep in sync, document, or secure-review.
- `formatTelemetry` gives every consumer the same correct math, including
  the two subtle cases (full-cache-hit ratio, missing counters → 0) that
  hand-rolled conversions most often get wrong; `ConversationSession`'s
  ratio and `formatTelemetry`'s ratio can never diverge because the
  semantics are now documented together.
- Affinity routing is observability-friendly (`modelAffinityStatus`) and
  startup-friendly (`warmModelAffinity`), at the cost of one background
  `GET /api/ps` per endpoint per TTL window (default 30s) — the same probe
  cadence `ModelAffinityScheduler` already established as negligible.
- Future work the digest deferred (quantized KV-cache latency, `f16` vs
  `q8_0`/`q4_0`) remains a benchmarking/docs concern — the
  capacity-planning section in the README carries the
  `OLLAMA_KV_CACHE_TYPE` pointer; measuring it needs real GPU hardware
  this project's CI cannot provide, so it stays documentation, not code.

## References

- Official Ollama documentation: Usage (nanosecond counters and
  tokens/second formulas), List running models (`GET /api/ps`), the root
  liveness probe (`HEAD /` / `GET /` → "Ollama is running")
- ADR 0026 — single-host `ModelAffinityScheduler`, TTL-cached `/api/ps`,
  the anti-thrashing argument (`OLLAMA_MAX_LOADED_MODELS`)
- ADR 0027 — the same verify-first verdict discipline (stale claims
  answered with docs + tests, e.g. declining `runToolLoop`)
- ADR 0008 — single-endpoint pinning for endpoint-targeting operations
  (why affinity never reorders a `capabilities()` call)

## Amendment (1.12.1, 2026-10-10)

As shipped in 1.12.0, `reorder()` moved resident endpoints to the front of the
_whole_ runnable set, so a lower-priority host holding the model was tried before
a higher-priority host that did not. That contradicted the "priority ... decisions
stay intact" statement above. 1.12.1 reorders within each priority tier (runs of
consecutive equal `priority`, unset = 0) and never moves an endpoint across
tiers, which makes the statement true.
