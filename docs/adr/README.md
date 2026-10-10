# Architecture Decision Records

This directory records significant architectural decisions for
`@nemesis-oss/ollama-sdk` — the context behind a choice, not just the choice
itself — so future maintainers don't have to reverse-engineer intent from the diff.

Format: one Markdown file per decision, numbered sequentially, following
[Status / Context / Decision / Rationale / Consequences].

| ADR                                                                          | Title                                                                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [0001](./0001-circuit-breaker-failure-model.md)                              | Circuit Breaker Failure Model                                                                                     |
| [0002](./0002-dual-esm-cjs-packaging.md)                                     | Dual ESM/CJS Packaging Strategy                                                                                   |
| [0003](./0003-zod-v3-v4-dual-support.md)                                     | Simultaneous Zod v3 and v4 Support                                                                                |
| [0004](./0004-tool-execution-sandboxing.md)                                  | Tool Execution Sandboxing Model                                                                                   |
| [0005](./0005-opentelemetry-instrumentation.md)                              | OpenTelemetry Instrumentation                                                                                     |
| [0006](./0006-edge-runtime-ci-and-benchmarks.md)                             | Edge Runtime CI Verification and Benchmarks                                                                       |
| [0007](./0007-synthetic-tool-call-ids.md)                                    | Synthetic Tool-Call IDs                                                                                           |
| [0008](./0008-endpoint-failover-scope.md)                                    | Endpoint Failover Scope: Inference Only                                                                           |
| [0009](./0009-anytool-registry-variance.md)                                  | `AnyTool` and Registry Parameter Variance                                                                         |
| [0010](./0010-ollama-compatibility-contract.md)                              | Ollama Compatibility Contract (retired)                                                                           |
| [0011](./0011-mcp-boundary-and-agent-tool-preconditions.md)                  | MCP Boundary and Agent Tool Preconditions                                                                         |
| [0012](./0012-mcp-remote-transport-boundary.md)                              | MCP Remote Transport Boundary                                                                                     |
| [0013](./0013-contract-first-architecture.md)                                | Contract-First Hybrid Architecture (Wave 1)                                                                       |
| [0014](./0014-generated-surface-and-runtime-seam.md)                         | Generated Surface and Runtime Seam (Waves 2+3)                                                                    |
| [0015](./0015-field-level-parity-migration.md)                               | Field-Level Parity Migration into Overlays (Wave 5)                                                               |
| [0016](./0016-mcp-tool-generation.md)                                        | MCP Tool Generation from the IR (Wave 6)                                                                          |
| [0017](./0017-retire-legacy-parity-manifest.md)                              | Retire the Legacy Parity Manifest (Wave 7)                                                                        |
| [0018](./0018-runtime-unification.md)                                        | Runtime Unification — OllamaClient → OllamaRuntime Bridge (Wave 8)                                                |
| [0019](./0019-zod-schema-generation.md)                                      | Zod Schema Generation (Wave 9)                                                                                    |
| [0020](./0020-runtime-zod-validation.md)                                     | Runtime Zod Validation Wiring (Wave 10)                                                                           |
| [0021](./0021-conformance-testing.md)                                        | Conformance Testing Against a Real Ollama Server (Wave 11)                                                        |
| [0022](./0022-hybrid-compatibility-typing.md)                                | Contract-First Hybrid Compatibility Typing                                                                        |
| [0023](./0023-cloud-vs-local-tool-replay.md)                                 | Cloud-vs-Local Tool-Replay Behavior                                                                               |
| [0024](./0024-digest-upgrades-vision-responses-sessions-context-blobs.md)    | Digest Upgrades — Vision Resolver, Dual-Mode Responses Bridge, KV-Cache Sessions, Context Safety, Blob Publishing |
| [0025](./0025-embedding-batching-client-teardown-declaration-portability.md) | Embedding Batching, Client Teardown, Declaration Portability                                                      |
| [0026](./0026-context-discovery-history-compaction-model-affinity.md)        | Context-Window Discovery, History Compaction, Model-Affinity Scheduling                                           |
| [0027](./0027-agent-cycle-detection-url-join-history-hygiene.md)             | Agent Cycle Detection, URL-Join Hardening, Vision-History Hygiene                                                 |
| [0028](./0028-telemetry-normalization-host-affinity-root-ping.md)            | Telemetry Normalization, Dynamic Host Model-Affinity Routing, Root Liveness Probe                                 |

ADRs 0013-0021 form a connected series documenting the contract-first hybrid
architecture: a single canonical IR (`contracts/ir/ollama.ir.json`) drives
TypeScript types, generated API classes, MCP tool descriptors, operation
metadata, field-level parity, Zod schemas, runtime validation, and
conformance testing against a real Ollama server. ADR 0010 (the legacy
compatibility contract) was retired by ADR 0017 but is preserved for
historical context.

A new ADR is warranted for decisions that are expensive to reverse, affect the public
API surface or dependency contract, or where a future maintainer would reasonably ask
"why did we do it this way?" Routine implementation detail doesn't need one.
