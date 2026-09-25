# Changelog

## [Unreleased]

- **API parity v4.** Response fields for native endpoints and Anthropic, documented Anthropic stream event names, and live-doc precedence are now verified. `/api/ps` exposes `context_length`, and `/api/copy` is included in the parity surface.
### Added
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

### Added

- **Generic SSE transport:** added `parseSseStream()` and `HttpClient.requestSseStream()` for provider-neutral OpenAI/Anthropic-compatible streaming. Native Ollama NDJSON streaming remains unchanged.
- **Typed compatibility streaming:** added OpenAI Chat/Completions/Responses and Anthropic Messages streaming adapters over the shared SSE transport, including text aggregation, tool-call JSON argument accumulation, reasoning/thinking deltas, and final usage/response aggregation.