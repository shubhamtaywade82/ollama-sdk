# ADR 0013: Contract-First Hybrid Architecture

## Status

Accepted

## Context

ADR 0010 introduced `docs/api-parity.json` as a versioned compatibility contract
and `scripts/verify-api-parity.ts` as its executable verifier. That system was a
significant improvement over ad-hoc field checks, but it has a structural blind
spot the original design did not anticipate: the verifier is **one-directional**.
It checks that every entry declared in the manifest exists in the Ollama docs,
but it does not check the inverse — that every endpoint Ollama documents is
declared in the manifest.

This asymmetry became visible when Ollama added `/v1/systemone` to its official
documentation index. The endpoint is documented, has hard runtime constraints
(local-only, no streaming, no tools, no images, 64 KiB request limit, requires
Ollama >= 0.35.0), and is described as experimental — yet none of that
information is representable in OpenAPI, and nothing in the existing parity
pipeline noticed that the manifest no longer covered the documented surface.

The root cause is that `docs/api-parity.json` is a parity _checklist_, not a
contract. It tracks what the SDK has chosen to support, not what Ollama
documents. As Ollama's API surface grows, the two drift apart silently.

## Decision

Adopt a **contract-first hybrid architecture** with the following properties:

1. **Contract owns what Ollama exposes; runtime owns how the SDK behaves around it.**
   The contract layer captures structural truth (paths, methods, schemas) from
   the upstream OpenAPI spec and behavioral truth (streaming defaults, capability
   model-dependence, local-vs-cloud, version constraints, size limits) from
   hand-maintained YAML overlays. The runtime layer (`OllamaClient`, `HttpClient`,
   retry, telemetry, agent, MCP bridge, etc.) is unchanged.

2. **A canonical IR sits between sources and consumers.**
   `contracts/sources/*.yaml` + `contracts/overlays/*.yaml` are normalized into
   `contracts/ir/ollama.ir.json`, a single deterministic artifact that downstream
   generators (TypeScript types, MCP tool schemas, capability metadata, docs)
   consume. The IR is a committed artifact; running `npm run contract:normalize`
   followed by `git diff contracts/ir/ollama.ir.json` is the canonical way to
   detect upstream drift.

3. **Bidirectional endpoint discovery is enforced.**
   `generator/validators/endpoint-validator.ts` asserts both directions:
   every operation declared in the IR must be discoverable in at least one docs
   source, AND every endpoint discoverable in any docs source must be declared
   in the IR. This is the structural fix for the `/v1/systemone`-class bug.

4. **The legacy parity system is preserved verbatim.**
   `docs/api-parity.json` and `scripts/verify-api-parity.ts` continue to run as
   before. The new contract system runs alongside; `parityBridge` entries in
   each overlay keep the legacy surface ids (`native-chat`, `openai-responses`,
   etc.) in sync with the new operation ids (`chat`, `openaiResponses`, etc.).
   Later waves will retire the legacy manifest once field-level parity is
   migrated into the overlays.

## Wave 1 scope (this ADR)

This ADR introduces the foundation only:

```
contracts/
  sources/
    ollama.openapi.yaml          # pinned upstream OpenAPI snapshot
    documented-endpoints.json    # endpoints documented by Ollama but not yet in the OpenAPI snapshot
    docs-index.json              # registry of every docs source the pipeline consults
  overlays/
    native.yaml                  # /api/* operations + behavioral truth
    systemone.yaml               # /v1/systemone — the operation the legacy manifest missed
    openai.yaml                  # /v1/* OpenAI-compat operations
    anthropic.yaml               # /v1/messages Anthropic-compat operation
  ir/
    ollama.ir.json               # committed canonical IR (deterministic, source-hashed)

generator/
  types.ts                       # OperationContract, CapabilitySupport, ContractStatus, ...
  parser/
    openapi.ts                   # structural parser
    docs.ts                      # endpoint discovery across all docs sources
  normalize/
    contract-normalizer.ts       # sources + overlays → canonical IR
    overlay-schema.ts            # overlay YAML type
    overlay-loader.ts            # used by the CLI's validate path
  validators/
    schema-validator.ts           # overlay YAML conformance
    compatibility-validator.ts    # cross-overlay consistency
    endpoint-validator.ts         # bidirectional discovery (the new gate)
  cli.ts                         # subcommands: normalize / validate / diff / info

scripts/
  fetch-contract.ts              # re-pull upstream OpenAPI
  build-contract.ts              # CLI wrapper for `normalize`
  verify-contract.ts             # CLI wrapper for `validate`
  diff-contract.ts               # CLI wrapper for `diff`

test/contract/ir.test.ts         # contract IR + bidirectional discovery tests
```

New npm scripts:

- `npm run contract:fetch` — refresh the pinned OpenAPI snapshot
- `npm run contract:normalize` — compile sources+overlays → IR
- `npm run contract:validate` — run all three validators
- `npm run contract:diff` — fail if the committed IR is stale

## What is explicitly NOT changed in Wave 1

- `src/` runtime code is untouched — `OllamaClient`, `HttpClient`, retry,
  telemetry, agent, MCP, streaming, capabilities all continue to work as-is.
- `docs/api-parity.json` and `scripts/verify-api-parity.ts` are untouched;
  they continue to run in CI alongside the new contract system.
- No TypeScript types are generated yet — that's Wave 2.
- No client wrappers are generated yet — that's Wave 3.
- No compatibility-bridge types are migrated yet — that's Wave 5.
- No MCP tool schemas are generated yet — that's Wave 6.

## Consequences

- The `/v1/systemone` regression is now structurally impossible: any newly
  documented endpoint that isn't declared in an overlay fails
  `npm run contract:validate` and `npm run contract:diff`.
- The IR is a single deterministic artifact reviewers can inspect without
  reading verifier logic. Its `sourceHash` field lets CI detect drift
  without re-running the normalizer.
- The overlay YAML format is intentionally a small, human-readable DSL. Every
  field maps 1:1 to an IR field, so reading an overlay is equivalent to
  reading a slice of the IR.
- The legacy parity manifest remains the source of truth for field-level
  compatibility (which fields are supported, unsupported, or SDK-only on each
  surface). Migrating that into the overlays is deferred to Wave 5.
- Future waves will generate TypeScript types, MCP schemas, and capability
  metadata directly from the IR. The IR's shape (`OperationContract`,
  `CapabilitySupport`, `ContractStatus`) is designed to support those
  generators without further refactor.

## Reference

Original architecture proposal:
"Contract owns what Ollama exposes. Runtime owns how your SDK behaves around it."
