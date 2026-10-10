# ADR 0028: Telemetry normalization, multi-host model affinity, and the root liveness ping

Date: 2026-10-10

## Status

Accepted (shipped in 1.12.0)

> This ADR was written after 1.12.0 was published, when the release's source was
> committed to the repository. Its content is limited to decisions recorded in the
> 1.12.0 CHANGELOG/README and observable in the shipped code; nothing here is
> inferred beyond that.

## Context

The October 10 documentation digest ("Daemon Liveness & Telemetry
Standardization") reviewed Ollama's operational surfaces: the root liveness
probe (`HEAD /` → 200, `GET /` body "Ollama is running"), `GET /api/version`,
`GET /api/ps` runner introspection, and the nanosecond duration counters on
every generation response. Each gap claim was verified against the codebase
before anything was built:

1. **Multi-host load balancing ("add a `LoadBalancedOllamaClient`").** Stale.
   Multi-host pooling already exists: `endpoints` + `endpointHealth` with
   `least-connections` routing, `maxConcurrentPerEndpoint` capacity caps, and
   503/`OLLAMA_MAX_QUEUE` saturation failover via `DEFAULT_FAILOVER_CODES`.
2. **Telemetry math.** Real gap. Every consumer re-derived ms, tokens/second and
   cache-hit ratio from the raw nanosecond/token counters.
3. **Dynamic multi-host model affinity.** Real gap. `ModelAffinityScheduler`
   (1.11.0) prevents model thrashing inside one client, but the multi-host
   request path still sent requests to hosts that didn't hold the model, forcing
   an unload/cold-load swap on `OLLAMA_MAX_LOADED_MODELS`-bounded daemons.
4. **Root liveness probe.** Real gap. `healthCheck()` audits every endpoint via
   the heavier `GET /api/version`; there was no single-host, minimal-cost check
   of the kind load balancers use.

## Decision

### 1. Do not add `LoadBalancedOllamaClient`

It would fork the existing routing engine (priority tiers, strategies, capacity
caps, circuit breaker, `models`-scoped credentials) into a second implementation.
The missing piece, affinity, is added to the existing engine instead (§3).

### 2. `formatTelemetry(raw)` — `src/telemetry/metrics.ts`

A pure, never-throwing normalizer from raw counters to `totalLatencyMs`,
`modelLoadMs`, `promptEvalMs`, `generationMs` (ns→ms, 2 decimals),
`tokensPerSecond` (`eval_count / (eval_duration / 1e9)`, the official Usage-doc
formula), `promptTokensPerSecond`, and `cacheHitRatio`. Missing counters read as
`0`, never `NaN`/`Infinity`. The input is structural: `ChatResponse`,
`GenerateResponse`, the final stream event and `EmbedResponse` pass as-is.

**`cacheHitRatio` deliberately deviates from the digest's sketch.** It is
`cached / (cached + evaluated)`, not `cached / prompt_eval_count`. Ollama reports
`prompt_eval_count: 0` on a _full_ cache hit, so the digest's formula divides by
zero and reports a perfect cache as "no caching". The sum denominator matches the
SDK's existing `ConversationSession.cacheStats.hitRate`, so both surfaces share
one definition.

### 3. Opt-in multi-host affinity — `endpointHealth.modelAffinity` + `ModelAffinityRouter`

With `endpointHealth: { modelAffinity: { ttlMs?, failureRetryMs? } }`, each
request's runnable candidates are reordered so hosts whose `GET /api/ps` shows
the requested model resident come first.

- **Zero added request latency.** The reorder is synchronous and cache-only. On a
  miss the request proceeds in the original order while a deduplicated
  background refresh warms the cache (TTL 30s default, 5s failure backoff).
  `warmModelAffinity()` pre-warms; `modelAffinityStatus()` exposes snapshots.
- **Partial knowledge suppresses the reorder.** If any candidate's snapshot is
  missing or stale, the original order stands; routing on partial residency data
  risks exactly the swap this prevents.
- **Probes bypass `executeWithFailover`.** No reentry, no circuit-breaker
  pollution, no cross-host failover: residency is a per-host fact. Failures are
  never cached as data.
- **Race-free with `least-connections`.** There is no `await` between candidate
  selection, the reorder and `acquire()`, so the strategy's one-per-account
  guarantee is unchanged.
- **One residency matcher.** `isModelResident` was extracted from
  `findRunningModelContextLength` and is shared with context-window discovery:
  exact `name`/`model` match, or tag-less prefix (`llama3` ↔ `llama3:latest`),
  never `llama` → `llama3.1`.
- **Off unless configured.** Without `modelAffinity` the router is not
  constructed and no `/api/ps` probes are issued.

### 4. `client.ping()` — `HEAD /`

Probes the current best candidate and resolves
`{ healthy, latencyMs, baseUrl, error? }`. It is **single-shot by design**: no
retry, no failover, because a liveness probe must answer about one concrete
host. Connection failures, timeouts and error statuses resolve with
`healthy: false`; only caller-initiated cancellation rejects. Fleet audits remain
`healthCheck()`'s job.

## Consequences

- All additions are opt-in or new API surface; no breaking changes.
- Telemetry math has one tested definition shared with `ConversationSession`.
- Affinity adds background `/api/ps` traffic only for clients that enable it.
- **Known issue (found when the source was committed):** the README states that
  affinity keeps priority tiers "working exactly as before", but the shipped
  `reorder()` operates on the whole runnable set. A lower-priority host holding
  the model is therefore tried before a higher-priority host that does not. A
  fix (reorder within each priority tier) changes routing behavior and belongs
  in a patch release.
