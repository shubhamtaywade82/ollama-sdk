# Architecture Decision Records

This directory records significant architectural decisions for
`@nemesis-oss/ollama-sdk` — the context behind a choice, not just the choice
itself — so future maintainers don't have to reverse-engineer intent from the diff.

Format: one Markdown file per decision, numbered sequentially, following
[Status / Context / Decision / Rationale / Consequences].

| ADR                                              | Title                                       |
| ------------------------------------------------ | ------------------------------------------- |
| [0001](./0001-circuit-breaker-failure-model.md)  | Circuit Breaker Failure Model               |
| [0002](./0002-dual-esm-cjs-packaging.md)         | Dual ESM/CJS Packaging Strategy             |
| [0003](./0003-zod-v3-v4-dual-support.md)         | Simultaneous Zod v3 and v4 Support          |
| [0004](./0004-tool-execution-sandboxing.md)      | Tool Execution Sandboxing Model             |
| [0005](./0005-opentelemetry-instrumentation.md)  | OpenTelemetry Instrumentation               |
| [0006](./0006-edge-runtime-ci-and-benchmarks.md) | Edge Runtime CI Verification and Benchmarks |
| [0007](./0007-synthetic-tool-call-ids.md)        | Synthetic Tool-Call IDs                     |
| [0008](./0008-endpoint-failover-scope.md)        | Endpoint Failover Scope: Inference Only     |
| [0009](./0009-anytool-registry-variance.md)      | `AnyTool` and Registry Parameter Variance   |
| [0010](./0010-ollama-compatibility-contract.md) | Ollama Compatibility Contract and Support Classification |
| [0011](./0011-mcp-boundary-and-agent-tool-preconditions.md) | MCP Boundary and Agent Tool Preconditions |

A new ADR is warranted for decisions that are expensive to reverse, affect the public
API surface or dependency contract, or where a future maintainer would reasonably ask
"why did we do it this way?" Routine implementation detail doesn't need one.
