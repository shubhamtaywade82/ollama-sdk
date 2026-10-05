# Changelog

## [Unreleased]

### Host normalization and scoped `OLLAMA_API_KEY`

- **Base URL normalization.** `baseUrl`, `OLLAMA_HOST`, per-credential `baseUrl` and `endpoints[].baseUrl` now accept the bare forms the Ollama CLI accepts: `127.0.0.1:11434`, `0.0.0.0`, `:11434`, `myhost`. A missing scheme defaults to `http://`, a missing port on a scheme-less host defaults to `11434`, scheme-less port `443` selects `https://`, and `:port` means `127.0.0.1`. Full URLs and reverse-proxy path prefixes are unchanged. Previously a scheme-less value produced an invalid request URL.
- **Behavior change: `OLLAMA_API_KEY` is no longer forwarded to arbitrary hosts.** The env-sourced key is applied to the default endpoint only when its host is Ollama Cloud (`ollama.com`, `*.ollama.com`) or loopback. An explicit `apiKey` is always sent, to any host. If you relied on `OLLAMA_API_KEY` for a LAN or proxied server, pass `apiKey` explicitly. Web search/fetch (always `https://ollama.com`) still use the env key.

### Production-readiness audit — tool-call accumulator, mock server

- **Offline wire-format conformance tests** (`test/conformance/native-api-offline.test.ts`). The sibling `native-api.test.ts` hits a REAL Ollama server and skips when none is available. The new offline tests use `OllamaMockServer` to emit contract-shaped NDJSON frames without any model inference, so they run in every CI environment — including those without an Ollama daemon. They validate ONLY the wire format (schema conformance, error-class mapping, optional-field handling), NOT model behavior. The split exists because wire-format drift is a contract concern (catchable offline), while model-behavior drift is a server/model concern (only catchable against a live server). 22 new tests covering:
  - `GET /api/version`, `/api/tags`, `/api/ps`, `POST /api/show` schema conformance
  - `POST /api/chat`, `/api/generate`, `/api/embed` schema conformance (non-streaming)
  - `POST /api/chat`, `/api/generate` streaming chunk schema conformance
  - Error-class mapping: 404 → `OllamaNotFoundError`, 503 → `OllamaOverloadedError`, in-band `{"error":"..."}` → `OllamaStreamError`
  - Optional telemetry fields (`prompt_eval_cached_count`, `thinking`, `done_reason`) — verifies the SDK does NOT throw when these are absent (the Wave 13 conformance failure mode)
  - `done_reason` variants: `"stop"`, `"length"`, `"load"`, `"unload"` all parse cleanly; an undocumented value also parses cleanly (forward-compat)
  - `OllamaClient` vs `NativeApi` shape parity (mirrors the live parity test)
- Updated `test/conformance/harness.ts` docstring to document the live-vs-offline split.

### Production-readiness audit — tool-call accumulator, mock server

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

### Second digest — mid-stream errors, 502/503 specialization, pull-progress ergonomics

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

### First digest — VRAM lifecycle, fetchWithBackoff, System One image caps, done_reason decoder

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

## [Unreleased]

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
