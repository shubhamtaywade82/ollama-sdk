# Changelog

## [Unreleased]
- **MCP bridge hardening.** MCP tool discovery now supports bounded pagination, repeated-cursor protection, request cancellation, richer MCP metadata types, and structured/non-text result preservation.
- **Optional Node MCP stdio adapter.** `@nemesis-oss/ollama-sdk/mcp/stdio` connects to local MCP servers using the official `@modelcontextprotocol/client` v2 transport without importing Node-only code into the root package.
- **First-class MCP bridge.** `McpBridge` converts MCP tool descriptors to native Ollama function definitions and registers executable MCP-backed tools without coupling the core package to a transport.
- **Agent capability preflight and adaptive context.** Tool-enabled `Agent` runs using `OllamaClient` now query `/api/show` before the first model turn, throw `OllamaIncompatibleModelError` when `tools` is absent, and default to `num_ctx: 32768` clamped to the model-reported context length; explicit `options.num_ctx` remains authoritative.
- **Model context metadata.** `ModelCapabilities.contextLength` is parsed from `/api/show` `model_info`, and capability lookup accepts request cancellation.

- **API parity v4.** Response fields for native endpoints and Anthropic, documented Anthropic stream event names, and live-doc precedence are now verified. `/api/ps` exposes `context_length`, and `/api/copy` is included in the parity surface.
### Added
- **First-class MCP bridge.** Added `McpBridge` to convert MCP `tools/list` descriptors into native Ollama tool definitions and register executable MCP-backed tools through the existing `ToolRegistry` without coupling the core package to a transport.
- **Agent capability preflight and adaptive context.** Tool-enabled `Agent` runs using `OllamaClient` now query `/api/show` before the first model turn, fail with `OllamaIncompatibleModelError` when `tools` is absent, and default to `num_ctx: 32768` clamped to the model-reported context length; explicit `options.num_ctx` remains authoritative.
- **Model context metadata.** `ModelCapabilities` now exposes `contextLength` parsed from `/api/show` `model_info` and accepts cancellation through the capability lookup.
- **Machine-readable API parity manifest and CI verification.** `docs/api-parity.json` defines the supported Ollama surface and `verify:api-parity` checks the manifest against the current official documentation; publishing now runs the same verification.
- **Support-aware compatibility contract.** API parity manifest v4 now separates supported, explicitly unsupported, and SDK-only fields; verifies Anthropic response fields and the public OpenAI Responses/Anthropic stream unions; and exports strict Ollama-scoped request types without removing the broader compatibility request types.
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

### Added

- **Generic SSE transport:** added `parseSseStream()` and `HttpClient.requestSseStream()` for provider-neutral OpenAI/Anthropic-compatible streaming. Native Ollama NDJSON streaming remains unchanged.
- **Typed compatibility streaming:** added OpenAI Chat/Completions/Responses and Anthropic Messages streaming adapters over the shared SSE transport, including text aggregation, tool-call JSON argument accumulation, reasoning/thinking deltas, and final usage/response aggregation.