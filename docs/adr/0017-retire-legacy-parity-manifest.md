# ADR 0017: Retire the Legacy Parity Manifest

## Status

Accepted

## Context

ADR 0010 introduced `docs/api-parity.json` as the machine-readable compatibility
contract. ADR 0013 introduced the contract-first hybrid architecture with a
canonical IR. ADR 0015 migrated field-level parity from the legacy manifest
into the overlay YAMLs (Wave 5) so the IR carried the parity data directly.

After Wave 5, the legacy `docs/api-parity.json` was redundant data — it
carried the same information as the overlays' `parity:` blocks. The legacy
verifier (`scripts/verify-api-parity.ts`) was preserved only because it
still performed live-docs fetching from `docs.ollama.com`, a responsibility
the IR-driven verifier (`scripts/verify-contract-parity.ts`) had not yet
assumed.

## Decision

Retire the legacy manifest and verifier entirely.

### Wave 7 — Live-docs migration

Ported the live-docs fetcher + section extractors from
`scripts/verify-api-parity.ts` and `scripts/parity-status.ts` into a single
self-contained module at `generator/parser/docs-fetcher.ts`. The IR-driven
verifier (`scripts/verify-contract-parity.ts`) now performs both halves:

1. **Structural** (no network): every `parity.request.fields` /
   `parity.response.fields` / `parity.stream.interfaceNames` entry exists on
   the hand-written TypeScript interface.
2. **Live-docs** (cached per docsUrl): every `parity.request.fields` is
   documented as supported, every `parity.request.unsupportedFields` is
   explicitly marked as such, every `parity.stream.eventTypes` is documented.

Pass `--skip-live-docs` to skip the network half (useful for offline CI).

### Wave 7 — Parity bridge from overlays

Previously, `buildParityBridge` in the normalizer derived bridge entries
from the legacy `docs/api-parity.json` by matching endpoints. With the
legacy manifest gone, the bridge is now derived from the overlay YAMLs'
own `parityBridge:` blocks (already present since Wave 1). This makes the
overlay files the single source of truth for the legacy-surface-id ↔
operation-id mapping.

### Wave 7 — Retire

Deleted:

- `docs/api-parity.json`
- `scripts/verify-api-parity.ts`
- `scripts/parity-status.ts`
- `test/current-api-parity.test.ts` (the only test that read the manifest
  directly)

Updated:

- `package.json` — `verify:api-parity` script removed; `verify` and
  `prepublishOnly` now invoke `verify:contract-parity` instead.
- `test/api-parity-status.test.ts` — re-pointed at
  `generator/parser/docs-fetcher.js` (the new home of the helpers it was
  testing).
- `test/contract/ir.test.ts` — the parity-bridge integrity test no longer
  reads the deleted manifest; it asserts bridge integrity directly from
  the IR.
- `generator/normalize/contract-normalizer.ts` — `readLegacyParity` now
  returns an empty map when the manifest is absent (kept for any external
  consumer that still maintains one; otherwise a no-op).
- `generator/parser/docs-fetcher.ts` — the new home for the parity-status
  helpers, inlined from the deleted `scripts/parity-status.ts`.

### Wave 7 — Triage of drift findings

Before retiring the manifest, the 19 drift findings surfaced by Wave 2's
drift detector were triaged. Each was classified as an SDK-local field
that's either:

- **Experimental** (image-generation: `width`, `height`, `steps`, `image`,
  `completed`, `total`) — used by image-generation models, not in the
  OpenAPI spec.
- **Deprecated** (`modelfile`, `context`) — kept for backwards
  compatibility with older callers; OpenAPI spec no longer documents them.
- **Documented elsewhere but missing from OpenAPI** (`adapters`, `template`,
  `system`, `messages`) — Ollama documents these in the prose API docs but
  not in the OpenAPI snapshot.

Each was added to its overlay's `parity.request/response.sdkOnlyFields`
block. The drift detector now consults the IR's `sdkOnlyFields` declarations
and treats them as expected drift, not findings. Final result: **0
unexpected drift**.

## Consequences

- The canonical IR is now the single source of truth for endpoint structure,
  field-level parity, streaming events, and now live-docs status. There is
  no longer a parallel manifest to maintain.
- Adding a new operation requires writing one overlay block (which can
  include a `parity:` section with `docsUrl`, `fields`, `unsupportedFields`,
  `sdkOnlyFields`). The verifier automatically picks up the new entry.
- `npm run verify:contract-parity` is the only parity check; CI no longer
  needs to run `verify:api-parity` (which would now fail anyway, since
  the manifest is deleted).
- The drift detector's `--strict` mode now fails only on UNEXPECTED drift
  (i.e. fields that are not declared as sdkOnly). This lets future
  schema-vs-hand-written drift fail CI without false positives from the
  19 intentional SDK-only fields.
- Any external consumer that previously read `docs/api-parity.json`
  directly will need to switch to reading the IR's `operations[].parity`
  blocks instead. The data is equivalent and more thoroughly typed.

## Reference

- ADR 0010 — Legacy compatibility contract (now retired)
- ADR 0013 — Wave 1 contract foundation
- ADR 0015 — Wave 5 field-level parity migration into overlays
