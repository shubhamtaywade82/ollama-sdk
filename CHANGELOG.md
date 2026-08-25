# Changelog

All notable changes to `@nemesis-oss/ollama-sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-08-25

### Added

- **`credentials` + `modelBindings` config.** An ergonomic, map-based alternative to
  writing `endpoints` with per-entry `models` allow-lists by hand: `OllamaClientConfig`
  gains `credentials` (named `{ apiKey, baseUrl?, headers? }` entries, keyed by an id you
  choose), `modelBindings` (maps a model to the credential id, or ids, authorized to serve
  it), and `defaultCredential` (a fallback credential for any model with no explicit
  binding). Both config shapes compile down to the same `EndpointRegistry`/
  `executeWithFailover` routing added in 1.4.0 — this is config sugar, not a second
  routing mechanism — so behavior (including `OllamaModelRoutingError` on an unrouted
  model) is identical either way. `modelBindings` referencing an unknown credential id
  throws at construction. New `resolveCredentialEndpoints` export for anyone who wants the
  translation without going through `OllamaClient`.

## [1.4.0] - 2026-08-25

### Added

- **Credential-scoped multi-key routing.** `OllamaEndpoint` gains an optional `models`
  allow-list, for the common case of several Ollama Cloud API keys each entitled to a
  different model. `EndpointRegistry.candidates(model)` now filters to endpoints whose
  `models` includes the requested model (endpoints without `models` stay eligible for
  every model — fully backward compatible), so `chat`/`generate`/`embed`/`embeddings` and
  model-lifecycle calls (`showModel`, `pullModel`, etc.) automatically resolve the
  authorized credential for the model requested, and cross-endpoint failover between
  differently-scoped endpoints never sends a request to a key that isn't entitled to that
  model. Requesting a model no configured endpoint is scoped to throws the new
  `OllamaModelRoutingError` (`code: 'model_routing_error'`) immediately, before any
  network call — the SDK never probes unauthorized keys to see which one happens to
  work. See the README's
  ["Multiple API keys, each entitled to different models"](./README.md#multiple-api-keys-each-entitled-to-different-models)
  and the
  [multi-model agent benchmarking guide](./docs/guides/multi-model-agent-benchmarking.md).

## [1.3.0] - 2026-08-25

### Added

- **Client-side quota monitoring (`QuotaManager`).** Ollama Cloud doesn't expose
  account-level quota through the API — no response header or endpoint reports how much
  of your plan's session/weekly limit is left (see
  [ollama/ollama#15663](https://github.com/ollama/ollama/issues/15663)). `QuotaManager`
  tracks usage you record (via `recordUsage`, which reads `extractUsage`-normalized token
  counts off a raw response) against budgets you configure over one or more rolling
  windows, and refuses to proceed (`canProceed`/`assertCanProceed`) once a window's budget
  is spent — a local safety net to complement, not replace, catching the server's own
  `OllamaRateLimitError`. `createOllamaCloudFreeTierQuota` is a convenience factory
  wiring up the free tier's documented 5-hour session and 7-day weekly window cadence
  (you still supply the token/request budgets, since Ollama doesn't publish the actual
  ceilings). New `OllamaQuotaExceededError` (`code: 'quota_exceeded'`) is thrown by
  `assertCanProceed`. See the [Quota Monitoring](./README.md#quota-monitoring) README
  section.

## [1.2.0] - 2026-08-24

Closes gaps found during a documentation/API-parity review against the official Ollama
API — two of which were genuine issues, the rest already covered (multimodal `images`,
native `think`, `/api/embed`, and full model-lifecycle management all predate this
release; see the new README sections documenting them).

### Fixed

- **`webSearch`/`webFetch` were non-functional against real Ollama Cloud.** They
  previously posted to `<configured-baseUrl>/api/websearch` and `/webfetch` — the wrong
  host (Ollama's web tools only ever exist at `https://ollama.com`, never proxied through
  a local server) _and_ the wrong path (missing the underscore: `/api/web_search`,
  `/api/web_fetch`) _and_ the wrong request/response field names. Both methods now always
  target `https://ollama.com` regardless of `baseUrl`/`endpoints`, using the resolved
  `apiKey`/`OLLAMA_API_KEY`, and use the real field names (`max_results` request,
  `content` response). `WebSearchRequestOptions.count` and `WebSearchResult.snippet` are
  kept as `@deprecated` back-compat aliases (mapped to/mirrored from the correct fields)
  rather than removed outright. `WebFetchResponse` gains the `title`/`links` fields the
  real API actually returns.

### Added

- **`logprobs`/`top_logprobs`:** Added to `ChatRequestOptions`/`GenerateRequestOptions`
  (request) and `ChatResponse`/`GenerateResponse` (response, as a new `Logprob[]` typed
  by the new `Logprob`/`LogprobToken` types), matching the official `/api/chat` and
  `/api/generate` schemas.
- `OLLAMA_CLOUD_BASE_URL` exported for consumers who want to reference the fixed web-tools
  host directly.

## [1.1.0] - 2026-08-23

Brings the SDK's typed surface up to date with Ollama v0.13.3+.

### Added

- **`/api/create` field parity:** `CreateRequestOptions` now exposes the documented
  `template`, `renderer`, `parser`, `license`, `system`, `parameters`, and `messages`
  fields alongside the existing `from`/`files`/`adapters`/`quantize`. The old
  `modelfile` string field is kept for backward compatibility but marked `@deprecated`
  in favor of the discrete fields.
- **OpenAI Responses API bridge:** `client.openai.responses()` / `createResponses()`
  POST to `/v1/responses`. Ollama implements this non-statefully, so
  `previous_response_id`/`conversation` are typed but documented as ignored.
- **`reasoning_effort` / `reasoning.effort`:** Added to `OpenAIChatCompletionRequest`
  for thinking models (`deepseek-r1`, `qwen3`, etc.), matching Ollama's OpenAI
  compatibility docs.
- **`tool_choice` / `parallel_tool_calls`:** Now typed as accepted-but-ignored on
  `OpenAIChatCompletionRequest` (previously omitted entirely), so passing a standard
  OpenAI request object type-checks without modification.
- **Raw image bytes:** `Message.images` and `GenerateRequestOptions.images` accept
  `Uint8Array` alongside base64 strings. `OllamaClient.chat()`/`generate()` encode any
  `Uint8Array` entries to base64 automatically via the new `encodeImage` utility
  (exported from the package root), using `Buffer` on Node and `btoa` elsewhere so it
  stays Edge Runtime-safe.
- **`doneReason` in stream results:** `ChatStreamResult`/`GenerateStreamResult` now
  carry `doneReason`, mapped from the final chunk's `done_reason` (e.g. `"stop"`,
  `"load"`, `"unload"`).

### Fixed

- `package.json`'s `homepage`, `repository`, and `bugs` URLs now point at
  `ollama-sdk` instead of the pre-rename `ollama-client-ts`.

## [1.0.0] - 2026-08-17

First public release. The version was `0.1.0` throughout development but was never
published to npm, so the entire feature set below ships as the initial `1.0.0`.

`1.0.0` marks the public API surface (`OllamaClient`, `Agent`, `ToolRegistry`, the
streaming adapters, the error hierarchy, and the compatibility bridges) as stable under
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — breaking changes to it now
require a major version bump.

### Added

- **Core Ollama REST API Client:**
  - Full support for `chat`, `generate`, `embed`, `embeddings`, `ps`, and `version`.
  - Zero-runtime-dependency HTTP transport with native `fetch`, streaming NDJSON parsing, and binary body blob uploads.
  - Multi-endpoint high availability registry with circuit breaker failover, priority routing, and health checks.
  - Configurable exponential backoff with full jitter, retryable error predicates, and timeout signal propagation.
- **Model Lifecycle & Blob Management:**
  - `createModel`, `pullModel`, `pushModel`, `copyModel`, `deleteModel`, `listModels`, `showModel`.
  - Dedicated blob management endpoints: `createBlob` (`POST /api/blobs/:digest`) and `checkBlob` (`HEAD /api/blobs/:digest`).
- **Structured Outputs & Schema Validation:**
  - Seamless Zod schema conversion to JSON Schema, supporting both Zod v4 (native `z.toJSONSchema`) and Zod v3 (structural fallback).
  - Structured output parsing with resilient markdown code fence JSON extraction and strict validation errors (`OllamaToolValidationError`).
  - `zod` is a peer dependency (`^3.22.0 || ^4.0.0`) rather than a bundled dependency, so consumers don't end up with a duplicate copy in `node_modules`.
- **Reasoning & Thinking Tokens:**
  - Native parsing of reasoning traces (`<think>` tags and `message.thinking`) with dual stream events (`thinking` vs `token`).
- **Agentic Workflow & Tool Calling:**
  - Autonomous multi-turn agent execution loop (`Agent`).
  - Tool definition helper (`defineTool`) with Zod parameter schemas.
  - Tool registry with duplicate detection and execution error recovery.
  - Model Context Protocol (MCP) server integration (`createMcpToolSet`, `registerMcpTools`).
  - Opt-in tool execution sandboxing: per-tool/registry `timeoutMs` (cooperative cancellation via `AbortSignal`, surfaced as `OllamaToolTimeoutError`), `maxConcurrency` bounding parallel tool calls, and `maxOutputChars` truncating oversized tool output before it re-enters the conversation history. See [ADR 0004](./docs/adr/0004-tool-execution-sandboxing.md).
  - Synthetic, client-generated `tool_call_id` correlation: `ToolCall.id`, `Message.tool_call_id`, and `ToolExecutionResult.toolCallId` — Ollama's native protocol has no call ID, so the SDK synthesizes a stable one (`crypto.randomUUID()`, the Web Standard global, not `node:crypto`, to stay Edge-safe) the first time it sees a call without one, and reuses it consistently across the streamed `tool_call` event, the final aggregated message, the tool execution result, and the `role: 'tool'` history entry `Agent` appends. Execution/result correlation by array order still works exactly as before; `id` is an additive convenience. See [ADR 0007](./docs/adr/0007-synthetic-tool-call-ids.md).
- **Architecture Decision Records:** `docs/adr/` documents the rationale behind the circuit breaker failure model, the dual ESM/CJS packaging strategy, Zod v3/v4 dual support, the tool execution sandboxing model, OpenTelemetry instrumentation, Edge runtime CI verification, synthetic tool-call IDs, endpoint failover scope, and registry parameter variance.
- **OpenTelemetry Instrumentation:** Automatic spans (`@opentelemetry/api` is an optional peer dependency, a no-op when absent or unconfigured) for HTTP requests, endpoint failover attempts, non-streaming `chat`/`generate` calls (using the Gen AI semantic conventions, including token usage), and `Agent` runs (`invoke_agent` → `ollama.agent.turn` → `execute_tool`). See [ADR 0005](./docs/adr/0005-opentelemetry-instrumentation.md).
- **Edge Runtime CI Verification:** `npm run verify:edge-runtime` bundles `dist/index.js` for a browser/edge platform with `esbuild` (failing on any `node:*` import, matching Cloudflare Workers/Vercel Edge Runtime's own bundlers) and runs a full `OllamaClient` + `Agent` + tool-calling round trip inside `@edge-runtime/vm`'s sandboxed Edge Runtime — a real V8 context exposing only Web Standard globals. Wired into CI as its own job and into `verify`/`prepublishOnly`. See [ADR 0006](./docs/adr/0006-edge-runtime-ci-and-benchmarks.md).
- **Benchmarks:** `npm run bench` (via `vitest bench`, no new dependency) covers NDJSON stream parsing, Zod schema conversion/structured output parsing, `ToolRegistry` dispatch overhead, and `OllamaClient.chat`'s end-to-end request pipeline overhead. Wired into CI as its own job.
- **Protocol Compatibility Bridges:**
  - OpenAI compatibility bridge (`/v1/chat/completions`, `/v1/models`), including `stream_options.include_usage` and `tools` (function calling) typing — both confirmed supported by Ollama's OpenAI-compat layer; `tool_choice`/`parallel_tool_calls` are deliberately not typed, since Ollama documents `tool_choice` as explicitly unsupported. `@remarks` JSDoc on `OpenAICompatClient` scopes it as a documented subset of the OpenAI API, not the full Responses API surface.
  - Anthropic compatibility bridge (`/v1/messages`), including `cache_control` typing on content blocks for prompt caching. `@remarks` JSDoc on `AnthropicCompatClient` scopes it as a subset of the Messages API (no tool use, extended thinking, citations, files, or Batches API).
- **Capability Detection Fixes:** `ModelCapabilities.supportsStructuredOutputRequest` is no longer hardcoded `true` — it's inferred `false` for endpoints classified as `cloud` by `inferRuntimeMode` (Ollama Cloud does not currently support structured outputs) and documented as a best-effort heuristic, not a guarantee, since Ollama doesn't expose this as a queryable capability. Added `supportsThinking`, derived from the model's reported `thinking` capability.
- **Fail-Fast `OllamaUnsupportedCapabilityError`:** `chat`/`chatStream`/`chatWithSchema` and `generate`/`generateStream`/`generateWithSchema` now throw this error _before making any network call_ when `format` is set against an endpoint inferred as Ollama Cloud, instead of sending a request Ollama Cloud is known to reject. `unsupported_capability` is included in `DEFAULT_FAILOVER_CODES`, so a multi-endpoint setup tries the next candidate (e.g. a local fallback) before the error ever reaches the caller — verified with a test asserting the rejected cloud endpoint's URL is never actually fetched.
- **`dimensions` on `embed()`:** `EmbedRequestOptions.dimensions` lets callers request truncated embedding vectors, matching Ollama's `/api/embed` parameter.
- **Environment Variable Fallbacks:** `OllamaClient`'s default single-endpoint `baseUrl`/`apiKey` fall back to `OLLAMA_HOST`/`OLLAMA_API_KEY` (the same variables the official `ollama` CLI and client libraries read) when not passed explicitly, matching the convention of other major LLM SDKs. Guarded to remain a no-op (not a `ReferenceError`) on Edge runtimes where `process` doesn't exist. Explicit `config.baseUrl`/`config.apiKey`, and any use of `config.endpoints`, always take precedence.
- **Web Standard Stream Adapters:**
  - `toTextStream`, `toDataStream`, and `toResponse` for direct integration with Next.js, Vercel AI SDK, and Web standard streams.
- **Skills System:**
  - Frontmatter parser for `SKILL.md` documents.
  - Skill composition and prompt injection into system messages (`applySkill`).
- **Documentation Hygiene:** `OllamaClient.embeddings()` is now marked `@deprecated` (Ollama's `/api/embeddings` was superseded by `/api/embed`, exposed as `embed()`). `ToolCall`, `Agent`, and `ToolRegistry.executeToolCalls` document that Ollama's native tool-calling protocol has no wire-level call ID, dispatch/results are still ordered/concurrency-bounded rather than ID-driven, and that `id`/`tool_call_id` (see above) is a client-synthesized convenience layered on top, not a protocol guarantee.
- **Testing & Quality Assurance:**
  - New cancellation tests prove `AbortSignal` genuinely aborts the underlying `fetch` call (not just racing a promise) and propagates from `Agent.run` into `ToolExecutionContext.signal`, including the early-abort race where the signal is already aborted before the request starts.
  - 4-tier test architecture: Unit, Integration, Functional, and Behavioral testing (50 tests).
  - VCR record and replay harness with real cassettes generated against `qwen3.5:2b` and `nomic-embed-text:latest`.
  - Multi-node CI/CD workflow (Node 18, 20, 22) and automated npm release with provenance.

### Fixed

- **`ToolRegistry` rejected every concretely-typed tool.** Its constructor, `register`, and `registerMany` accepted `Tool<never, unknown>`; because `Tool` is invariant in `TParams` (it appears in both `schema: z.ZodType<TParams>` and `execute`), _nothing_ was assignable to it — so `new ToolRegistry([myTool])`, `new ToolRegistry({ tools: [myTool] })`, and `.register(myTool)` all failed to compile for consumers, including the exact example in this README. Replaced with a new exported `AnyTool` alias. Tool authoring keeps full type safety (`defineTool` still infers `TParams` from the Zod schema and type-checks `execute` against it); only the registry's storage type is widened. Found by installing the packed tarball into a throwaway TypeScript project during pre-publish verification. See [ADR 0009](./docs/adr/0009-anytool-registry-variance.md).
- **Tests are now type-checked.** `tsconfig.json` scoped checking to `src/`, and Vitest's esbuild transform strips types without verifying them — so all 20 test files were unchecked, and had masked the bug above with `as never` casts. `npm run typecheck` now uses `tsconfig.typecheck.json`, covering `src/`, `test/`, `bench/`, and `scripts/`. The casts (and a matching `as unknown as z.ZodType<never>` in `mcp-tools.ts`) are gone.

### Changed

- **Endpoint Failover Scope:** `ModelsClient` operations (`list`, `show`, `pull`, `push`, `create`, `delete`, `copy`, `ps`, `version`, `createBlob`, `checkBlob`) and `OllamaClient.capabilities()` no longer participate in cross-endpoint failover — each now targets only the single best candidate endpoint (same-endpoint retry via backoff still applies). These operations act on a specific server's local model catalog/blob store, which isn't an interchangeable resource across endpoints the way `chat`/`generate`/`embed` inference is; failing `deleteModel`/`listModels`/etc. over to a different endpoint was silently operating on the wrong server's state, not retrying "the same" request. `chat`/`generate`/`embed`/`embeddings`/`webSearch`/`webFetch` failover behavior is unchanged. See [ADR 0008](./docs/adr/0008-endpoint-failover-scope.md).
