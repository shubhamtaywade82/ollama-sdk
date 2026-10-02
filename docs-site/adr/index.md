---
outline: [2, 3]
---

# Architecture Decision Records

This page is an index of the architecture decision records (ADRs) maintained in the repository. Each ADR records the **context behind a choice, not just the choice itself**, so future maintainers don't have to reverse-engineer intent from the diff.

ADRs live at [`docs/adr/`](https://github.com/shubhamtaywade82/ollama-sdk/tree/main/docs/adr) in the repository. Each one follows the **Status / Context / Decision / Rationale / Consequences** format and is numbered sequentially.

::: tip When to write a new ADR
A new ADR is warranted for decisions that are expensive to reverse, affect the public API surface or dependency contract, or where a future maintainer would reasonably ask "why did we do it this way?" Routine implementation detail doesn't need one.
:::

## Index

### Foundational decisions (ADR 0001–0012)

These decisions established the SDK's core shape: the error model, packaging, peer dependencies, tool execution, telemetry, edge-runtime verification, synthetic tool-call IDs, and the failover/MCP boundaries.

| ADR                                                                                                                                  | Title                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| [0001](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0001-circuit-breaker-failure-model.md)                      | Circuit Breaker Failure Model                      |
| [0002](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0002-dual-esm-cjs-packaging.md)                             | Dual ESM/CJS Packaging Strategy                    |
| [0003](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0003-zod-v3-v4-dual-support.md)                             | Simultaneous Zod v3 and v4 Support                 |
| [0004](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0004-tool-execution-sandboxing.md)                          | Tool Execution Sandboxing Model                    |
| [0005](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0005-opentelemetry-instrumentation.md)                      | OpenTelemetry Instrumentation                      |
| [0006](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0006-edge-runtime-ci-and-benchmarks.md)                     | Edge Runtime CI Verification and Benchmarks        |
| [0007](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0007-synthetic-tool-call-ids.md)                            | Synthetic Tool-Call IDs                            |
| [0008](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0008-endpoint-failover-scope.md)                            | Endpoint Failover Scope — Inference Operations Only |
| [0009](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0009-anytool-registry-variance.md)                          | `AnyTool` and Registry Parameter Variance          |
| [0010](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0010-ollama-compatibility-contract.md)                      | Ollama Compatibility Contract and Support Classification |
| [0011](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0011-mcp-boundary-and-agent-tool-preconditions.md)          | MCP Boundary and Agent Tool Preconditions          |
| [0012](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0012-mcp-remote-transport-boundary.md)                      | MCP Remote Transport Boundary                      |

### Contract-first architecture series (ADR 0013–0022)

ADRs 0013–0022 form a connected series documenting the **contract-first hybrid architecture**: a single canonical IR (`contracts/ir/ollama.ir.json`) drives TypeScript types, generated API classes, MCP tool descriptors, operation metadata, field-level parity, Zod schemas, runtime validation, conformance testing, and hybrid compatibility typing. ADR 0010 (the legacy compatibility contract) was retired by ADR 0017 but is preserved for historical context.

| ADR                                                                                                                                  | Title                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [0013](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0013-contract-first-architecture.md)                        | Contract-First Hybrid Architecture (Wave 1)                               |
| [0014](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0014-generated-surface-and-runtime-seam.md)                 | Generated Surface and Runtime Seam (Waves 2+3)                            |
| [0015](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0015-field-level-parity-migration.md)                       | Field-Level Parity Migration into Overlays (Wave 5)                       |
| [0016](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0016-mcp-tool-generation.md)                                | MCP Tool Generation from the IR (Wave 6)                                  |
| [0017](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0017-retire-legacy-parity-manifest.md)                      | Retire the Legacy Parity Manifest (Wave 7)                                |
| [0018](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0018-runtime-unification.md)                                | Runtime Unification — OllamaClient → OllamaRuntime Bridge (Wave 8)        |
| [0019](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0019-zod-schema-generation.md)                              | Zod Schema Generation (Wave 9)                                            |
| [0020](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0020-runtime-zod-validation.md)                             | Runtime Zod Validation Wiring (Wave 10)                                   |
| [0021](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0021-conformance-testing.md)                                | Conformance Testing Against a Real Ollama Server (Wave 11)                |
| [0022](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0022-hybrid-compatibility-typing.md)                        | Contract-First Hybrid Compatibility Typing (Wave 16)                      |

## Highlights

### ADR 0001: Circuit Breaker Failure Model

Established the structured `OllamaClientError` hierarchy with stable `code` strings, `retryable` flags, and per-endpoint failure tracking. The circuit breaker fails **open** rather than throwing a "circuit open" error: once an endpoint's failure count crosses `failureThreshold`, it's skipped in favor of healthy endpoints for `cooldownMs`, and only used again — sorted soonest-to-recover — if every endpoint is cooling down.

- **See also**: [Errors](../api/errors), [Failover & Routing](../guide/failover)

### ADR 0002: Dual ESM/CJS Packaging Strategy

The SDK ships as both ESM (`import`) and CJS (`require`) with clean `.d.ts` and `.d.cts` declaration maps. `tsup` builds both formats from a single ESM source; `@arethetypeswrong/cli` verifies in CI that the runtime exports always match the published types.

### ADR 0003: Simultaneous Zod v3 and v4 Support

`zod` is a peer dependency (`^3.22.0 || ^4.0.0`). The SDK auto-detects which major you have installed: v4's native `z.toJSONSchema` is used when available, falling back to a structural walker of v3's internal `_def` shape. Both majors work as first-class peers.

- **See also**: [Structured Output](../guide/structured-output)

### ADR 0004: Tool Execution Sandboxing Model

`ToolRegistry` exposes three opt-in defensive controls — `timeoutMs`, `maxConcurrency`, `maxOutputChars` — that bound the blast radius of untrusted model-generated tool arguments. Enforcement is cooperative: it stops the agent from waiting indefinitely, but cannot forcibly halt non-abort-aware async work already in flight on the same thread.

- **See also**: [Agents & Tool Calling](../guide/agents)

### ADR 0005: OpenTelemetry Instrumentation

Every `OllamaClient`/`Agent` call emits OpenTelemetry spans automatically — `chat`/`generate` use Gen AI semantic conventions; `ollama.endpoint.attempt` covers failover; `invoke_agent` → `ollama.agent.turn` → `execute_tool` covers agent runs. `@opentelemetry/api` is an optional peer dependency; tracing is a no-op when not installed.

### ADR 0006: Edge Runtime CI Verification and Benchmarks

The root package contains zero Node-only imports. `npm run verify:edge-runtime` bundles `dist/index.js` with `esbuild` targeting browser/edge (which hard-fails on any `node:*` import) and then runs a full `OllamaClient` + `Agent` + tool-calling round trip inside `@edge-runtime/vm` — a real Edge Runtime sandbox exposing only Web Standard globals.

### ADR 0007: Synthetic Tool-Call IDs

Ollama's native tool-calling protocol has no OpenAI-style per-call ID. The SDK synthesizes a stable client-side `id` for tracing and execution correlation — `response.turns[0].toolCalls[0].id` matches `response.turns[0].toolResults[0].toolCallId`. This `id` is metadata only; it isn't sent to Ollama on the wire (native `role: 'tool'` messages use Ollama's `tool_name` field).

- **See also**: [Agents & Tool Calling](../guide/agents)

### ADR 0008: Endpoint Failover Scope — Inference Operations Only

Failover applies to **inference calls** (`chat`, `generate`, `embed`, `webSearch`, `webFetch`) — a different endpoint serving the same model is a genuine substitute. Model/blob management (`listModels`, `pullModel`, `deleteModel`, etc.) and `capabilities()` target one specific endpoint's local state and deliberately do **not** fail over — retrying `deleteModel` against a different server doesn't retry the same operation, it silently acts on a different model catalog.

- **See also**: [Failover & Routing](../guide/failover)

### ADR 0011: MCP Boundary and Agent Tool Preconditions

The core package deliberately stays **transport-agnostic and Edge-compatible**. MCP transport (stdio, Streamable HTTP, SSE) lives behind optional subpath exports. For tool-enabled `Agent` runs, capability preflight is enabled by default — the agent queries `/api/show` before the first model turn and throws `OllamaIncompatibleModelError` when the model doesn't advertise `tools`.

- **See also**: [MCP Integration](../guide/mcp)

### ADR 0013: Contract-First Hybrid Architecture (Wave 1)

The foundational decision: a single canonical IR (`contracts/ir/ollama.ir.json`) drives seven consumers — TypeScript interfaces, generated API classes, MCP tool descriptors, operation metadata, field-level parity blocks, Zod schemas, and bidirectional endpoint discovery. New Ollama endpoints (like `/v1/systemone`) are caught automatically.

- **See also**: [Contract-First Architecture](../guide/contract-first)

### ADR 0018: Runtime Unification — OllamaClient → OllamaRuntime Bridge (Wave 8)

`OllamaClient.runtime` returns a cached `OllamaRuntime` that shares the client's transport (HttpClient + middleware + retry + telemetry + failover), so callers can mix the existing `OllamaClient` API with the generated `NativeApi` surface without configuring two HttpClient instances. `OllamaClient` is preserved verbatim; existing callers don't need to change anything.

- **See also**: [OllamaClient](../api/client), [NativeApi](../api/native-api)

### ADR 0020: Runtime Zod Validation Wiring (Wave 10)

Opt-in `validateRequests: true` / `validateResponses: true` on `OllamaRuntime`. When enabled, every request body is validated against the IR-derived Zod schema before the HTTP call; every response body is validated after. Response validation is off by default for forward-compat with wire-format extensions.

- **See also**: [Contract-First Architecture](../guide/contract-first#runtime-validation-with-generated-zod-schemas), [Errors](../api/errors)

### ADR 0022: Contract-First Hybrid Compatibility Typing (Wave 16)

The SDK exports both **broad compatibility request types** (e.g. `OpenAIChatCompletionRequest`) for pass-through interoperability with vendor-specific fields, and **strict Ollama-scoped request types** (e.g. `OllamaOpenAIChatCompletionRequest`) for compile-time enforcement of the documented Ollama subset. Each operation's `parity:` block in the IR distinguishes supported, explicitly unsupported, and SDK-only fields.

## How ADRs are organized

- One Markdown file per decision, numbered sequentially.
- Format: **Status / Context / Decision / Rationale / Consequences**.
- Status is one of: `Accepted`, `Superseded by ADR NNNN`, `Retired by ADR NNNN`, `Proposed`.
- Superseded/retired ADRs are preserved in place for historical context — they're not deleted.
- New ADRs are warranted for decisions that are expensive to reverse, affect the public API surface or dependency contract, or where a future maintainer would reasonably ask "why did we do it this way?"

## Cross-references in the docs

Throughout this documentation site, ADRs are linked inline from the relevant guide and API pages — for example, [Failover & Routing](../guide/failover) links to ADR 0001 (Circuit Breaker Failure Model) and ADR 0008 (Endpoint Failover Scope), and [Contract-First Architecture](../guide/contract-first) links to the entire 0013–0022 series.

If you're looking for the rationale behind a specific design choice, the [guide pages](../guide/getting-started) are the entry point — each one links to the ADRs that justify the decisions it implements.

## Contributing a new ADR

1. Copy the format from an existing ADR (e.g. [ADR 0022](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0022-hybrid-compatibility-typing.md)).
2. Number it sequentially — `00NN-slug.md`.
3. Add an entry to the table in [`docs/adr/README.md`](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/README.md) and to the relevant group above on this page.
4. Open a PR — the ADR is accepted when the PR is merged.
