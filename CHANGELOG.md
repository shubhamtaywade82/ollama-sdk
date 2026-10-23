# Changelog

## [1.21.0] — `systemOne` takes a cancellation signal; the failover layer stops dropping caller signals (ADR 0037)

The Decision Plane in nexum could not bound a System One call: its `AbortSignal` never reached the wire. Tracing that found a defect in the SDK, not in nexum. `FailoverHttpClient.request` replaced the caller's signal with the failover layer's own in every attempt, so a signal passed to any runtime operation that accepts one was silently ignored. [ADR 0037](./docs/adr/0037-systemone-signal-failover-cancellation.md) records the root cause and the declined alternatives.

### Fixed — per-call signals are honoured

- **`native.tags`, `native.ps`, `native.version`, `native.blobs`, and `runtime.invoke({ signal })`** now cancel in flight. They accepted the option and ignored it before this release. A caller that relied on the signal being ignored will now see an abort, and a caller that passes an already-aborted signal fails immediately without sending the request.

### Added

- **`client.systemOne(request, { signal })`.** The signal covers the whole call: the cloud-model version probe that runs first (ADR 0036), and the request on the wire. An abort rejects with `OllamaAbortError`. The probe is raced against the signal rather than cancelled, so one impatient caller cannot poison the cached probe for later calls.

### Changed

- `systemOne` calls `runtime.invoke` with the same operation and body that `NativeApi.systemOne` uses. Calls that pass no signal send the same request as before.

### Docs

- `docs-site/api/client.md` and `docs-site/guide/system-one.md` document the signal. ADR 0037 is added to both ADR indexes.

### Notes — CHANGELOG tidy

- Two `[Unreleased]` headings held entries that had already shipped. The 1.9.0-era entries (the IPv6 loopback fix, host normalization, and the digest work) now sit under 1.9.0, since their commits are in the `v1.9.0` tag. The MCP bridge and stdio entries now sit under "Releases 1.5.0 to 1.8.0", since their first commits are between `v1.5.0` and `v1.8.0`. There are still no release sections for 1.5.0, 1.5.1, or 1.6.0 in this file.

## [1.20.1] — Self-hosted servers are no longer refused as Ollama Cloud

Structured output (`format`) was refused pre-flight for every base URL outside `localhost`, `*.local`, `192.168.*` and `10.*`. The classifier treated any other host as cloud, so a self-hosted server reached by a Docker or Kubernetes service name (`http://ollama:11434`), a `172.16/12` address, or a public domain of its own threw `OllamaUnsupportedCapabilityError` on every `format` request. There was no opt-out. Caught while wiring `@nemesis-oss/ollama-sdk` into agentic-tui, whose docker-compose stack points the supervisor at `http://ollama:11434`.

### The classification rule

`inferRuntimeMode(baseUrl)` now classifies by hostname alone, with three outcomes:

- **`cloud`**: `ollama.com` and `*.ollama.com` only. A suffix lookalike such as `ollama.com.evil.net` is not cloud. Only this host is refused for `format`.
- **`local`**: a private-network server. That covers loopback (`127.0.0.0/8`, `::1`, `0.0.0.0`, `*.localhost`), RFC 1918 IPv4 (`10/8`, `172.16/12`, `192.168/16`), IPv6 unique-local (`fc00::/7`), `*.local`, `*.internal`, and single-label names with no dot or colon, such as Docker or Kubernetes service names.
- **`unknown`**: every other hostname, including self-hosted servers on public domains. These are not refused for `format`, and they are not assumed to be local.

The IPv4 checks match address literals only, so `10.example.com` is no longer mistaken for `10.0.0.0/8`.

### Behavior changes

- `format` requests go to self-hosted servers on any host. Only `ollama.com` is refused.
- `parallelToolCalls` for `local` hosts uses the local family and name heuristics. For `unknown` hosts it reports `'unknown'`. Previously every non-private host got the cloud heuristic, which reported `'yes'` for any tool-capable model.
- The cloud-model version gate (`OllamaCloudModelVersionError`) probes `/api/version` only for `local` endpoints. Previously a self-hosted server with a non-private hostname skipped the gate. It now still skips it when the hostname is `unknown`.
- `runtimeMode()` can now return `'unknown'`, as it already could for an unparseable base URL.

### Tests

- `test/unit-capabilities.test.ts`: classification table for each outcome, including the lookalike and address-literal edge cases.
- `test/parallel-tool-calls.test.ts`: a public self-hosted host reports `parallelToolCalls: 'unknown'` (previously `'yes'`).
- `test/unsupported-capability.test.ts`: `format` requests reach a self-hosted endpoint on a Docker service name and on a public domain.

## [1.20.0] — Post-audit v1.19.1 refresh: re-pin 36a6e99, usage model grouping, ShowResponse prompt provenance, the 0.40.5 cloud-model gate

The daily audit against the v1.19.1 baseline claimed "zero upstream drift since d9b8601, no action needed"; independent verification (raw content diff of upstream `docs/openapi.yaml` against the pin — the same discipline that caught the v1.19.0 audit's false row) found the headline false and two repository-internal defects besides. Two upstream commits had landed after the 2026-10-16 pin: `2476d5e` adds model grouping to cloud usage, and `36a6e99` populates `ShowResponse.renderer/parser` and adds `template_source`. Separately: the docs had promised since 1.19.0 that cloud models (`clef:cloud`) require "Ollama >= 0.40.5, enforced automatically" while only the blanket 0.35.0 floor was ever enforced, and `docs-index.json`'s `pinnedSha` silently lagged the pin by one refresh (nothing consumed it, no test covered it). All changes additive or gap-closing; no breaking changes (see [ADR 0036](./docs/adr/0036-post-audit-v1191-refresh-usage-grouping-cloud-gate.md)). 1087 pre-existing tests stay green, 14 net-new tests added.

### Upstream drift (re-pin `d9b8601` → `36a6e99`)

- **Usage model grouping (upstream `2476d5e`)**: `GET /api/usage` gains a `group_by=model` query parameter — `client.usage({ groupBy: 'model' })` — and two new schemas, `UsageGroup` (per-model metrics + name) and `UsageSummary` (metrics + up to 10 `groups` ranked by usage or request count, plus a `remainder` roll-up for everything outside the limit). `UsageResponse.totals` widens from `UsageMetrics` to `UsageSummary` (read-compatible — it extends `UsageMetrics`), `UsageBucket` composes the same summary so buckets can carry per-model groups, and the response echoes the selection in a new `group_by` field. Both models and `UsageGroupBy` are root-exported.
- **ShowResponse prompt provenance (upstream `36a6e99`)**: `ShowResponse` gains `renderer` (effective chat renderer, aliases resolved), `parser` (configured output parser), and `template_source` (where the chat prompt comes from: `renderer_parser` | `renderer` | `parser` | `harmony` | `go_template` | `gguf_chat_template` | `none`) — typed in both the generated surface and `src/types.ts`, and added to the show operation's parity block (the live docs document all three).
- The pin header documents both commits; the single intentional `families` `[array, null]` deviation is retained unchanged. The "nine corrupted literals" seen during verification were a terminal display artifact (ANSI-like sequence stripping eating `[m` from `[model]`) — the second occurrence of that trap; ADR 0036 records the character-level verification method so it is not "repaired" a third time.

### The 0.40.5 cloud-model gate (docs-vs-runtime gap closed)

- `OllamaClient.systemOne` now enforces the documented model-dependent floor before any request is sent: a cloud model (name ending `:cloud`, e.g. `clef:cloud`) through a **local** server probes `/api/version` (through the normal failover machinery, cached per client instance, reset on probe failure) and throws the new typed `OllamaCloudModelVersionError` (code `cloud_model_version`, fields `model`/`serverVersion`/`minRequiredVersion`) when the server is older than 0.40.5 — zero wasted round-trips. Hosted `ollama.com` endpoints never gate; non-cloud models never gate; a failed probe fails open (the runtime's `'auto'` policy), letting the server's own response be the next signal.
- Version comparison is numeric component-wise (`compareOllamaVersions`, root-exported alongside `isCloudModel`, `CLOUD_MODEL_SUFFIX`, `CLOUD_MODEL_MIN_OLLAMA_VERSION`), mirroring the generated runtime's private comparator — `'0.9.0' < '0.40.5'` ranks correctly, not lexicographically.
- The blanket operation-level 0.35.0 floor is unchanged (still IR-enforced in the generated runtime). The low-level `client.native.systemOne` path bypasses the gate by design, same as every other wrapper ergonomics; the promise is scoped to where the docs make it.

### Pin provenance unification

- `docs-index.json`'s `pinnedSha` now records the upstream main **commit** SHA from the pin header (previously a blob SHA that had silently lagged one refresh), and new `test/contract/pin-consistency.test.ts` asserts header/index agreement, 40-hex formats, on-disk existence of every indexed source path, and that the header documents the current refresh's features — a stale index can no longer hide behind a passing build.

### Docs

- New [ADR 0036](./docs/adr/0036-post-audit-v1191-refresh-usage-grouping-cloud-gate.md) recording the refresh, the gate placement reasoning (request-dependent constraints cannot live in the IR), the declined alternatives, and the recurring display-artifact trap. ADR indexes updated (`docs/adr/README.md`, `docs-site/adr/index.md`).
- `client.ts` JSDoc for `systemOne`/`usage` describes the gate and grouping; the system-one guide's "0.40.5+ for cloud models" warning is now true in code.
- Watch item carried (not acted on): upstream `efabf6bc` now emits Anthropic error events mid-stream while the docs still call them unsupported — the pinned MDX matches the docs; re-audit the Anthropic bridge when the docs row flips.

## [1.19.1] — Honoring `Retry-After` on 429s: closing the dead-`retryAfterMs` gap (audit v1.19.0 parity)

The daily audit against the v1.19.0 baseline (`2d3ec47`) claimed six capability domains all PASS; point-by-point verification found five true and one false — "Native client methods with `OllamaRateLimitError.retryAfterMs` and jittered 429 retries". The field existed and the docs already described it, but nothing populated or consumed it: all three `HttpClient` error-mapping sites discarded response headers when building error contexts, `statusToError`'s 429 branch never parsed `Retry-After`, and `withRetry` slept full-jitter backoff regardless. The pinned upstream contract documents `Retry-After` ("Seconds to wait before retrying", `type: integer`) on the 429 responses of both cloud account endpoints (`/api/usage`, `/api/balance`) — this was contract-required behavior our own `docs-site/api/errors.md` already claimed. All changes live in the handwritten layer; no contract or generated-surface changes (see [ADR 0035](./docs/adr/0035-retry-after-honoring.md)). 1057 pre-existing tests stay green, 30 net-new tests added.

### `OllamaRateLimitError.retryAfterMs` is now real

- **`parseRetryAfterMs(headerValue, now?)` — new root-exported parser**: delay-seconds (`"120"` → 120 000 ms) or strict IMF-fixdate HTTP-date (→ milliseconds until that instant, clamped at `0` for past dates). The HTTP-date branch validates the shape **before** `Date.parse` because engine date parsers are dangerously lenient (V8 accepts `"1.5"` as a year-2001 date); malformed or overflow values return `undefined`, which falls back to jitter instead of overriding it with a bogus delay. `lookupHeader` (module-level export) does the case-insensitive header lookup on error-context header records.
- `statusToError`'s 429 branch injects `retryAfterMs` from the response headers — one mapping chokepoint, one status. No other status mapping parses the header: 503/502 keep jitter, because nothing documents `Retry-After` for them (the same invented-behavior reasoning ADR 0034 § 5 applied to the cloud limits).

### Transport capture and retry pacing

- `HttpClient` now captures `retry-after` at all three error-mapping sites (`request()`, `requestStream()`, `requestSseStream()`) and the no-middleware lifecycle error event (the middleware path already reported headers) — deliberately capturing **only that one header**, so sensitive fields like `set-cookie` never leak into thrown error objects that callers log. The capture is defensive by design: mock `Response` shapes without a `Headers` implementation degrade to the pre-1.19.1 error-context shape instead of throwing mid-enrichment.
- **`withRetry` honors the server's delay verbatim** — no jitter, no clamping to `maxDelayMs` — via the new `retryDelayMs(error, attempt, backoff)`: the server explicitly said when the client may retry, and re-issuing earlier would only compound the rate limiting the 429 exists to prevent. Callers who consider a server value excessive keep three sanctioned exits: `shouldRetry` rejecting the error, the abort signal (live for the whole sleep), or a `maxRetries` budget. Absent/unparseable headers — and every other retryable error — keep the full-jitter exponential backoff, unchanged. `onRetry` reports the delay actually used, either way.
- `fetchWithBackoff` honors `Retry-After` on 429s identically — its own docs claim "the same retry discipline as the SDK's internal transport", which is kept honest rather than re-worded. The honoring is 429-scoped: 503s keep full jitter even if a header is present.

### Docs

- New [ADR 0035](./docs/adr/0035-retry-after-honoring.md) recording the fix and the declined alternatives with reasoning (clamping to `maxDelayMs`, capturing the full header record, extending `Retry-After` parsing to 503/502, jittering the server value). ADR indexes updated: `docs/adr/README.md` and `docs-site/adr/index.md` — the latter also gains its missing 0034 row from the 1.19.0 wave.
- `docs-site/api/errors.md`'s `OllamaRateLimitError` section now describes the honored-by-`withRetry` semantics and the `parseRetryAfterMs` export; `client.ts`'s cloud-endpoint JSDoc (`webSearch`/`webFetch`/`usage`/`balance`) notes the contract-declared `Retry-After` on 429s.

## [1.19.0] — System One cloud launch contract refresh: dual request-size cap, 402 taxonomy, re-pin d9b8601

The scheduled upstream snapshot freshness check (offered after the Task 24 docs fix, accepted) found upstream `openapi.yaml@main` had moved from `2a9ffe3` to `d9b8601` with the **System One cloud launch** — audited point-by-point against the pinned snapshot before any change, per house discipline (see [ADR 0034](./docs/adr/0034-systemone-cloud-launch-contract-refresh.md)). Upstream now declares `/v1/systemone` with local **and cloud** servers (`https://ollama.com`, optional `bearerAuth`), the `model` field accepts cloud models (`clef:cloud`, requiring Ollama >= 0.40.5 or the hosted endpoint), the local byte caps were **clarified from an either/or reading to a dual bound**, and 401/402 joined the documented response set. A second discovery retired an old deviation: the "corrupted Usage enum literals" the 2026-10-07 pin repaired were our own Bash display artifact eating `[24h`/`[h` CSI-style sequences — upstream serves them clean inline, so the repair deviation is retired. All changes additive or contract-aligning; no breaking API changes. 1047 pre-existing tests stay green, 10 net-new tests added (5 rewritten onto the new semantics).

### System One in Ollama's cloud (environment guard flip)

- The systemone overlay's `environment.cloud` flipped to `supported`, flowing through the IR to the generated operations metadata and the MCP tool description. A client pointed at a cloud host no longer gets `unsupported_capability` from `client.systemOne()` — the request rides the client's configured host, exactly like every other native operation. A local-mode client can equally send `clef:cloud` through the local server (which fronts cloud models and answers 401 with a `signin_url` in the body when not signed in). No special cloud routing was introduced.
- The `unsupported_capability` environment guard itself stays, still firing for genuinely local-only operations (model management: pull, push, copy, create, delete, blobs) — test coverage moved onto `pull`.
- Declined with reasoning in ADR 0034: client-side enforcement of the cloud limits (13 MiB request cap, 64-question/100-char naming, 4-image budgets, 65,536-token context). The runtime cannot reliably classify a request as "cloud" without inventing a `:cloud`-suffix heuristic the contract doesn't specify; the server enforces these limits and the SDK surfaces the typed failures instead.

### Dual request-size cap (upstream clarification, behavior tightening)

- The runtime's request-size guard now checks **both bounds on every request**: the text-and-schema portion (images excluded, via the new `serializeWithoutImages()`) against `maxRequestBytes` (64 KiB), and the whole serialized request against `maxRequestBytesWithImages` (32 MiB). Previously the presence of images selected the higher cap alone, letting a multi-MiB text+schema payload through the client guard into a guaranteed server 413 ("text and schema must not exceed 64 KiB" — the upstream example message). The only behavior change: image-bearing requests whose non-image portion exceeds 64 KiB now fail client-side, without the round-trip.
- `estimateSystemOneRequestBytes(request, { excludeImages: true })` — new option mirroring the runtime guard, so pre-flight checks can measure the text-and-schema half of the dual cap. `MAX_SYSTEM_ONE_IMAGES_BYTES`/`MAX_SYSTEM_ONE_REQUEST_BYTES` JSDoc rewritten to the dual-cap semantics (whole-request cap / text-and-schema cap).
- Cloud 413 semantics documented: cloud requests exceeding 13 MiB or the model's context window are a server-side 413 (local rendered-prompt context overflow remains a 400).

### `OllamaPaymentRequiredError` (HTTP 402)

- New root-exported error class — `code: 'payment_required'`, `retryable: false`, `status: 402` — mapped in `statusToError` per the one-typed-error-per-documented-status pattern (502/503 precedent). 402 is billing, not credentials: the cloud model isn't in the Free plan, usage credits are needed, or a payment failed. Deliberately distinct from `OllamaAuthError` (401/403) so callers branch to an upgrade/add-credits flow instead of re-prompting for an API key. Previously 402 fell through to `OllamaGenericClientError`.

### Contract refresh mechanics

- Pinned snapshot re-pinned at upstream `d9b8601` (content hash `b03e073683d54515`); the 2026-10-07 enum-repair deviation retired (upstream fixed the literals inline — the historical "corruption" was a display artifact); the `ModelSummary.details.families` `[array, null]` deviation re-applied and re-documented. IR regenerated: `model` and `questions` schema descriptions now carry the cloud wording; `systemOne` notes carry the dual cap, cloud limits, and 401/402 semantics.
- Docs synced everywhere the old claims lived: `docs-site/guide/system-one.md` (warning box + error table), `api/decision.md`, `api/client.md`, `api/native-api.md`, `api/errors.md` (new class section + quick-reference row), `README.md`, and the `client.ts`/`system-one.ts`/`errors.ts` JSDoc. Every "Local-only / Ollama Cloud rejects /v1/systemone" statement and every "64 KiB without images, 32 MiB with" either/or cap wording is gone.

## [1.18.0] — Pull/push progress with speed & ETA, decision confidence gates, abort-safety pin, System One score 26→10 refresh

The October 15 digest ("Structured Output Type Inference, Stream Cancellation Memory Barriers, Model Pull/Push Progress Multiplexing") plus its morning upstream-specs companion (System One confidence calibration, a claimed zero-truncation 413 rule) were audited against the codebase before any implementation (see [ADR 0033](./docs/adr/0033-progress-speed-decision-gates-abort-pin-systemone-refresh.md)). Verdicts: the structured-output claim was stale (`chatWithSchema`/`generateWithSchema` already ship full Zod inference + validation + markdown-JSON extraction — the proposed `structured?: T` field injection was declined as both weaker and contract-breaking); the stream-abort claim was stale as a defect (every teardown seam is guarded — most load-bearingly, `holdUntil` attaches a catch handler to every client stream's `finalResult` before the stream is returned) but the invariant is now pinned by real-wire tests; and the pull/push claim was half right — `onProgress()` with a pre-computed `percent` existed internally with 13 tests but was **not exported from the root entry**, and transfer speed didn't exist at all. The morning digest's 413/2-token scoring-head specification appears nowhere upstream (the real `/v1/systemone` 413 is the request-byte cap the SDK has enforced client-side since the System One waves); its one honest catch — taken from its own "OpenAPI Parity Inspection" focus item — is real: upstream tightened System One score criteria from 2–26 to 2–10 levels. All additive, no breaking changes. 1024 pre-existing tests stay green, 23 new tests added.

### Model pull & push progress, with speed and ETA (OPR-01)

- **`onProgress(stream, callback)` is now root-exported** — it was fully implemented (typed `PullProgressEvent` with a clamped two-decimal `percent`, `computeProgressPercent()`, `toPullProgressEvent()`, 13 tests) but absent from `src/index.ts`, so npm consumers couldn't import any of it. All four functions and the three types are public now.
- **`createProgressSpeedTracker()`** — the stateful per-layer byte counter the digest correctly said consumers were forced to hand-roll: feed it every raw progress chunk and it returns `bytesPerSecond` + `etaSeconds` for that chunk's layer. Semantics chosen for stable progress bars: a **cumulative average** since the layer's first byte-bearing frame (instantaneous frame-to-frame rates jitter wildly), **per-layer epochs** (the tracker resets whenever `digest` changes or `completed` regresses, so a multi-layer pull never averages across layers — the classic hand-rolled-counter bug), `performance.now()` monotonic timing, and guards for zero-elapsed, zero-transfer, and missing-total frames (ETA `undefined`, never `NaN` or fake `0`).
- `onProgress` wires the tracker in: every callback event now carries `bytesPerSecond`/`etaSeconds` alongside `percent` once two byte-bearing frames of a layer have arrived. The pure wrapper (`toPullProgressEvent`) never measures time — deterministic tests mock `performance.now()` with an exact manually-advanced clock.
- Declined: a `client.pullWithProgress()` method or progress-multiplexer object — the typed dual-mode stream already _is_ the multiplexed channel; a callback helper composes over it without forking the request path (ADR 0033).

### System One decision confidence gates (morning-digest kernel)

- The six `client.decision` helpers now take **opt-in** calibration gates for autonomous flows — the digest's real concern (an agent acting on a 0.51 coin-flip `true` it never inspected):
  - `choice()` / `score()` / `route()` / `rank()` accept `minConfidence` (inclusive lower bound in (0, 1]; `RangeError` otherwise, validated **before** any request is sent) and flag results with `isConfident: confidence >= minConfidence`. The value is still returned — the caller decides whether to act.
  - `noul()` / `verify()` accept `minProbability`, which raises the bar their derived boolean must clear (default 0.5 unchanged). Noul answers carry no separate confidence field, so the threshold _is_ the boolean bar — a redundant `isConfident` would always equal `bool`.
- Without the options, every result shape and default behavior is byte-identical — gates are purely additive, and `isConfident` is present only when configured.
- Declined with reasoning in ADR 0033: the `SystemOneDecisionHelper.evaluateDecisions` wrapper class (zero config around one map iteration) and the `ContextBudgetGuard` token estimator (a pre-flight guard against a spec that doesn't exist — the claimed HTTP-413-on-context-overflow and two-token scoring-head reservation appear in neither the official decision docs nor the OpenAPI; inventing an estimation formula for undocumented server behavior manufactures false confidence).

### Stream abort safety (STR-03 — stale defect, invariant pinned)

- The digest's claimed unhandled-rejection race is guarded at every seam: `requestStream` wires the caller signal to an `AbortController` with listener cleanup in the generator's `finally`; `parseNdjsonStream` runs under `await using disposableReader` (cancel rejections swallowed, lock released); `OllamaStream.abort()` cancels the source before rejecting `finalResult`; and `executeWithFailover` attaches `void holdUntil(stream).catch(() => undefined)` to every client-produced stream's `finalResult` **synchronously, before the stream is returned** — the internally-held promise can never surface as a process-level `unhandledRejection`. The digest's `guardedStreamReader` sketch re-implements this stack with weaker structure.
- The invariant is now pinned (BUF-01 precedent): `test/stream-abort-mid-read.test.ts` aborts a real wire stream with the next frame genuinely in flight (public mock server, 50 ms chunk delays) in both iterator and events mode — asserting the mapped `OllamaAbortError` is delivered to the consumer, zero process-level `unhandledRejection` events fire after the rejection chains settle, the endpoint slot releases (`activeRequests` back to 0 under `maxConcurrentPerEndpoint: 1`), and a follow-up request on that single-slot client completes immediately.

### System One contract refresh (score criteria 2–26 → 2–10)

- Upstream's `docs/openapi.yaml` now natively carries the System One schemas (the SDK pin previously hand-assembled them from the rendered docs) and tightens **score criteria to `maxItems: 10`** (answer scale `maximum: 9`), drops the noul criteria's hardcoded `'Yes'`/`'No'` defaults ("omitted entries use model-specific defaults"), and simplifies the model/images descriptions. The pin was hand-refreshed in its cleaned style (running `contract:fetch` verbatim would clobber its documented intentional deviations) and the contract regenerated: IR, `SystemOneScoreQuestion`/`SystemOneScoreAnswer` models + Zod schemas (`score: z.number().min(0).max(9)`), and MCP tool descriptors. Boundary tests updated (11-criteria requests now rejected client-side before the round-trip; 10-criteria accepted at the new boundary) with the upstream change date recorded.
- `decision.ts`'s score JSDoc and the README examples now say 2–10.

### Structured outputs (TYP-04 — stale, documented)

- `chatWithSchema<T>(req, zodSchema)` / `generateWithSchema<T>(req, zodSchema)` already deliver exactly what the digest asked for — inferred `T` returns, runtime validation (`OllamaToolValidationError` with Zod issues when the model's JSON drifts from the schema), and resilient extraction from markdown-fenced output — all root-exported and README-documented since the Zod waves. The digest's redesign (a `structured?: T` field on the response message, populated by a blind `JSON.parse(...) as T`) was declined: no runtime validation is precisely the unsafety the finding complains about, and injecting SDK-computed fields into wire-contract response types breaks the contract-parity discipline (ADR 0033).

## [1.17.0] — Streaming blob uploads (`duplex:'half'`, two-pass file upload), typed-array view-safety pins, tracing-header verdicts

The October 14 digest ("Raw Model Blob Ingestion Streaming Backpressure, W3C Distributed Tracing Baggage Injection, Defensive Serialization for Typed Arrays") targeted heavy binary asset streaming, operational provenance, and low-level buffer safety. Audited against the codebase first (see [ADR 0032](./docs/adr/0032-streaming-blob-uploads-tracing-verdicts-view-safety.md)): the heap-exhaustion claim was real on the blob path — `createBlobFromFile` bulk-read the whole file (`fs.readFile`) before uploading, and the `ReadableStream` member of `BinaryBody` was a promise the transport couldn't keep (Node 18+ `fetch` rejects stream bodies without `duplex: 'half'`) — though the `/api/create` framing was misdirected (its request body is a small JSON digest map, not a stream). The tracing claim was stale (client-level `headers`, per-request headers, and the middleware seam already forward any W3C headers verbatim — nothing is stripped). The typed-array claim was stale as a defect (`src/` has zero `Buffer.from` call sites; the SDK's Web APIs are view-safe by construction, and adopting the proposed `Buffer`-coupled helpers would regress the edge-runtime zero-Node-builtins gate) — but the invariant is now pinned by tests. The companion upstream-specs digest (System One batching, payload caps, `expires_at`, model warmth) was comprehensively stale — every recommendation already ships. All additive, no breaking changes. 1012 pre-existing tests stay green, 12 new tests added.

### Streaming blob uploads (MOD-01 — multi-GB GGUFs never enter the heap)

- **Transport**: both fetch call sites (middleware `finalHandler` and the direct path, previously duplicated init construction) now share one `buildFetchInit` that sets `duplex: 'half'` exactly when the body is a web `ReadableStream`. The guard is structural (`getReader` duck-typing) so cross-realm streams (workers, VM contexts) still get the member; the init type is a local `RequestInit & { duplex?: 'half' }` intersection because `@types/node` 22's `RequestInit` doesn't carry the member yet — assignable to the plain `RequestInit` `FetchLike` expects. Harmless (and spec'd) in browsers.
- **`createBlobFromStream(digest, stream, request?)`** — the multi-gigabyte-safe counterpart of `createBlobFromData`: pipes any web `ReadableStream<Uint8Array>` straight into the request body with HEAD-dedupe semantics identical to the data-based variant. The digest must be known up front — it _is_ the upload URL, and the server verifies streamed content against it, so a truncated or corrupted stream fails the upload instead of poisoning the store.
- **`createBlobFromFile` rewritten as two streaming passes** (same signature, same result shape): a SHA-256 hash pass through `node:crypto`'s incremental digest in 256 KiB chunks (skipped entirely when `opts.digest` is provided), then an upload pass piping `createReadStream` → `Readable.toWeb` into the streaming upload. Peak heap is O(chunk) in both passes; `createModelFromGguf` (which routes every shard through this method) inherits the bound. The method was already Node-only (hidden-specifier dynamic `node:fs`); the new `node:crypto`/`node:stream` imports follow the same pattern, keeping the main entry edge-portable.
- **Cancellation plumbing**: `createBlob`/`checkBlob` now accept `RequestCancellationOptions` (`signal`/`timeoutMs`) like their siblings, and `createBlobFromData`'s previously decorative `signal` option is actually wired through. Aborts surface as `OllamaAbortError` from both file passes (the hash pass checks between chunks and destroys the fd; the upload pass forwards the signal to `fetch` and destroys the stream on abort).
- New coverage pins the whole story: duplex injection (unit, injected `fetch`), byte-exact streamed uploads against a real capture server, the two-pass file flow (streaming digest matches the whole-file digest; wire bytes equal the file byte-for-byte), abort-before-traffic and abort-mid-stalled-upload, and daemonless public-mock round trips including `createModelFromGguf`'s headline flow (blob POST carries the shard, `/api/create` references it under its basename).

### Typed-array view safety (BUF-01 — stale defect, pinned invariant)

- The audit found zero `Buffer.from(view.buffer)`-style call sites: `computeBlobDigest` uses Web Crypto, which hashes a `BufferSource` view's bytes per spec, and `fetch` serializes `Uint8Array` bodies per-view. The digest's `safeUint8ArrayToBuffer`/`toUint8Array` helpers were declined — they couple a runtime-portable SDK to Node's `Buffer` and would regress the edge-runtime gate (ADR 0032).
- The invariant is now pinned by the digest's own suggested probe, hardened with an external oracle: a `subarray(10, 20)` view of a 1024-byte patterned pool hashes to the standalone slice's digest (cross-checked against `node:crypto`) and arrives on the wire as exactly its 10 bytes — never the parent buffer.
- Cleanup: `computeBlobDigest`'s misleading `data as unknown as ArrayBuffer` cast removed (the local structural `SubtleCrypto` type already accepts `ArrayBufferView`).

### Tracing headers (TRC-01 — stale, documented)

- The SDK forwards headers verbatim through three existing seams: client-level `headers` configuration (every request, every endpoint), per-request `headers` on transport request options (merged last, so they win), and middleware's mutable `RequestContext.headers` record — an OpenTelemetry-style extractor plugs in without touching a single method signature. The README's middleware section now shows the W3C `traceparent`/`tracestate`/`baggage` propagation pattern explicitly.
- The digest's `traceContext` option on every client method and ambient `AsyncLocalStorage` capture were declined (ADR 0032): signature inflation and hidden global state for capability that already exists.

### Upstream-specs digest verdicts (all stale — pointers, no new API)

- **System One batching**: `client.systemOne()` already evaluates N named questions against shared state in one round trip, with compile-time question→answer type correlation the sketch lacks. **Payload caps**: `MAX_SYSTEM_ONE_REQUEST_BYTES` (64 KiB) / `MAX_SYSTEM_ONE_IMAGES_BYTES` (32 MiB) are exported, `estimateSystemOneRequestBytes()` is the pre-flight estimator, and the runtime enforces both client-side. **`expires_at`**: typed on `ModelResponse` from `/api/ps`, returned by `client.ps()`. **Model warmth**: `pin()`/`unload()`/`KEEP_ALIVE_INDEFINITE`/per-call `keep_alive`/`warmModelAffinity()` are the supported primitives; a background `ModelWarmthKeeper` timer daemon was declined (hidden event-loop work that escapes the client-teardown contract — reasoning in ADR 0032).

## [1.16.0] — Stream observation (`observeStream`), network-error classification & context-window recommendations

The October 13 second digest ("Stream Multi-Sink Teeing, Context Window Overflow, Socket Hangup Recovery") targeted edge transport hazards and memory boundaries during high-throughput agent execution. Audited against the codebase first (see [ADR 0031](./docs/adr/0031-stream-observation-network-classification-context-recommendations.md)): the stream-teeing claim was the real gap (no observer utility existed, and `OllamaStream`'s dual modes are mutually exclusive — you couldn't tap a stream you were iterating); the context-overflow claim was comprehensively stale (a superior CJK-aware estimator with three-tier window resolution, `onContextOverflow` policies, and `getContextLength()` discovery has shipped since the v1.9.0 era — only its concrete-window suggestion was missing); and the socket-retry claim was inverted on the headline (every SDK-routed call already retries with backoff _and_ fails over — three retries where the digest asked for one) but real in one seam: network-error classification was `TypeError`-only, so code-carrying socket errors from custom `fetch` implementations and nested undici `cause` chains died un-retried on first attempt. All additive, no breaking changes. 977 pre-existing tests stay green, 35 new tests added.

### Zero-copy stream observation (`observeStream`)

- **`observeStream(source, callbacks)`** — the safe multi-sink alternative to `ReadableStream.tee()`: one queue, no forked branch, no shared backpressure. Tap any `AsyncIterable` (streaming `chat`/`generate` streams, NDJSON chunk iterables, your own sources) for audit logging, token counting, or telemetry while the primary consumer iterates it.
- The contract is one-sided in favor of the primary consumer: observers **never block** (a serialized microtask chain — sync observers pay one hop, async observers run strictly FIFO with concurrency of exactly one, so a slow logger throttles only its own tail), **never fail the stream** (sync throws and async rejections route to `onListenerError` with the phase they came from — never unhandled rejections, never pipeline poisoning; a failing `onListenerError` is swallowed the same way), and **stay ordered** (`onDone` is enqueued only after the last chunk's observer settles, so an audit log has seen every chunk before its "done" marker).
- **Full lifecycle**: `onDone` on natural completion; `onError` + rethrow on source failure (the observer is transparent, not a circuit breaker); `onAbandon` when the consumer breaks early — firing after the iterator-close protocol has already closed the source. The digest's sketch (`void onChunk(chunk)`, no early-exit hook, fire-and-forget async observers) had exactly these three defects; the semantics are documented in ADR 0031 and pinned by adversarial tests (deferred resolution out of order, a never-resolving sink, `process`-level unhandled-rejection capture).
- Exported from the root entry alongside the rest of the streaming toolkit — a `./stream` subpath for a single function was declined (subpaths are reserved for distinct runtimes/concerns like `./testing` and `./mcp/*`).

### Network-error classification (stale-socket recovery for every `fetch` shape)

- `mapError` now recognizes socket/connection-level failures **structurally**: any error carrying a `code` from the exported `NETWORK_ERROR_CODES` set (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `ETIMEDOUT`, `EAI_AGAIN`, `UND_ERR_SOCKET`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `UND_ERR_CLOSED`, …), including codes nested in `cause` chains (bounded depth, cycle-safe), maps to retryable + failover-eligible `OllamaNetworkError`. Previously only WHATWG `fetch`'s `TypeError` wrapper was classified — a custom `fetch` implementation built on `node:http` (whose `ECONNRESET` is a plain `Error` with a `code`) failed outright on first attempt with no retry and no failover. The digest's `String(err).includes(...)` matching was declined: message wording isn't a contract, `error.code` is.
- Two deliberate exclusions, both tested: `UND_ERR_ABORTED` stays an abort (retrying it would re-dispatch a request the caller explicitly cancelled), and non-transport codes like `EACCES` stay non-retryable.
- New e2e coverage pins the daemon-restart story end-to-end: a real `node:http` server that destroys the socket on first request per path — `list()` and `ps()` recover via re-dispatch and the caller never sees the reset; an injected `fetch` rejecting once with a raw `ECONNRESET` code retries exactly once and succeeds.
- The digest's "pre-flight health validation on stale sockets" was declined (undici owns the pool with no staleness introspection; the failed request is the cheapest detector) and its per-method idempotency gating was declined (the retry window is pre-response; mid-stream failures are never auto-retried) — reasoning in ADR 0031.

### Context-window recommendations (the one nugget in a stale claim)

- `ContextCheck` gains `recommendedNumCtx` — present exactly when the threshold is exceeded — computed by the new exported `recommendContextWindow(estimatedTokens)`: the smallest power-of-two window covering `estimate × 1.3`, floored at 4096, via an exact doubling loop (float `Math.log2` of exact powers of two can round a perfect fit up a whole power of two). The pre-flight warning now names the concrete window **with the native-ceiling caveat** — verify the model's maximum via `client.models.getContextLength()` before adopting it, because a prompt that outgrows the native maximum needs compaction, not a bigger `num_ctx`.
- Non-finite/non-positive inputs degrade to the 4096 floor rather than throwing: the function is advisory, invoked after the caller's own estimate already flagged a problem.

## [1.15.0] — Draft benchmark utility & request-aware mock routes: `compareDraftPerformance`, mock `responder`

The October 13 digest ("Speculative Performance & Telemetry Observations") reviewed how upstream reports speculative efficiency — no dedicated draft-token acceptance counter, throughput-only observability, a noisy signal (rejected drafts _add_ compute on creative prompts; accepted drafts slash `eval_duration` on structured ones) — and asked for a benchmark helper plus mock scenario hooks. Audited against the codebase first (see [ADR 0030](./docs/adr/0030-draft-benchmark-request-aware-mock-routes.md)): the "manual nanosecond ratios" claim was partially stale — `formatTelemetry` derives tokens/second since v1.12.0 and `lab/15` implements the full protocol, but neither reaches npm consumers (`files` publishes only `dist/`), so the packaged-harness gap was real. The mock scenario claims were stale: parallel tool calls in one frame, malformed-argument tool calls (string `arguments`), in-band mid-stream error injection, and 503 bodies all shipped in v1.14.0. The genuine engine gap the audit surfaced: routes couldn't vary responses **per request**. All additive, no breaking changes. 960 pre-existing tests stay green, 17 new tests added.

### Speculative draft benchmark (`compareDraftPerformance`)

- **`compareDraftPerformance(client, options)`** — the deterministic A/B for "does `draft_num_predict` pay off for _this_ prompt": identical prompt on both sides, `temperature: 0` forced + a fixed `seed` (default 42), one warm-up generation per setting (pays the model load), `samples` measured runs per side (default 5) with the **median** compared — single samples mislead. Throughput flows through `formatTelemetry` (the official Usage-doc math; never hand-rolled nanosecond division).
- Result: `baselineTokensPerSec` / `speculativeTokensPerSec` (1dp), `speedupMultiplier` (2dp, computed from the two reported medians so the numbers are self-consistent), `effectiveGain` (`> gainThreshold`, default 1.05), plus full per-side `DraftRunStats` (every sample, medians).
- **Structural dependency** — accepts any `DraftBenchmarkClient` (`{ generate }` with the non-streaming signature); `OllamaClient` satisfies it without being named, and tests can pass a plain object. A `client.benchmark` namespace was deliberately not added, and the digest's `SpeculativeBenchmarkRunner` class was folded into the function — rationale in ADR 0030.
- Guarded: `RangeError` on invalid numeric options; non-positive/unusable samples are skipped, and a side with **no** valid samples throws `OllamaClientError` (`draft_benchmark_no_valid_samples`) instead of fabricating a zero/Infinity speedup; the abort signal is checked between runs and forwarded to every call.
- The no-draft-network reading is documented on the utility and in the README: a ≈1.0 speedup means the model has no draft network (and no embedded MTP tensors) — the server silently ignores the option.

### Request-aware mock routes (`responder`)

- `MockEndpointOptions` now accepts `responder(record) => MockRouteResponse | undefined` — per-request responses computed from the recorded method/path/body. Returning `undefined` falls back to the route's static fields, so fail-twice-then-succeed retry drills, body-dependent payloads (e.g. draft-setting-aware frames), and call-count scenarios are closure-local one-liners on the same engine — no subclassing, no one-shot global scenario queue. The digest's `ScenarioMockOllamaServer` sketch was declined for exactly that reason (it forks the request path ADR 0029 protects; see ADR 0030).
- The emission pipeline is shared: `chunkDelayMs`, `injectErrorFrame`, `dropConnectionMidStream`, and `rawBody` all keep their semantics inside responder routes; request recording and `onRequest` still fire.
- Type-level: the response fields moved to a new `MockRouteResponse` interface that `MockEndpointOptions` extends — pure refactor, existing routes unaffected. `MockRouteResponse` is exported from the `/testing` subpath.
- The SDK's own benchmark tests run daemonless through responder routes (draft-aware `/api/generate` frames) — the exact consumer CI pattern the digest's downstream stories describe, exercising the public engine rather than test-only fixtures.

## [1.14.0] — Speculative-decoding model assembly & the public testing subpath: `draftGguf`, `draft_num_predict` docs, `@nemesis-oss/ollama-sdk/testing`

The October 12 digest ("Speculative Decoding & Draft Model Creation") reviewed the official model-creation surfaces — `draft_files` + `draft_quantize` on `POST /api/create`, the `draft_num_predict` Modelfile parameter and runtime option — and asked for an exportable zero-network mock server. Audited against the codebase first (see [ADR 0029](./docs/adr/0029-public-testing-subpath-speculative-draft-conveniences.md)): the digest's headline typing claims were stale — `draft_files`/`draft_quantize` already shipped on both the generated `CreateRequest` and the hand-written `CreateRequestOptions` (official OpenAPI, 2026-10-07 pin), and `draft_num_predict` was already typed + documented on the runtime `ModelOptions`; the "DRAFT `<model>`" Modelfile instruction the digest describes is not in the current official docs (only the parameter is). The real gaps — a path-based draft upload convenience, wire tests, discoverable documentation, and the not-exported mock server — are closed here. All additive, no breaking changes. 932 pre-existing tests stay green, 28 new tests added.

### Speculative model assembly (`createModelFromGguf` → `draftGguf`)

- **`CreateModelFromGgufOptions.draftGguf`**: pass the draft network's GGUF path(s) alongside the primary shards — each is uploaded as a blob and assembled into `draft_files` under its basename, the same protocol as primary shards. Split draft GGUFs, explicit `draft_files` digest maps (merged; path uploads win on basename collision), and `draft_quantize` passthrough all work; no draft → no `draft_files` key on the wire at all.
- **Discoverable speculative-decoding docs**: `CreateRequestOptions.parameters` now documents `draft_num_predict` (separate draft models default to 4; `0` disables drafting; embedded MTP tensors require setting it explicitly — official Modelfile reference), and `draft_files`/`draft_quantize` carry the speculative-decoding context with the verification-semantics note that makes aggressive draft compression safe.
- Wire tests pin the whole contract: `createModel` round-trips `draft_files` + `draft_quantize` + `parameters.draft_num_predict`; `createModelFromGguf` uploads draft blobs separately (HEAD + POST per shard) and never leaks `draftGguf` or empty maps into the request body.

### Public testing subpath (`@nemesis-oss/ollama-sdk/testing`)

- The SDK's internal mock engine is **promoted, not forked** (ADR 0029, same discipline as ADRs 0027/0028): `test/mocks/ollama-mock-server.ts` is now a re-export shim, so the SDK's own suite exercises exactly the code consumers import.
- **`createMockOllamaServer(options?)`** — the recommended factory. Built-in **default routes** answer the official liveness probe (`HEAD /` → 200, `GET /` → the plain-text body "Ollama is running" byte-for-byte) and `GET /api/version` (configurable version, default `0.14.0`), so `client.ping()` works against a fresh mock with zero setup. `defaultRoutes: false` restores bare 404s; `register()` always wins over the defaults.
- **Request recording** — `server.requests` captures every request (method, path, parsed body, timestamp), including default-route hits and 404s; `clearRequests()` for `beforeEach` hooks. Wire-level assertions without per-route callbacks.
- **In-band mid-stream error injection** — `injectErrorFrame: { message, after? }` emits an `{"error": "..."}` NDJSON frame while HTTP stays 200, exactly how a real daemon reports GPU OOM/driver crashes mid-generation. The default injection point is `chunks.length - 1`: every content chunk, then the error frame, with the final `done` frame never emitted — an error frame after `done` would be unread (the stream has already completed cleanly). `after: 0` errors before any content; explicit larger values move the position. The SDK's stream readers raise `OllamaStreamError` with the partial content.
- **`rawBody`** route option for exact non-NDJSON bodies (the liveness body uses it — no trailing newline).
- **Chunk builders** producing correctly-shaped `/api/chat` frames: `mockChatChunk` (one frame, counter defaults on the done frame for telemetry paths), `mockTextChunks` (chunked text + done frame), and `mockToolCallChunks` — parallel tool calls in one frame, the documented native shape, followed by the done frame.
- **Packaging**: dedicated `./testing` entry in the exports map (paired `.d.ts`/`.d.cts`), a new tsup entry, and the consumer-type verification now compiles a real CJS (node16) **and** ESM (nodenext) consumer importing the subpath. Node.js-only by design (`node:http`) — never imported from the Edge-safe main entry, so `verify:edge-runtime` stays clean.

### Lab

- `lab/15-speculative-draft/measure-draft-speedup.ts`: live harness comparing `draft_num_predict` 0/4/8/16 — warm-up per setting, 5 samples each, median `tokensPerSecond` via `formatTelemetry`, and a speedup table against drafting-disabled. Makes "the server has no draft network, the option is being ignored" obvious at a glance.

## [1.13.0] — docs.ollama.com re-audit: parity verifier reads checkbox state, strict compat types, web-search agent tools

A full re-read of docs.ollama.com (API reference, capability guides, integrations, OpenAPI spec) against the SDK. The native API was already at parity except for two upstream changes; the real defect was in the compatibility-parity tooling, which had been reporting fields Ollama documents as unsupported as "supported".

### Fixed

- **Contract-parity verifier ignored `[ ]` (unsupported) checkboxes.** `verify:contract-parity` fetched the rendered HTML docs, which drop checkbox state, and the pinned fallback had been rewritten to `[Input]` markers — so every listed field read as supported and the OpenAI overlay claimed support for `tool_choice`, `logit_bias`, `user`, `n` and logprobs (chat), `best_of`, `echo`, `logit_bias`, `user`, `n` and logprobs (completions), `user` (embeddings) and `truncation` (responses). The fetcher now prefers the Mintlify markdown twin (`<page>.md`), endpoint sections are bounded by heading level (backticked headings supported), unchecked feature items (`* [ ] Logprobs`) read as unsupported, and unchecked request-field items count as explicit unsupported evidence. The overlay and IR are corrected (`logprobs` capability is now `unsupported` on `/v1/chat/completions` and `/v1/completions`), and the pinned fallbacks are re-pinned from the live markdown with checkbox state intact.
- **Strict compatibility request types now exclude documented-unsupported fields.** `OllamaOpenAIChatCompletionRequest` drops `tool_choice`, `logit_bias`, `user`, `n`, `logprobs`, `top_logprobs`; `OllamaOpenAICompletionRequest` drops `best_of`, `echo`, `logit_bias`, `user`, `n`, `logprobs`; `OllamaOpenAIEmbeddingRequest` drops `user` and narrows `input` to `string | string[]`; `OllamaOpenAIResponsesRequest` also drops `truncation`. Passing them is now a compile error (pinned by `@ts-expect-error` tests run under `npm run typecheck`). **Type-level breaking change only for code that opted into the strict types** — the broad `OpenAI*` interop types are unchanged.

### Upstream API changes picked up

- **System One `choice` criteria limit raised from 26 to 255** (model-dependent) — generated Zod schema and request type updated; `score` stays at 2–26.
- **`/api/copy` documents a JSON `{ "status": "success" }` body** plus 400/404 error responses — the generated `NativeApi.copy()` now returns `StatusResponse` instead of `unknown`.

### Added

- **`createWebTools(client, options?)`** (plus `createWebSearchTool`, `createWebFetchTool`, `formatWebSearchResult`, `formatWebFetchResult`): Ollama Cloud web search/fetch as model-callable `web_search`/`web_fetch` tools for `ToolRegistry`/`Agent` — the documented "Building a search agent" pattern. Arguments are validated at the registry boundary (`query`/`url` non-empty, `max_results` 1–10) before any network call; the abort signal propagates; output is bounded by `maxOutputChars` (default `2000 * 4`, as in the docs) by trimming content fields so it always stays valid JSON; `web_fetch` caps links (`maxLinks`, default 25). New example: `examples/web-search-agent.ts`.
- Tests for direct Ollama Cloud access through the bridges (`https://ollama.com/v1/chat/completions`, `/v1/responses`, `/v1/messages` with `Authorization: Bearer` and `anthropic-version: 2023-06-01`), docs-parser regression tests against the pinned markdown, and strict-type compile tests.

- **Strict chat images are base64-only.** `OllamaOpenAIChatContentPart.image_url` is now `` `data:${string}` `` (string or `{ url, detail? }`), so a remote `http(s)://` image URL — documented as unsupported on `/v1/chat/completions` — is a compile error. `OllamaOpenAIChatMessage`, `OllamaOpenAIChatContentPart`, and `OllamaOpenAIImageDataUrl` are now exported from the package root.
- OpenAPI source descriptions synced with upstream (System One `noul`/`score` criteria, `UsageResponse.granularity`). The one remaining intentional deviation — nullable `ModelSummary.details.families`, because the server serializes a nil slice as `null` — is documented in the source header and pinned by a test.

### Documentation

- README and docs-site OpenAI/Anthropic guides: per-endpoint supported vs documented-unsupported tables, direct cloud access sections, and a web search agent section.

## [1.12.1] — Fix: model-affinity routing respects priority tiers

### Fixed

- **`endpointHealth.modelAffinity` no longer overrides endpoint `priority`.** In 1.12.0, `ModelAffinityRouter.reorder()` moved every host holding the requested model to the front of the _whole_ candidate list, so a lower-priority host with the model in VRAM was tried before a higher-priority host without it. That contradicted the README and ADR 0028, which state that priority tiers keep working. Affinity now reorders only within each priority tier (runs of consecutive equal `priority`, unset = `0`, as in the registry): a higher-priority endpoint is always tried first, and residency only breaks ties inside a tier. The order between tiers, including the registry's fail-open recovery order, is unchanged.
- **Behavior change for configurations that mix `priority` values with `modelAffinity`:** requests that 1.12.0 sent to a resident lower-priority host now go to the higher-priority host first. Pools where every endpoint has the same priority (the documented fleet-of-workstations setup) are unaffected.
- 6 new tests: tier isolation, independent per-tier reordering, unset priority as `0`, consecutive-run grouping, an unchanged input returned as-is, and an end-to-end `OllamaClient` routing check.
- `package-lock.json` root version corrected (it still read `1.8.0`).

## [1.12.0] — Daemon liveness & telemetry standardization: formatTelemetry, dynamic host model-affinity routing, root ping

The October 10 documentation digest ("Daemon Liveness & Telemetry Standardization") reviewed the official operational surfaces — the root liveness probe (`HEAD /` → 200, body "Ollama is running"), `GET /api/version`, `GET /api/ps` runner introspection, and the nanosecond duration counters on every generation response. Verified against the codebase first (see [ADR 0028](./docs/adr/0028-telemetry-normalization-host-affinity-root-ping.md)): two of the digest's gap assessments were stale — multi-host pooling with least-connections routing, capacity caps, and 503/`OLLAMA_MAX_QUEUE` saturation failover already exist (`endpoints` + `endpointHealth` + `DEFAULT_FAILOVER_CODES`), so the proposed `LoadBalancedOllamaClient` was **not** added (it would fork the existing routing engine); the real gaps — telemetry math, dynamic multi-host affinity, and the root ping — are implemented, all additive, no breaking changes. 865 pre-existing tests stay green, 33 new tests added.

### Standardized telemetry normalizer (`formatTelemetry`, `src/telemetry/metrics.ts`)

- **`formatTelemetry(raw)`** derives the human-scale summary from Ollama's raw nanosecond/token counters: `totalLatencyMs`, `modelLoadMs`, `promptEvalMs`, `generationMs` (ns→ms, 2 decimals), `tokensPerSecond` (`eval_count / (eval_duration / 1e9)` — the official Usage-doc formula), `promptTokensPerSecond`, and `cacheHitRatio` — pure, never throws, missing counters read as `0` (never `NaN`/`Infinity`, so partial payloads like stream final events and older servers format cleanly).
- The input is **structural**: any response object carrying the optional counters — `ChatResponse`, `GenerateResponse`, the final `GenerateStreamEvent`, `EmbedResponse` — passes as-is, no plucking. Purity and structural acceptance are pinned by tests with real response objects (no casts).
- **`cacheHitRatio` deliberately deviates from the digest's sketch**: `cached / (cached + evaluated)`, not `cached / prompt_eval_count` — Ollama reports `prompt_eval_count: 0` on a _full_ cache hit, so the digest's formula divides by zero and reads a perfect cache as "no caching". The sum denominator is the SDK's established `ConversationSession.cacheStats.hitRate` semantics; the two surfaces now share documented, tested math.

### Dynamic host model-affinity routing (`endpointHealth.modelAffinity` + `ModelAffinityRouter`)

- The digest's "tomorrow's focus" item, shipped: with several interchangeable endpoints, **opt-in** `endpointHealth: { modelAffinity: { ttlMs?, failureRetryMs? } }` reorders each request's candidate endpoints so hosts whose `GET /api/ps` shows the requested model already resident in VRAM are tried first — avoiding the unload/cold-load swap a miss forces on `OLLAMA_MAX_LOADED_MODELS`-bounded daemons. The multi-host counterpart of `ModelAffinityScheduler` (v1.11.0); the two compose.
- **Zero added request latency**: reordering is synchronous and cache-only — a request never waits for a probe. On a cache miss the request proceeds with the unchanged order while a background refresh (TTL 30s default, deduped, 5s failure backoff) warms the cache. `client.warmModelAffinity()` pre-warms at startup; `client.modelAffinityStatus()` exposes per-endpoint snapshots (loaded models, fetch time, freshness) for observability.
- **Partial knowledge suppresses the reorder** — if any candidate's snapshot is stale or unknown, the original order stands (routing on partial residency data risks the exact cold-load swap the feature prevents). Probe failures are never cached as data; probes bypass `executeWithFailover` entirely (no reentry, no circuit-breaker pollution, no cross-host failover — the answer is per-host by definition).
- **Race-free with `'least-connections'`**: no `await` between candidate selection, the reorder, and the endpoint's `acquire()` — the strategy's deterministic one-per-account guarantee is untouched; priority tiers, capacity caps, `models`-scoped credentials, and single-endpoint pinning all keep working.
- **Matching is shared, not duplicated**: "resident" uses the same matcher as context-window discovery (`isModelResident`, refactored out of `findRunningModelContextLength` — exact `name`/`model` match or tag-less prefix `llama3` ↔ `llama3:latest`, never `llama` → `llama3.1`). Off unless configured: without `modelAffinity` the router isn't constructed and no `/api/ps` probes are ever issued.

### Root liveness probe (`client.ping()`)

- The official ultra-lightweight liveness check: `HEAD /` against the current best candidate endpoint, resolving `{ healthy, latencyMs, baseUrl, error? }` — the docs define this exact probe for load-balancer health checks (`GET /` answers the plain-text body "Ollama is running"; HEAD doesn't transfer it).
- **Single-shot by design** — no retry, no failover: a liveness probe's value is that it answers about _one concrete host_, not "some endpoint eventually answered". Fleet audits remain `healthCheck()`'s job (every endpoint, plus the version via the heavier `GET /api/version`). Resolves rather than throws on connection failure/timeout/error status (monitoring loops treat it as a datapoint); only caller-initiated cancellation (`signal`, `destroy()`) rejects, like any other aborted request. Uses the client's `fetch`/middleware/lifecycle pipeline like every other request.

### Documentation

- README: three Key Features bullets; a "Standardized Telemetry" section (before OpenTelemetry, which it complements); a "Model-affinity routing across hosts" subsection in the Multi-Endpoint guide (with the `warmModelAffinity`/`modelAffinityStatus` flow); `ping()` in the health-check intro. ADR 0028 records the audit verdicts, the declined `LoadBalancedOllamaClient` fork, and the `cacheHitRatio` deviation rationale.
- New examples: `examples/telemetry.ts` and `examples/multi-host-affinity.ts`.

## [1.11.0] — Documentation digest + production-readiness audit: context discovery, compaction, affinity scheduling, agent cycle detection, URL-join hardening, vision-history hygiene

Three real gaps from the follow-up documentation digest on concurrency & memory-scaling mechanics (see [ADR 0026](./docs/adr/0026-context-discovery-history-compaction-model-affinity.md)) and three verified findings from the October 9 production-readiness audit on agent-loop ergonomics, transport hardening, and multi-turn memory retention (see [ADR 0027](./docs/adr/0027-agent-cycle-detection-url-join-history-hygiene.md)) — all additive, no breaking changes; 778 pre-existing tests stay green, 87 new tests added (40 digest + 47 audit). Stale claims in both reports were verified against the codebase and answered with documentation and tests instead of new code (one digest claim, two audit claims).

### Dynamic context-window discovery (`src/context-discovery.ts` + `models.getContextLength()`)

- **`client.models.getContextLength({ model, skipRunningCheck?, signal?, timeoutMs? })`** resolves the real window instead of 2048/4096 guesswork, by precedence: the **allocated window of the running instance** (`GET /api/ps` `context_length` — exact, reflects the Modelfile default and what fit in memory) → the **Modelfile `num_ctx` default** (`POST /api/show` `parameters`) → the **native GGUF maximum** (`model_info["<arch>.context_length"]` — a ceiling, not an expectation; the official API examples show 131072 native vs 4096 allocated) → the conservative 2048 fallback.
- Returns every signal it found — `{ contextLength, source, runningContextLength?, parameterContextLength?, nativeContextLength? }` — so "how much headroom could I raise" and "what do I have right now" are both answered. Tag-less model names match their tagged `/api/ps` entries the way Ollama itself resolves them; a 404 from `/api/ps` degrades to the `/api/show` signals instead of failing.
- Pure pieces exported for callers holding raw responses: `resolveContextLength`, `extractParameterNumCtx`, `findRunningModelContextLength`, `extractNativeContextLength` (the existing capabilities scanner, now public). `ps()` also gained optional `{ signal, timeoutMs }` cancellation; `client.getContextLength` mirrors the models method.

### Sliding-window conversation compaction (`compactConversationHistory` + `session.compact()`)

- **`compactConversationHistory(messages, { maxEstimatedTokens, reserveForReply?, minTailMessages? })`** — pure helper keeping the leading system message(s) plus the newest turns that fit, dropping the oldest in between. Estimates via the same CJK-aware heuristic as the pre-flight checks (message overhead, `tool_calls`, `IMAGE_TOKEN_ESTIMATE` per image included); `minTailMessages` (default 2) guarantees the newest exchange survives even when oversized — the SDK never reproduces the server's silent truncation.
- **`session.compact(options?)`** applies it in place, defaulting the budget to the session's `num_ctx` (or the 2048 fallback) minus a 10% reply reservation, and returns `{ droppedMessages, estimatedTokensBefore, estimatedTokensAfter, effectiveBudget }`. Cumulative cache tallies are deliberately never reset — the one-turn `evaluatedTokens` spike after compaction is the visible cost of the KV-prefix invalidation, and compaction stays **manual, never automatic** (see ADR 0026 for the tradeoff).

### Model-affinity scheduling (`src/affinity.ts` + `ModelAffinityScheduler`)

- Groups async work into **per-model serial queues** with a **distinct-model cap** (`concurrentModels`, default 1) and **per-model parallelism** (`perModelConcurrency`, default 1 — mirror `OLLAMA_NUM_PARALLEL`). Dispatch is **affinity-sticky**: a queued model that is already active deepens before the next model loads, because deepening avoids an unload/cold-load swap — the anti-thrashing order for `OLLAMA_MAX_LOADED_MODELS`-bounded daemons.
- **Candidate lists** — `run(['a', 'b'], (model) => …)` picks whichever candidate is already loaded per a TTL-cached `GET /api/ps` (default 30s); single-model tasks never touch `/api/ps`, and a failing lookup degrades to the first candidate without caching the failure.
- Tasks are caller-owned (no retry/timeout/failover injected); a rejected task rejects only its own `run()`. `stats` exposes `{ activeModels, queuedTasks }`; `dispose()` resolves once every queue drains; invalid options and candidate lists fail fast with `OllamaClientError`.

### Capacity-planning documentation

- New README section mapping the official FAQ's server knobs — `OLLAMA_NUM_PARALLEL` (KV memory scales `NUM_PARALLEL × CONTEXT_LENGTH`), `OLLAMA_MAX_LOADED_MODELS` (3× GPUs), `OLLAMA_MAX_QUEUE` (512 → 503s), `num_ctx` — to their client-side counterparts (`endpointHealth.maxConcurrentPerEndpoint`, `embedBatch`, `ModelAffinityScheduler`, `ToolRegistry.maxConcurrency`, `getContextLength` + pre-flight + compaction), with a note on `OLLAMA_KV_CACHE_TYPE`. One audit-digest claim was stale and is documented as already-covered instead: the SDK's request path has capped and queued per endpoint since `endpointHealth` landed — `maxConcurrentRequests`-style pooling exists as `maxConcurrentPerEndpoint`.

### Agent cycle detection (`Agent` `maxRepeatedToolCalls`) — AGN-01

- Audit verification first: `Agent` was already a boundary-checked runner — `maxIterations` (default 10) with `OllamaAgentMaxIterationsError`, opt-in `maxToolCalls`, and registry-side encapsulation of every tool failure (unregistered names, argument-validation failures, timeouts, thrown errors) as failed `ToolExecutionResult`s fed back as `role: 'tool'` messages — the loop never crashes on a rejection. The real gap: a _stuck_ model (re-emitting one identical call, ignoring its own results) was indistinguishable from a slow one and burned the whole iteration budget with a generic error.
- **`AgentConfig.maxRepeatedToolCalls`** (opt-in, like `maxToolCalls`): a per-signature execution budget. Identity is the **canonical signature** — `canonicalToolCallSignature()` (newly exported) renders `name(args)` with recursively key-sorted arguments, so key reordering never splits one repeated call into several, while progressing calls (different arguments) never trip. Failed, unregistered, and timed-out executions count: re-calling a failing tool with unchanged arguments is exactly the loop this catches.
- Enforcement is batch-preflight, mirroring `maxToolCalls`: checked before the batch executes and before `onToolCallStart` fires (hook pairing stays consistent; duplicate calls within one batch see each other). Exceeding the budget throws **`OllamaAgentToolLoopError`** (`code: 'agent_tool_loop_detected'`, never retryable) with `toolName`, `repeatedExecutions`, `maxRepeatedToolCalls`, and the canonical `signature` truncated at 200 chars — a fail-fast diagnosis at turn N+1 instead of a generic burnout at `maxIterations`.
- 19 new tests: signature canonicalization (key-order invariance, array-order significance), off-by-default behavior preserved, fail-fast economics (3 model turns instead of 10), distinct-argument progression, within-batch duplicates, failed/unregistered executions counting, hook pairing, error hierarchy and truncation, `RangeError` validation — plus the audit's checklist item: an **end-to-end mock-server test** proving an unregistered tool name is encapsulated as a failed tool result, fed back to the model, and the run converges.

### Reverse-proxy subpath hardening (`src/transport/url.ts`) — URL-01

- Audit verification first: the claimed `new URL(path, base)` dispatch never existed — `HttpClient` always concatenated `baseUrl + path` and `normalizeBaseUrl` always preserved mount prefixes (unit-tested since the failover work). The real gaps: the exactly-one-slash join invariant was implicit (a future path without its leading slash would silently produce `hostapi/chat`), and nothing proved gateway subpaths end-to-end on the wire.
- **`joinUrlPath(baseUrl, path)`** now owns the join for all three `HttpClient` request methods (`request`, `requestSseStream`, `requestStream`): collapses trailing/leading slashes, joins with exactly one slash, preserves query strings — byte-identical output for every well-formed input, hardened against malformed ones. The module documents the WHY at the point of use: WHATWG `new URL('/api/chat', 'https://gw/ai/ollama')` discards the `/ai/ollama` mount; the SDK never constructs request URLs that way.
- 16 new tests pin the behavior at three levels — `joinUrlPath` units (including the audit's exact `https://gateway.internal.corp/ai/ollama` scenario and a WHATWG-hazard regression test), `HttpClient` transport URLs (incl. query-string paths and `requestStream`), and end-to-end `OllamaClient` wire URLs for `/api/chat`, `/api/generate`, OpenAI-compat `/v1/chat/completions`, and scheme-less subpath hosts (`proxy.internal:8080/ollama/`). README gained a "Hosting Behind a Reverse Proxy" section.

### Vision-history image eviction (`sanitizeHistoryForNextTurn`) — CTX-01

- Audit verification first: every mutation claim was false — `Agent` copies `input.messages`, `ConversationSession` freezes and copies on read, `client.chat` maps encoded messages into new arrays, `withEncodedMessageImages` is allocation-free on passthrough. The real gap: consumer-managed vision histories had no way to evict stale image payloads, and `/api/chat` is stateless — every prior base64 image is re-sent and re-billed (context tokens, upload bytes, heap) on every turn, forever.
- **`sanitizeHistoryForNextTurn(messages, { keepImagesOnLastMessages?, imagePlaceholder? })`** — pure helper returning a copy with `images` evicted outside a trailing keep-window (default 1: the rolling one-image window), conversation text fully preserved, optional placeholder note so the model can tell an image used to exist. Input arrays never mutated; untouched and kept messages reused by reference.
- Same philosophy as compaction (ADR 0026): **caller-initiated, never automatic**, because the tradeoffs are workload-specific — the model loses access to evicted images, and eviction invalidates the KV prompt prefix from that point. 12 new tests: default eviction + text preservation, purity and reference-stability, keep-windows (0/N/negative clamp), placeholder behavior (incl. empty content), empty-`images` and `Uint8Array` passthrough, and a wire-level proof that a sanitized history sent through `client.chat` carries no stale base64 while the trailing image survives.

## [1.10.0] — Production-readiness audit: batched embedding pipeline, client teardown, type-declaration hardening

Three findings from the daily production-readiness audit (see [ADR 0025](./docs/adr/0025-embedding-batching-client-teardown-declaration-portability.md)) — all additive, no breaking changes; 749 pre-existing tests stay green, 29 new tests added.

### Batch-constrained embedding pipeline (`src/embed-batch.ts` + `client.embedBatch()`) — EMB-01

- **`client.embedBatch({ model, input, batchSize?, concurrency?, … })`** for high-volume RAG/vector ingestion: splits any corpus into bounded `/api/embed` batches (defaults: 32 inputs × 3 in flight) instead of `Promise.all` floods that OOM local daemons, contend sockets, and saturate `OLLAMA_MAX_QUEUE` (503s).
- **Order-preserving** — `embeddings[i]` always corresponds to `input[i]` regardless of batch completion order; safe to zip straight into a vector store.
- **Fail-fast** — the first batch error aborts its in-flight siblings (each still riding the client's full failover/retry/auth/telemetry pipeline) and rejects the whole operation with the _original_ error, so a half-indexed corpus never looks like success. Caller `signal` cancels queued and in-flight batches alike (`code: 'aborted'`).
- **Per-string context-window pre-flight** — Ollama _silently truncates_ embedding inputs longer than `num_ctx`; `embedBatch()` injects `defaultContextLength` as `num_ctx` and warns (or throws under `onContextOverflow: 'throw'`) with the offending indexes _before_ any request is sent. No margin, unlike chat/generate: an embedding prompt is the whole input.
- `onBatchComplete(done, total)` progress callback; `truncate`/`dimensions`/`keep_alive`/`options`/`timeoutMs` pass through per batch; new exports `batchEmbed`, `findOversizedEmbedInputs`, `embedBatchOverflowMessage`, `DEFAULT_EMBED_BATCH_SIZE`, `DEFAULT_EMBED_CONCURRENCY` + types.

### Client teardown — `OllamaClient.destroy(reason)` — THD-01

- One call aborts **every in-flight request, active stream, and queued capacity waiter** with `OllamaAbortError` (`code: 'aborted'`, message = `reason`) — the clean-exit path for `node:worker_threads`, CLI runners, and short-lived processes where dangling fetch bodies and unconsumed stream readers keep the event loop alive.
- Streams reject their `finalResult` and release their `maxConcurrentPerEndpoint` slots via the existing `holdUntil` release path; scopes deregister the moment their work settles, so `destroy()` can tear down a stream mid-consumption but never outlives finished work.
- Idempotent (repeat calls return `0`) and a drain, not a disable — the client stays usable afterward. Returns the number of aborted operations. Covers every surface that goes through `executeWithFailover`/`executeCloudRequest`: chat/generate/embed (+Batch), models, responses bridge, sessions, agent, usage/balance, web tools.

### Type-declaration portability hardening — TYP-03

- Verified (not just assumed) the dual-packaging story: `@arethetypeswrong/cli` reports zero problems across node10/node16-CJS/node16-ESM/bundler for every entry point, and the exports map already maps `import → .d.ts` / `require → .d.cts` per subpath.
- **New `scripts/verify-consumer-types.sh`** (also in CI and `verify:release`): compiles two _real_ consumer projects against the packed tarball — a CommonJS consumer under `--module node16` (the `require` condition, exactly the TS1479 "masquerading ESM types" scenario) and an ESM consumer under `--module nodenext`.
- **Fixed a real leak it caught**: `VisionInput` included Node's `Buffer` global, so strict consumers without `@types/node` could not compile against our declarations. Now `string | Uint8Array` — Node Buffers are `Uint8Array` subclasses and remain fully accepted (13 vision tests untouched and green) — the published declarations are free of Node ambient globals.

## [1.9.0] — Digest upgrades: vision resolver, dual-mode Responses bridge, KV-cache sessions, context safety, blob publishing, cloud usage & balance

Five upgrades closing the gaps surfaced by the official Ollama documentation review (see [ADR 0024](./docs/adr/0024-digest-upgrades-vision-responses-sessions-context-blobs.md)) — plus a second-pass recheck against the current official docs (see the last section) that added the Ollama Cloud account endpoints and a missing `/api/create` field. All additive — no breaking changes; 689 pre-existing tests stay green, 60 new tests added.

### Universal vision asset resolver (`src/vision.ts`)

- **`VisionInput = string | Buffer | Uint8Array`** accepted anywhere `images` is (`Message.images`, `generate()`), implementing the official SDK vision convention: SDKs accept polymorphic sources; the REST API strictly requires raw base64 strings.
- String resolution order: `data:image/...;base64,` data URIs (header stripped) → `http(s)://` URLs (fetched via global `fetch`, abortable through the request's `signal`) → image-extension file paths (`.png`/`.jpg`/`.webp`/…, read via **dynamically imported** `node:fs` — Node only, browser bundles unaffected; graceful passthrough when the read fails) → assume raw base64.
- Path detection is extension-based, not slash-based — `/` is a legal base64 alphabet character, and a contains-slash heuristic would misfire on long payloads.
- The request pipeline stays allocation-free when every entry is already base64 (`withEncodedImages` returns the same array reference).
- Previously-broken inputs are silently fixed: data-URI strings, which used to ship the `data:image/...;base64,` header to the server, are now stripped.
- New exports: `resolveImageInput()`, `imageStringNeedsResolution()`, `resolveImages()`, `type VisionInput`.

### Dual-mode OpenAI Responses bridge (`src/responses.ts`)

- **`client.responses.create()`** — ergonomic, OpenAI-SDK-shaped bridge (`model`, `input`, `instructions`, `tools`, `temperature`, `top_p`, `max_output_tokens`, `reasoning_effort`, `think`) over `POST /v1/responses` (Ollama ≥ v0.13.3), with **transparent `/api/chat` fallback on 404** for older servers: `instructions` → system message, `max_output_tokens` → `options.num_predict`, reply normalized back into the Responses shape (`output_text`, `usage.input_tokens`/`output_tokens`). The result's `transport` field (`'native' | 'chat-adapter'`) records the path taken.
- **`client.responses.stream()`** — lazy async generator yielding simplified `{type: 'text_delta' | 'thinking_delta' | 'done'}` events; same dual-mode transport, fallback only on establishment failure (never mid-stream, which would duplicate consumed deltas).
- **`client.responses.createText()`** — convenience returning just the output text.
- Native-mode mapping extracts joined `output_text` blocks (including refusals), reasoning traces (`thinking`), and parsed `function_call` items (`tool_calls` with parsed `arguments` objects).
- 404-only fallback, deliberately: 5xx remains a retryable error for the existing retry policy; 4xx is a request bug — neither means "endpoint absent."
- The full wire-shaped surface stays on `client.openai.responses()`; this module is the ergonomic migration subset documented in the new **MIGRATION.md** (openai npm SDK → this SDK mapping table).

### KV-cache-aware conversation sessions (`src/conversation.ts`)

- **`client.session(model, systemPrompt?)`** (or `new ConversationSession(client, options)`) — multi-turn session with an **append-only frozen history** and a system prompt **pinned at construction** (no mutation API — a per-call system prompt is the #1 silent KV-cache killer), maximizing Ollama's prompt-prefix KV-cache reuse across turns.
- **Per-turn and cumulative cache statistics** from `prompt_eval_cached_count` / `prompt_eval_count`: `session.cacheStats` (cumulative) and `sendTurn()`'s `TurnCacheStats` (per turn).
- Hit-rate denominator is `cached / (cached + evaluated)`: when the entire prompt hits the cache, Ollama reports `prompt_eval_count: 0`, so dividing by `prompt_eval_count` alone would score the best case as 0%.
- `send()` (reply text), `sendTurn()` (full turn record), `getMessages()` (defensive copy of the frozen history), `reset()` (restores system prompt, zeroes stats). Per-turn overrides (`options`, `think`, `keep_alive`, `tools`, `format`, `signal`, `timeoutMs`) ride on the request, never the history.

### Context-window safety (`src/context-safety.ts`)

- **Pre-flight estimation on every `chat()`/`generate()` call** guards against Ollama's silent prompt truncation when `num_ctx` is unset (server default 2048–4096, model-dependent): CJK-aware heuristic (~1 token per CJK character, ~4 chars/token elsewhere, `IMAGE_TOKEN_ESTIMATE` per image, per-message overhead, tool schemas), ±20–30% by design — no tokenizer download.
- **`defaultContextLength`** client config — injected as `options.num_ctx` on every request that omits it, making the effective window explicit on the wire.
- **`onContextOverflow: 'warn' | 'throw'`** (default `'warn'`) — log through the configured logger and send anyway, or reject client-side with `OllamaClientError` (`code: 'context_overflow'`) before anything hits the wire. `contextWarningThreshold` (default `0.9`) tunes the trip point.
- Window resolution order: request `num_ctx` → client `defaultContextLength` → conservative 2048 fallback, which warns only when the estimate _outright exceeds_ it (no margin — the real server default may be 4096, and a margin would generate false positives).
- New exports: `estimateTokens()`, `estimateChatRequestTokens()`, `estimateGenerateRequestTokens()`, `checkChatContext()`, `checkGenerateContext()`, `contextWarningMessage()`, `DEFAULT_CONTEXT_WARNING_THRESHOLD`, `IMAGE_TOKEN_ESTIMATE`, `OLLAMA_FALLBACK_CONTEXT_LENGTH`.

### Blob management & custom GGUF model publishing (`src/models-client.ts`)

- **`computeBlobDigest(data)`** — SHA-256 via the Web Crypto API (`crypto.subtle`, global in Node ≥ 20 and every browser/edge runtime), formatted `sha256:<64 lowercase hex>` exactly as Ollama's content-addressed store expects.
- **`createBlobFromData(data, {digest?})`** / **`createBlobFromFile(path)`** — HEAD existence check then upload, skipping the POST (and the wasted bandwidth) when the blob is already present; returns `BlobUploadResult { digest, alreadyExisted }` (file variant adds `fileName` — the basename `/api/create`'s `files` map keys on).
- **`createModelFromGguf(model, ggufPath | paths, opts)`** — one-shot implementation of Ollama's documented import protocol: push a blob per GGUF shard, then `POST /api/create` with `files: { <fileName>: <digest> }` (verified against the official API reference).

### Docs recheck: Ollama Cloud account endpoints + contract refresh

A second full audit against the current official Ollama docs (`docs/openapi.yaml`, `docs/api/*.mdx`, `docs/capabilities/*.mdx`, `docs/modelfile.mdx`, `docs/import.mdx`, `docs/context-length.mdx`) found the SDK already at parity everywhere except three items — all closed here:

- **`client.usage(options?)`** — wraps `GET https://ollama.com/api/usage` (cloud-only): request counts, USD spend, and token totals (input / cached-input / output) across the whole range plus hourly (`range: '24h'`) or daily (`'7d'`/`'30d'`) buckets, including `partial: true` markers for the in-progress hour/day. Query parameters `range` (`'24h' | '7d' | '30d'`, server default `'7d'`) and `scope` (`'self' | 'team'`, server default `'self'`, team requires an admin) are typed and only sent when provided.
- **`client.balance(options?)`** — wraps `GET https://ollama.com/api/balance`: remaining included + purchased credits, with the included shape a runtime-discriminated union of the plan-period credits object (`balance_usd`/`allowance_usd`/`period`) and the legacy session/weekly percentage-limits shape.
- Both ride the same fixed-cloud-host pipeline as `webSearch`/`webFetch` (`https://ollama.com`, `apiKey`/`OLLAMA_API_KEY`, default timeout + retry, never multi-endpoint failover) and both endpoints' documented 10-req/min rate limit is respected by the shared `OllamaRateLimitError` retry semantics (429 + `Retry-After`).
- **`CreateRequestOptions.capabilities`** — the one field-level gap the drift detector surfaced: the official `/api/create` payload accepts `capabilities: string[]` (e.g. `'decision'`) to add capabilities without removing inherited/inferred ones; now typed and forwarded. `files` also joined the create parity manifest.
- **Contract refresh** — the pinned OpenAPI snapshot (`contracts/sources/ollama.openapi.yaml` + verbatim `docs/upstream/ollama-openapi.yaml`) moved from the 2026-10-02 pin to 2026-10-07 (source SHA `675c8bb`), bringing the `Usage*`/`Balance*` schemas into the IR (7 new contract-generated models), repairing the corrupted enum literals the upstream file carries (`[24h, 7d, 30d]`, `[hour, day]`), and adding a new `contracts/overlays/cloud.yaml` so bidirectional endpoint discovery, the MCP tool registry, and the IR inspector all see the account endpoints.
- **Generator fix**: top-level `allOf` schemas (like `UsageBucket` = `UsageMetrics & {from, until, partial?}`) previously emitted as an empty interface — the models emitter dropped the intersection. `allOf` now emits a correct type alias; the Zod emitter already handled it.
- Everything else audited clean: all 15 core REST endpoints (incl. legacy `/api/embeddings`), `/v1/systemone`, `web_search`/`web_fetch`, the full OpenAI-compat surface (incl. `reasoning_effort`, `reasoning.effort`, `think`, `instructions`, `max_output_tokens`) and Anthropic-compat surface (incl. `output_config`, thinking, tool results, all streaming events), field-level sync on every request/response schema (`logprobs`, `top_logprobs`, `think`, `remote_host`/`remote_model`, `draft_files`, `parser`, `renderer`, `requires`, Ps `context_length`/`size_vram`, Show `capabilities`/`thinking`), auth (`OLLAMA_API_KEY` scoping), and the capability docs (vision, structured outputs, thinking, embeddings, tool calling, context length, GGUF import).
- New exports: `client.usage()`, `client.balance()`, `UsageRequestOptions`, `UsageRange`, `UsageScope`, `BalanceRequestOptions`, and the contract-generated `UsageResponse`, `UsageMetrics`, `UsageBucket`, `BalanceResponse`, `IncludedBalance`, `LegacyBalanceLimit`, `LegacyIncludedBalance`.
- 10 new unit tests (`test/usage-balance.test.ts`, mocked fetch — CI-safe) and updated guard tests (`test/security-invariants.test.ts` host allowlist now covers the four cloud ops; `test/contract/parity.test.ts` new-ops set extended).

### Documentation & examples

- README: four new Quick Start sections (sessions, dual-mode Responses, context safety, blob publishing) + rewritten vision section; five new feature bullets.
- **MIGRATION.md** (new): openai npm SDK → this SDK mapping table, responses/chat-completions/vision/statefulness/reasoning/error mapping.
- **ADR 0024** (new) + ADR index now lists 0022–0024.
- Five runnable examples: `examples/vision-inputs.ts`, `examples/responses-bridge.ts`, `examples/conversation-session.ts`, `examples/context-safety.ts`, `examples/blob-publishing.ts` (`npm run example <file>`) — plus `examples/usage-balance.ts` from the docs-recheck pass.
- 50 new unit tests (mocked fetch — CI-safe, no daemon): `test/vision-resolver.test.ts`, `test/responses-bridge.test.ts`, `test/conversation-session.test.ts`, `test/context-safety.test.ts`, `test/blob-helpers.test.ts` — plus 10 more in `test/usage-balance.test.ts`.

### Also shipped in 1.9.0 (filed under Unreleased)

#### Fix: IPv6 loopback was classified as Ollama Cloud

- `inferRuntimeMode()` compared `URL.hostname` to `'::1'`, but WHATWG URL reports an IPv6 literal with its brackets (`'[::1]'`), so `http://[::1]:11434` was classified as `cloud`. Structured-output (`format`) requests to a local Ollama on IPv6 loopback were therefore refused pre-flight with `OllamaUnsupportedCapabilityError`, and `localMode` was off for capability detection. The brackets are now stripped before comparing. Public IPv6 addresses are still `cloud`.

#### Host normalization and scoped `OLLAMA_API_KEY`

- **Base URL normalization.** `baseUrl`, `OLLAMA_HOST`, per-credential `baseUrl` and `endpoints[].baseUrl` now accept the bare forms the Ollama CLI accepts: `127.0.0.1:11434`, `0.0.0.0`, `:11434`, `myhost`. A missing scheme defaults to `http://`, a missing port on a scheme-less host defaults to `11434`, scheme-less port `443` selects `https://`, and `:port` means `127.0.0.1`. Full URLs and reverse-proxy path prefixes are unchanged. Previously a scheme-less value produced an invalid request URL.
- **Behavior change: `OLLAMA_API_KEY` is no longer forwarded to arbitrary hosts.** The env-sourced key is applied to the default endpoint only when its host is Ollama Cloud (`ollama.com`, `*.ollama.com`) or loopback. An explicit `apiKey` is always sent, to any host. If you relied on `OLLAMA_API_KEY` for a LAN or proxied server, pass `apiKey` explicitly. Web search/fetch (always `https://ollama.com`) still use the env key.

#### Production-readiness audit — tool-call accumulator, mock server

- **Offline wire-format conformance tests** (`test/conformance/native-api-offline.test.ts`). The sibling `native-api.test.ts` hits a REAL Ollama server and skips when none is available. The new offline tests use `OllamaMockServer` to emit contract-shaped NDJSON frames without any model inference, so they run in every CI environment — including those without an Ollama daemon. They validate ONLY the wire format (schema conformance, error-class mapping, optional-field handling), NOT model behavior. The split exists because wire-format drift is a contract concern (catchable offline), while model-behavior drift is a server/model concern (only catchable against a live server). 22 new tests covering:
  - `GET /api/version`, `/api/tags`, `/api/ps`, `POST /api/show` schema conformance
  - `POST /api/chat`, `/api/generate`, `/api/embed` schema conformance (non-streaming)
  - `POST /api/chat`, `/api/generate` streaming chunk schema conformance
  - Error-class mapping: 404 → `OllamaNotFoundError`, 503 → `OllamaOverloadedError`, in-band `{"error":"..."}` → `OllamaStreamError`
  - Optional telemetry fields (`prompt_eval_cached_count`, `thinking`, `done_reason`) — verifies the SDK does NOT throw when these are absent (the Wave 13 conformance failure mode)
  - `done_reason` variants: `"stop"`, `"length"`, `"load"`, `"unload"` all parse cleanly; an undocumented value also parses cleanly (forward-compat)
  - `OllamaClient` vs `NativeApi` shape parity (mirrors the live parity test)
- Updated `test/conformance/harness.ts` docstring to document the live-vs-offline split.

#### Production-readiness audit — tool-call accumulator, mock server

- **Defensive tool-call streaming accumulator (`src/tools/tool-call-accumulator.ts`).** The original `aggregateChat` in `src/streaming/normalize.ts` blindly appended every chunk's `tool_calls` array, which would produce duplicate entries if Ollama ever started streaming them incrementally. The new `ToolCallAccumulator` matches entries by `id` (the SDK-synthesized stable identifier) or by array position, and merges them with spread-semantics on `function.arguments`. For the documented native Ollama behavior (tool_calls arrive complete in one chunk), the accumulator is a no-op — one chunk carries the full array, the next chunk has nothing, and the accumulator appends exactly once. The accumulator is also exported for callers who want the same merge logic on raw NDJSON chunks.
  - New exports: `ToolCallAccumulator` class, `mergeToolCallArrays()` stateless helper, `mergeToolCall()` / `mergeToolCallArgumentsString()` / `isSameToolCall()` standalone helpers.
  - `aggregateChat` now uses `mergeToolCallArrays` instead of the naive `[...accumulated, ...incoming]` spread.
  - Includes a dedicated `mergeToolCallArgumentsString` helper for the OpenAI-compat streaming format (where `function.arguments` arrives as string deltas like `'{"city":'` + `' "Bengaluru"}'`); the OpenAI-compat bridge at `src/integrations/openai.ts` already does its own per-index accumulation, but the helper is exported for callers who want the same logic elsewhere.

- **In-memory mock server for deterministic CI testing (`test/mocks/ollama-mock-server.ts`).** A thin `node:http` wrapper that lets tests register route handlers with programmable delay, chunk fragmentation, mid-stream error injection, and connection drops. Complements the existing VCR cassette system (`test/vcr.ts`) with capabilities cassettes can't provide:
  - Programmable inter-chunk delay (test backpressure handling).
  - Mid-stream error frame injection (test in-band `{"error":"..."}` trapping).
  - Chunk fragmentation across TCP packets (test parser buffering).
  - 503/502/429 error status codes with custom bodies.
  - Connection drops mid-stream (test recovery from network failures).
  - Request body capture via `onRequest` callback.
  - Idempotent `stop()` — safe to call from `afterEach` hooks without tracking whether `start()` ran.
  - Ephemeral port support (`port: 0`) for parallel test runs.

#### Second digest — mid-stream errors, 502/503 specialization, pull-progress ergonomics

- **In-band stream-error trapping (NDJSON).** Ollama's streaming endpoints start with HTTP 200 OK and chunked transfer encoding; if generation fails mid-flight (GPU OOM, driver crash, context window overflow, model unload race), the server emits a final `{"error": "..."}` JSON frame and closes the stream. The HTTP status code never changes from 200, so HTTP-status-based error detection misses these errors entirely — they would silently bleed into the assistant's content stream as garbage tokens or undefined-field accesses.
  - `parseNdjsonStream` now detects bare `{"error": "..."}` frames and throws `OllamaStreamError` immediately, with the error message preserved.
  - `OllamaStreamError.partialContent` carries whatever content was accumulated before the error frame arrived (concatenated `message.content` for chat streams, concatenated `response` for generate streams, empty string for pull/push streams).
  - The stream's `finalResult` promise rejects with the enriched `OllamaStreamError`; the `for await ... of stream` iterator yields an `{ type: 'error', data: { error } }` event before completing.
  - See: https://github.com/ollama/ollama/blob/main/docs/api.md

- **Granular HTTP status specialization.** Two new error subclasses give callers a way to branch on the failure mode rather than parsing messages or branching on `status` numbers.
  - `OllamaOverloadedError` (HTTP 503) — server queue saturation (`OLLAMA_MAX_QUEUE` exceeded, default 512). `retryable: true`.
  - `OllamaBadGatewayError` (HTTP 502) — cloud model could not be reached by the Ollama Cloud proxy. `retryable: true`.
  - Both extend `OllamaClientError` directly (NOT `OllamaServerError`) because `OllamaServerError`'s constructor unconditionally forces `code: 'server_error'`. Callers wanting "any 5xx" should branch on `error.status >= 500 && error.status < 600` rather than `instanceof OllamaServerError`.
  - Existing `instanceof` handlers for `OllamaNotFoundError` (404), `OllamaRateLimitError` (429), and `OllamaServerError` (generic 5xx) remain unchanged.

- **Typed pull/push progress callback (`onProgress`).** The SDK already exposed pull/push progress as a typed `OllamaStream` via `models.pull({ stream: true })`. The new `onProgress(stream, cb)` helper wraps the stream iteration with a pre-computed `percent` field for callers building download/upload UIs:

  ```ts
  const stream = await client.models.pull({ model: 'llama3.2', stream: true });
  await onProgress(stream, (event) => {
    if (event.percent !== undefined) {
      console.log(`${event.status}: ${event.percent}% (${event.digest?.slice(0, 12) ?? '-'})`);
    }
  });
  ```
  - `computeProgressPercent(chunk)` and `toPullProgressEvent(chunk)` exported for callers who want the percent calculation without subscribing to a stream.
  - `PullProgressEvent` type carries `{ status, digest?, total?, completed?, percent?, raw }`.

- **Cloud-vs-local tool-replay investigation (ADR 0023).** Documented the SDK's stance on parallel-vs-sequential tool-call emission from cloud vs local models: the SDK is a transparent passthrough, models decide, agent authors enforce sequential execution via `ToolRegistry`'s `maxConcurrency` option if they need it. Implemented the proposed `ModelCapabilities.parallelToolCalls` field as a best-effort heuristic:
  - New `ParallelToolCallBehavior` union: `'yes' | 'no' | 'unknown'`.
  - Cloud-mode + tool-capable → `'yes'` (the OpenAI/Anthropic compat bridges proxy to proprietary models that freely emit parallel tool calls).
  - Cloud-mode + no tools → `'unknown'`.
  - Local-mode + family in known-parallel list (`qwen2`, `qwen2.5`, `qwen3`, `llama3.1`, `llama3.2`, `llama3.3`, `llama4`, `mistral`, `mixtral`, `hermes`, `command-r`, `command-r-plus`) → `'yes'`.
  - Local-mode + model name (including `:tag`) contains a tool-use variant hint (`tool-use`, `instruct`, `hermes`, `command-r`, etc.) → `'yes'`.
  - Otherwise → `'unknown'` (caller should treat as "ask the model and see what it does").
  - The family is extracted from `/api/show`'s `model_info.*.architecture` (with fallbacks to `details.family` then `details.families[0]`).

#### First digest — VRAM lifecycle, fetchWithBackoff, System One image caps, done_reason decoder

- **VRAM lifecycle primitives.** Added ergonomic helpers for explicit GPU memory management, addressing the upstream `keep_alive` semantics documented in the Ollama FAQ:
  - `KeepAlive` type union (`string | number | 'unload' | 'indefinite'`) and `normalizeKeepAlive()` helper map the SDK-level sugar literals `'unload'` and `'indefinite'` to the wire-level `0` and `-1` sentinels.
  - `ModelsClient.unload(model)` issues an empty `/api/generate` request with `keep_alive: 0` to evict a model from VRAM immediately, freeing GPU memory for subsequent pipelines.
  - `ModelsClient.pin(model)` issues an empty `/api/generate` request with `keep_alive: -1` to pre-load and pin a model indefinitely for hot-loop inference.
  - `OllamaClient.unloadModel(model)` and `OllamaClient.pinModel(model)` convenience aliases mirror the existing `listModels` / `pullModel` pattern.
  - `KEEP_ALIVE_UNLOAD` and `KEEP_ALIVE_INDEFINITE` exported constants for callers who want the raw sentinel values directly.

- **Overload resiliency for HTTP 503 / 429.** New standalone `fetchWithBackoff()` helper wraps any fetch-shaped function with jittered exponential backoff for transient saturation responses. Mirrors the SDK's internal transport retry policy (`maxRetries: 3`, `initialDelayMs: 500`, `maxDelayMs: 30_000`, full-jitter strategy) so consumers see identical retry behavior whether they go through `OllamaClient` or call the helper directly. Useful for raw HTTP traffic to Ollama's compatibility bridges (Anthropic / OpenAI) or sibling Ollama instances outside the configured endpoint registry. `RETRYABLE_STATUS_CODES` and `DEFAULT_FETCH_BACKOFF_CONFIG` exported for downstream tooling.

- **System One image support ergonomics.** The generated `SystemOneRequest.images?: readonly string[]` field (already on the wire) is now backed by:
  - `MAX_SYSTEM_ONE_REQUEST_BYTES` (64 KiB) and `MAX_SYSTEM_ONE_IMAGES_BYTES` (32 MiB) constants documenting the conditional server-side size limits.
  - `estimateSystemOneRequestBytes(request)` helper for pre-flight size validation before sending a multi-image batch — the runtime enforces the limit too, but the early check avoids the round-trip when the caller already knows the payload is too large.

- **Response decoder hardening (Wave 13 conformance fix).** Added `KnownDoneReason` literal type (`'stop' | 'length' | 'load' | 'unload'`) and `isKnownDoneReason()` type guard so callers can narrow `done_reason` from `string | undefined` without risking `TypeError` on undefined access — the failure mode flagged in CI run #36962280416. The `done_reason` field on `ChatResponse` / `GenerateResponse` remains `string | undefined` for forward-compat with future upstream additions; the type guard provides opt-in narrowing.

## [1.8.0] - 2026-10-02

- **Contract execution completion (Waves 12-16).** The SDK's contract-first architecture is now fully executable: every operation in the canonical IR is represented, generated, typed, and runtime-enforced with no `Record<string, unknown>` escape hatches on the generated surface.
  - **Wave 12** — Contract execution hardening: transport-mode dispatch (SSE for compat, NDJSON for native), `maxRequestBytes` enforcement (413 client-side), auto-fetch `minOllamaVersion` via cached `/api/version`, typed OpenAI/Anthropic generated APIs, fully generated System One types, MCP input schemas from path params, generated schema-registry, Web Search/Web Fetch in the IR, structural path parameters, `checkBlob` 404-only semantics, single `verify:release` gate, deterministic IR.
  - **Wave 13** — System One contract completion: exact upstream OpenAPI schemas (correct `confidence: number`, `noul: number`, `score: number`, `legend: Record`, `probabilities: Record`), string `pattern`/`minLength`/`maxLength` enforcement, conditional request size limits (64 KiB / 32 MiB with images), `OllamaClient.systemOne<Q>()` with key-safe generic answer access, opt-in `validateResponses` runtime path, live System One conformance against real Ollama with `tev1:0.8b`.
  - **Wave 14** — Failover + decision helpers: `OllamaClient.runtime` participates in multi-endpoint failover via `FailoverHttpClient`, higher-level System One decision helpers (`choice()`, `noul()`, `score()`, `route()`, `verify()`, `rank()`).
  - **Wave 15** — Contract execution completion: path parameter substitution (`{model}` → `gpt-4` with URI encoding), host-aware execution (web search/fetch route to `https://ollama.com` via `cloudHttp` backend), model-aware failover routing, MCP argument routing (path params split from body), `contract:validate` in CI and release, method+path operation-level discovery (catches missing HTTP methods on declared paths).
  - **Wave 16** — Final hardening: security invariant tests (path traversal prevention, host injection prevention, abort propagation), System One exact generic answer correlation (`AnswerFor<Q>`), decision helper `verify()` semantic fix (`probability` not `confidence`), ADR 0022 documenting hybrid compatibility typing policy, version bump to 1.8.0.

- **System One live-tour coverage.** The live feature tour now exercises `/v1/systemone` when the server is Ollama 0.35.0 or newer and a compatible local model is installed; otherwise it records a clear skip reason.

## [1.7.0] - 2026-10-01

- **Interactive MCP elicitation and task handling.** The stdio and HTTP connectors now support host-managed form/URL elicitation and configurable manual or automatic `input_required` handling. The bridge preserves task responses and exposes explicit task status, result, and cancellation methods without starting background polling.
- **Consolidated live Ollama tour.** Added `npm run lab:live` to exercise the built public SDK against a local Ollama server, with real-time request/stream logs, JSONL results, and opt-in cloud/vision checks.

## [1.4.1] - 2026-10-01

- **`noImplicitOverride` + exhaustive switch defaults.** Enabled `noImplicitOverride: true` in `tsconfig.json` so any future class method override must be explicitly marked with `override`. Added exhaustive `never` defaults to the 2 emitter switches over `JsonSchemaNode.type` — if the OpenAPI spec adds a new schema type, the build fails until the emitter is updated. See [ADR 0014](./docs/adr/0014-generated-surface-and-runtime-seam.md).
- **`using` declarations for resource cleanup (TS 5.2+).** Replaced 6 `try/finally` cleanup blocks (timers, stream readers, OpenTelemetry spans, timeout signals) with `using` / `await using` declarations via 3 new `Disposable` helpers in `src/utils.ts` (`disposableTimer`, `disposableReader`, `disposableSpan`). Eliminates the "forgot to clean up in the finally block" bug class — cleanup is now structurally guaranteed by the scope. 8 stateful `try/finally` blocks are intentionally NOT converted (correctly stateful). See [ADR 0014](./docs/adr/0014-generated-surface-and-runtime-seam.md).

## [1.4.0] - 2026-10-01

- **Contract-first hybrid architecture (Waves 1-9).** The SDK now ships a single canonical IR at `contracts/ir/ollama.ir.json` (compiled from `contracts/sources/` + `contracts/overlays/`) that drives seven consumers: TypeScript interfaces, generated API classes, MCP tool descriptors, operation metadata, field-level parity, Zod schemas, and bidirectional endpoint discovery. Adding a new Ollama operation now requires writing one overlay block; everything else is generated. See [ADRs 0013-0019](./docs/adr/README.md) for the full design.
  - **Wave 1** — Contract foundation: sources, overlays, canonical IR, bidirectional endpoint discovery (catches new endpoints like `/v1/systemone` that the OpenAPI spec doesn't yet cover).
  - **Wave 2** — Generated TypeScript interfaces in `src/generated/models/` (36 schemas), with a drift detector comparing against `src/types.ts`.
  - **Wave 3** — Generated API classes (`NativeApi` / `OpenAIApi` / `AnthropicApi`) delegating to a hand-written `OllamaRuntime` seam with environment + version guards.
  - **Wave 4** — `raw: true` option on `HttpClient` so the generated runtime inherits middleware/retry/telemetry for streaming calls (instead of bypassing them with a direct `fetch()`).
  - **Wave 5** — Field-level parity migrated from `docs/api-parity.json` into overlay `parity:` blocks; new IR-driven verifier `npm run verify:contract-parity`.
  - **Wave 6** — MCP tool generation: 21 tool descriptors at `src/generated/mcp/tools.json` with the runtime adapter at `@nemesis-oss/ollama-sdk/mcp/generated`.
  - **Wave 7** — Retired `docs/api-parity.json`, `scripts/verify-api-parity.ts`, and `scripts/parity-status.ts`. The IR-driven verifier is the only parity check.
  - **Wave 8** — `OllamaClient.runtime` accessor returns a cached `OllamaRuntime` sharing the client's transport; non-breaking bridge between the legacy and generated surfaces.
  - **Wave 9** — Zod schema generation: every TypeScript interface has a paired Zod schema at `src/generated/models/<name>.schema.ts` (36 schemas) for runtime validation.
- **MCP remote transport integration.** Added the optional `@nemesis-oss/ollama-sdk/mcp/http` adapter for MCP Streamable HTTP, explicit legacy SSE, and guarded automatic SSE fallback on compatible non-authentication 4xx responses. It preserves the root package's transport boundary and supports custom `fetch`/`RequestInit` configuration.

- **Ollama API parity refresh.** Updated the compatibility contract against the current documentation: native generate now preserves cached prompt-token metrics through streaming, OpenAI Chat/Completions parity includes documented logprobs fields, OpenAI Responses strict types retain supported `reasoning`/`think` controls, Anthropic `output_config.effort` is forwarded, and native Show/Create contracts include the newly verified fields.
- **Generate stream fidelity.** Aggregated generate streams now preserve `thinking` alongside response text and cached prompt-token usage.
- **Anthropic compatibility.** `output_config.effort` is now treated as supported by the current Ollama Messages compatibility docs instead of being silently discarded.

- MCP tool arguments are now validated against advertised JSON Schema constraints before dispatch, while `resultMode: 'structured'` preserves raw MCP `CallToolResult` objects for programmatic consumers.

## Releases 1.5.0 to 1.8.0 (filed under Unreleased)

- **MCP bridge hardening.** MCP tool discovery now supports bounded pagination, repeated-cursor protection, request cancellation, richer MCP metadata types, and structured/non-text result preservation.
- **Optional Node MCP stdio adapter.** `@nemesis-oss/ollama-sdk/mcp/stdio` connects to local MCP servers using the official `@modelcontextprotocol/client` v2 transport without importing Node-only code into the root package.

### Fixed

- **Documentation consistency.** Restored the package README after an accidental truncation and kept the current MCP/agent capability additions documented.
- **ADR numbering.** Renumbered the MCP boundary and agent tool-precondition decision to ADR 0011 so ADR 0008 remains uniquely assigned to endpoint failover scope.

### Added

- **First-class MCP bridge.** Added `McpBridge` to convert MCP `tools/list` descriptors into native Ollama tool definitions and register executable MCP-backed tools through the existing `ToolRegistry` without coupling the core package to a transport.
- **Agent capability preflight and adaptive context.** Tool-enabled `Agent` runs using `OllamaClient` now query `/api/show` before the first model turn, fail with `OllamaIncompatibleModelError` when `tools` is absent, and default to `num_ctx: 32768` clamped to the model-reported context length; explicit `options.num_ctx` remains authoritative.
- **Model context metadata.** `ModelCapabilities` now exposes `contextLength` parsed from `/api/show` `model_info` and accepts cancellation through the capability lookup.
- **Machine-readable Ollama contract and IR-driven CI verification.** The canonical IR at `contracts/ir/ollama.ir.json` (compiled from `contracts/sources/` + `contracts/overlays/`) defines the supported Ollama surface, and `verify:contract-parity` checks it against the current official documentation; publishing now runs the same verification.
- **Support-aware compatibility contract.** API parity manifest v4 now separates supported, explicitly unsupported, and SDK-only fields; verifies Anthropic response fields and the public OpenAI Responses/Anthropic stream unions; and exports strict Ollama-scoped request types without removing the broader compatibility request types.
- **Strict Anthropic compatibility types.** Ollama-scoped tool and thinking types now exclude provider-only controls while the broader Anthropic compatibility types remain available for callers targeting the wider provider API.
- **Anthropic Ollama-scope alignment.** The strict Anthropic request type now excludes `output_config`, redacted-thinking input blocks, and nested `cache_control` on tool-result text; the compatibility bridge strips those unsupported cache directives before transmission. Live documentation sections now take precedence over pinned fallbacks, and nested unsupported-field evidence is enforced.
- **Automated Ollama API parity verifier.** CI now checks the documented native and OpenAI/Anthropic compatibility request surfaces against the SDK's TypeScript interfaces and current official documentation.
- **Abort-aware retry backoff.** `withRetry` now accepts an optional `AbortSignal`, and `OllamaClient` propagates request cancellation through retry delays so cancelled work does not remain asleep in backoff.
- **HTTP middleware and request lifecycle hooks.** The existing `middleware` and `onLifecycleEvent` client options are now wired through native, OpenAI/Anthropic compatibility, health-check, and hosted web HTTP paths; retries share the same logical request id.
- **Shared compatibility endpoint routing.** OpenAI and Anthropic compatibility requests now use the same model-scoped endpoint selection, failover, concurrency limits, and cancellation path as native inference.
- **Compatibility stream lifecycle.** OpenAI/Anthropic streams now expose `abort()`, hold endpoint capacity until `finalResult` settles, and remain covered by the request timeout for their full lifetime.
- **OpenAI Responses stream reconstruction.** Responses streams can now reconstruct message, function-call, and reasoning output items from deltas when a terminal full response payload is absent.
- **OpenAI Responses event/state parity.** Responses streams now understand output-item/content-part lifecycle events, refusal and reasoning-summary events, function-call `call_id` reconstruction, and `response.failed` / `response.incomplete` terminal states; failed or incomplete streams surface a typed `OpenAIResponsesStreamError` instead of a fabricated success response.
- **Native model-management parity.** The live parity contract now also verifies the documented `/api/copy`, `/api/pull`, `/api/push`, and `/api/delete` request surfaces. The Responses contract now distinguishes Ollama-documented fields from SDK-only vendor extensions.
- **Native stream cancellation propagation.** NDJSON and SSE readers are cancelled on iterator termination and parent `AbortSignal` cancellation.
- **Current OpenAI compatibility wire fields.** Chat streaming now preserves model reasoning and `system_fingerprint`, and the completion/chat declarations include current logprob-related fields and cache-aware usage metadata.
- **Anthropic stream usage preservation.** `message_start` and `message_delta` usage details are merged without discarding cache-related counters.
- **API parity parser hardening.** Compatibility request-field checks are scoped to endpoint/request sections, sdk-only checks require exact input declarations, and CI fallback snapshots track the rendered hosted Ollama documentation rather than stale server-source structs.
- **Strict provider compatibility types.** Exported `OllamaAnthropicMessagesRequest` and tightened Ollama-scoped OpenAI request aliases so unsupported provider controls remain compile-time distinguishable while the broader compatibility types remain available; base64 vision content and Responses `truncation` are represented in the strict OpenAI surface.
- **Generic SSE transport:** added `parseSseStream()` and `HttpClient.requestSseStream()` for provider-neutral OpenAI/Anthropic-compatible streaming. Native Ollama NDJSON streaming remains unchanged.
- **Typed compatibility streaming:** added OpenAI Chat/Completions/Responses and Anthropic Messages streaming adapters over the shared SSE transport, including text aggregation, tool-call JSON argument accumulation, reasoning/thinking deltas, and final usage/response aggregation.
