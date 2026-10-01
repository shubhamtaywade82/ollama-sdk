# ADR 0015: Field-Level Parity Migration into Overlays

## Status

Accepted

## Context

ADR 0010 introduced `docs/api-parity.json` as a machine-readable compatibility
contract that classifies request and response fields as `fields` /
`unsupportedFields` / `sdkOnlyFields`. The verifier at
`scripts/verify-api-parity.ts` reads that manifest and asserts against the
live Ollama docs + hand-written `src/types.ts` interfaces.

That system has served the project well, but it suffers from the same
structural blind spot ADR 0013 fixed for endpoint discovery: the manifest is
**a parallel, hand-maintained surface** that lives outside the contract IR.
Every overlay-level change (an added operation, a renamed endpoint, a new
compatibility surface) requires a corresponding manual edit to
`api-parity.json`. The two systems drift silently — the parity manifest knows
nothing about the overlay, and the overlay knows nothing about the parity
manifest.

This is the same problem Wave 1 fixed for endpoints, applied to fields.

## Decision

Migrate the field-level parity metadata out of `docs/api-parity.json` and into
the overlay YAML files. Each operation that previously had a manifest entry
now carries a `parity:` block directly in its overlay. The canonical IR
includes the parity block, so consumers (verifier, drift detector, MCP bridge)
can read it from one source.

### Overlay schema

The overlay operation type gains an optional `parity?: OperationParity` block:

```yaml
operations:
  chat:
    openapi: /api/chat
    runtime: ...
    parity:
      legacySurfaceId: native-chat
      docsUrl: https://docs.ollama.com/api/chat
      fallbackDocsFile: docs/upstream/ollama-openapi.yaml
      request:
        interfaceName: ChatRequestOptions
        sourceFile: src/types.ts
        fields:
          [
            model,
            messages,
            tools,
            format,
            options,
            stream,
            think,
            keep_alive,
            logprobs,
            top_logprobs,
          ]
      response:
        interfaceName: ChatResponse
        sourceFile: src/types.ts
        fields: [model, created_at, message, done, ...]
```

### IR types

`OperationContract` gains `parity?: OperationParityContract`. The normalizer
copies the overlay's parity block into the IR verbatim. Wave 5 surfaces 17
operations with parity blocks; 4 operations (`systemOne`, `blobs`,
`openaiModels`, `openaiModelsGetOne`) have no legacy manifest entry and
therefore no parity block yet — these are candidates for future overlay
augmentation.

### IR-driven verifier

`scripts/verify-contract-parity.ts` replaces (alongside, not instead of)
`scripts/verify-api-parity.ts`. For every operation with a `parity:` block,
the new verifier:

1. Asserts every `parity.request.fields` entry exists on the hand-written
   interface named by `parity.request.interfaceName` in
   `parity.request.sourceFile`.
2. Asserts the same for `parity.response.fields`.
3. Asserts every `parity.stream.interfaceNames` entry is referenced by the
   TypeScript type alias `parity.stream.unionName`.

`sdkOnlyFields` are intentionally NOT hard-checked — they are an SDK-local
compatibility affordance that may or may not appear on the hand-written
interface. The drift detector in
`generator/emitters/typescript/drift-detector.ts` surfaces these as `removed`
entries for follow-up review. (The first run of the new verifier caught a
real defect: `parallel_tool_calls` is tracked as an sdkOnly field on
`OpenAIResponsesRequest` but is not actually present on that interface.
Filed for follow-up; not blocking Wave 5.)

### Migration tooling

`scripts/merge-parity-into-overlays.ts` is a one-shot migration helper that
reads the legacy manifest and appends `parity:` blocks to each overlay file.
It is idempotent — re-running it on already-migrated overlays is a no-op.
Run once during Wave 5; preserved in the repo for any future re-runs.

## What changed

### Added

- `generator/normalize/overlay-schema.ts` — new types `FieldParity`,
  `StreamParity`, `OperationParity`, and `OverlayOperation.parity`.
- `generator/types.ts` — new IR types `FieldParityContract`,
  `OperationParityContract`, `StreamParityContract`. `OperationContract`
  gains `parity?: OperationParityContract`.
- `generator/normalize/contract-normalizer.ts` — new `normalizeParity` and
  `normalizeFieldParity` helpers copy overlay parity into the IR.
- `scripts/verify-contract-parity.ts` — IR-driven verifier.
- `scripts/merge-parity-into-overlays.ts` — one-shot migration tool.
- `test/contract/parity.test.ts` — 7 tests asserting parity migration
  completeness and structural validity.
- `npm run verify:contract-parity` script.
- ADR 0015 (this file).

### Migrated

- All 17 operations from the legacy manifest now carry `parity:` blocks
  directly in `contracts/overlays/native.yaml`, `openai.yaml`,
  `anthropic.yaml`. The IR's `parityBridge` entries continue to map
  `legacySurfaceId` ↔ `operationId` for backwards compatibility.

### Preserved (deliberately NOT retired)

- `docs/api-parity.json` — the legacy manifest continues to exist. The
  legacy verifier (`scripts/verify-api-parity.ts`) continues to fetch live
  docs and assert field-level documentation status. The IR-driven verifier
  is a structural complement that doesn't yet replace the live-docs half.
  Both run in CI until the live-docs fetching is migrated into the IR-driven
  verifier (a future wave).

## Consequences

- The IR is now the single source of truth for both **endpoint structure**
  (Wave 1) and **field-level parity** (Wave 5). The drift detector and the
  bidirectional endpoint discovery validator both consume the same artifact.
- Adding a new operation now requires writing one overlay block, not one
  overlay block + one manifest entry. The two systems cannot drift apart
  because they are the same system.
- The first run of the new verifier caught a real defect
  (`parallel_tool_calls` declared as sdkOnly on `OpenAIResponsesRequest` but
  absent from the interface). This is exactly the kind of finding the
  contract-first architecture is designed to surface.
- `docs/api-parity.json` is now redundant data — it carries the same
  information as the overlays' `parity:` blocks. It is preserved only
  because `scripts/verify-api-parity.ts` still does live-docs fetching.
  Once that responsibility migrates to the IR-driven verifier, the legacy
  manifest can be retired.

## Reference

- ADR 0010 — Legacy compatibility contract (preserved)
- ADR 0013 — Contract-first hybrid architecture (Wave 1 foundation)
- ADR 0014 — Generated surface and runtime seam (Waves 2+3)
