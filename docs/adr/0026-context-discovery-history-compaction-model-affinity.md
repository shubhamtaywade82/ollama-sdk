# ADR 0026: Context-window discovery, history compaction, and model-affinity scheduling

Date: 2026-10-09

## Status

Accepted

## Context

The daily documentation digest (Oct 9) walked through Ollama's official
concurrency & memory-scaling mechanics — the FAQ's formulas and the
Running-Models / Show endpoints — and recommended four SDK upgrades. Auditing
each against the actual codebase first (the same discipline as ADR 0025, where
one audit claim turned out stale) split them into one stale claim, two real
gaps, and one judgment call:

1. **Client-side concurrency pooling** — _stale claim._ The digest said the
   SDK "dispatches unbounded fetch calls." In fact `EndpointRegistryOptions`
   has capped per-endpoint concurrency with client-side queuing
   (`maxConcurrentPerEndpoint`, plus `least-connections`) since the endpoint
   registry landed, and PR #46's `destroy()` even aborts queued
   capacity-waiters. The gap was **visibility**: nothing in the README maps
   client-side surfaces to the server knobs (`OLLAMA_NUM_PARALLEL`,
   `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_MAX_QUEUE`) they exist to respect.
2. **Context-window discovery** — _real gap, partially covered._
   `client.capabilities(model).contextLength` already scans
   `/api/show`'s `model_info["*.context_length"]` (the native GGUF max), but:
   it never consults `GET /api/ps`, whose `context_length` is the window the
   **running instance actually allocated** — a different number, sometimes
   32× apart (the official API examples show `gemma4.context_length: 131072`
   native vs `context_length: 4096` allocated); it ignores the Modelfile
   `num_ctx` default serialized in `/api/show`'s `parameters`; and there is
   no first-class helper, so applications keep hardcoding 2048/4096.
3. **Silent truncation** — _estimation/pre-flight covered since 1.9.0_
   (context-safety + PR #46's embedding pre-flight), _compaction missing._
   Long-running sessions grow monotonically; the only escape was manual
   history surgery. But compaction interacts dangerously with the KV cache:
   rewriting history invalidates the prompt prefix.
4. **Model thrashing** — _real gap._ Multi-model workloads (extraction on a
   coder model, reasoning on a thinking model) interleave models arbitrarily;
   per the FAQ, each switch queues until the first model goes idle or is
   evicted (`OLLAMA_MAX_LOADED_MODELS`, default 3× GPUs), paying an
   unload/cold-load swap. The SDK has `ps()`, `pin()`, `unload()` — but no
   scheduling primitive that keeps the working set small.

## Decision

### 1. Multi-source context discovery (`src/context-discovery.ts`)

`client.models.getContextLength({ model, skipRunningCheck? })` consults, in
precedence order: **running** (`/api/ps` allocated window — exact ground
truth when loaded) → **parameters** (Modelfile `num_ctx` — what a cold load
_will_ allocate) → **model-info** (native GGUF max — a _ceiling_, never an
expectation) → **fallback** (2048). The result carries every signal found, so
"what do I have" and "how far could I raise it" are both answered.

Deliberate details:

- **Allocated beats native.** A fresh `num_ctx`-less load may allocate far
  less than native; programming against the native max would _cause_ the
  silent truncation this discovery exists to prevent.
- **Tag-less matching mirrors Ollama's own resolution**: `llama3.1` matches
  the running entry `llama3.1:latest` (and never `llama3.2:latest`).
- **Graceful degradation**: a 404 from `/api/ps` (compat-only hosts) means
  "not running," not failure; other errors propagate. `skipRunningCheck`
  saves the round-trip where the listing isn't meaningful.
- **Discovery stays explicit, not ambient.** We do _not_ auto-wire discovery
  into the pre-flight checks — it costs network round-trips per request and
  the right pattern is one lookup feeding `defaultContextLength`. The pure
  resolvers are exported for callers holding raw responses.

### 2. Manual sliding-window compaction (`conversation.ts`)

`compactConversationHistory(messages, options)` (pure) and
`session.compact(options?)` (in place) keep the leading system message(s)
plus the newest turns that fit `maxEstimatedTokens − reserveForReply`,
always retaining `minTailMessages` (default 2) even when oversized — the SDK
never reproduces the server's silent truncation on its own.

**Compaction is never automatic.** It invalidates the prompt prefix, so the
next turn starts with a cold KV cache — a one-turn `evaluatedTokens` spike,
deliberately visible in `cacheStats` (tallies are observations and are never
reset). For a hot cache-friendly session that never overflows, automatic
compaction would be pure loss; for a long-running agent thread that would
otherwise silently lose its oldest turns, it is exactly right. The SDK
surfaces the numbers and leaves the call to the caller — the same
philosophy as `onContextOverflow: 'warn'` being the default rather than
`'throw'`.

### 3. Affinity-sticky scheduling (`src/affinity.ts`)

`ModelAffinityScheduler` groups caller tasks into per-model serial queues
with two caps: `concurrentModels` (distinct models with work in flight,
default 1 — the anti-thrash setting) and `perModelConcurrency` (default 1,
mirroring `OLLAMA_NUM_PARALLEL`). Dispatch is **affinity-sticky, not
round-robin**: a queued model that is already active deepens before the
next model loads, because deepening reuses loaded weights while switching
pays a swap. Candidate lists (`run(['a', 'b'], task)`) prefer the candidate
that is already loaded per a TTL-cached `/api/ps`; a failing lookup degrades
to the first candidate and never caches the failure.

**User-space primitive, not client plumbing.** Affinity is workload policy,
not transport behavior — so the scheduler takes a structural
`ModelAffinityClient` (any `OllamaClient` satisfies it), injects no
retry/timeout/failover into caller tasks, and is not wired into
`OllamaClient`'s request path. It is the foundation for the planned
multi-instance routing work (pools of local daemons), where the same
queues gain endpoint awareness.

### 4. Capacity-planning documentation over new pooling code

For finding 1 we documented rather than re-implemented: a README table maps
each official server knob (`OLLAMA_NUM_PARALLEL` — KV memory scales
`NUM_PARALLEL × CONTEXT_LENGTH`; `OLLAMA_MAX_LOADED_MODELS`; `OLLAMA_MAX_QUEUE`
→ 503s; `num_ctx` silent truncation) to its existing client-side counterpart
(`maxConcurrentPerEndpoint`, `least-connections`, `embedBatch`,
`ToolRegistry.maxConcurrency`, discovery + pre-flight + compaction), plus a
pointer on `OLLAMA_KV_CACHE_TYPE` benchmarking. The one behavior change in
this area: `ps()` accepts optional `{ signal, timeoutMs }` so discovery
calls are cancellable like every other request.

## Consequences

- Applications can replace hardcoded window guesses with one round-trip and
  program against the allocated window while knowing the native ceiling —
  and `defaultContextLength` wiring makes the existing pre-flight checks
  exact rather than heuristic-about-a-heuristic.
- Sessions that outgrow their window have a one-call escape hatch whose cost
  (cold next turn) is surfaced in the return value and `cacheStats`, not
  hidden.
- Multi-model workloads get a default that cannot thrash (one model hot) and
  two knobs to relax it deliberately; candidate routing rides real
  `/api/ps` data with a TTL and degrades safely.
- The scheduler's stickiness trades fairness for swap-avoidance: a model
  with a deep queue can starve another model's tasks while
  `concurrentModels: 1`. That is the intended semantics (documented on the
  option), and callers who need interleaving raise `concurrentModels`.
- Multi-instance routing (the digest's "tomorrow" focus) extends
  `ModelAffinityScheduler` with endpoint-aware queues rather than replacing
  it; this ADR is the baseline that work builds on.
