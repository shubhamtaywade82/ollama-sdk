# ADR 0039: Weekly upstream drift watch — issue + candidate re-pin PR, curated deviations re-applied

**Status**: Accepted
**Date**: 2026-10-24

## Context

The contract pipeline verifies the SDK against its *pinned* upstream sources (`contracts/sources/ollama.openapi.yaml`, the two compatibility MDX pins under `docs/upstream/`). Nothing noticed when upstream moved past those pins. Every refresh so far started from an external audit. ADR 0038 records the cost: the OpenAI-compatibility pin sat 11 days stale while upstream added `/v1/audio/speech`, and the build stayed green the whole time.

The refresh tooling also wasn't automatable:
- `scripts/refresh-mdx-pins.ts` hardcoded each pin's SHA, date and refresh note.
- `scripts/fetch-contract.ts` wrote the raw upstream body over the contract source. That would have dropped the curated narrative header and the one intentional deviation (`ModelSummary.details.families` typed `[array, null]`).

The first live run of the new check confirmed the gap. It found upstream `675150d` ("voice: add voice catalog for Phonon"), which edited the OpenAI-compatibility page a day after the ADR 0038 refresh.

## Decisions

1. **Drift means commit ancestry, not text comparison.**
   - `docs-index.json` sources gain `upstreamPath`.
   - `scripts/upstream-drift.ts` (`npm run contract:upstream-drift`) asks GitHub for the latest `ollama/ollama` commit touching each path, then compares it against `pinnedSha`. Only `status: ahead` counts as drift.
   - This stays correct when a pin is a main commit that didn't itself touch the file.
   - The report also lists two informational sections that never count as drift:
     - commits to upstream `openai/` and `anthropic/` bridge code (the ADR 0038 code-ahead-of-docs watch items);
     - the latest Ollama release vs the conformance job's version.
   - Exit codes: 1 = drift, 2 = the check itself failed.

2. **Re-pinning is scripted and keeps the curated parts.**
   - `fetch-contract.ts` writes the verbatim body to `docs/upstream/ollama-openapi.yaml`.
   - It writes the contract source as: the curated header (pin anchor rewritten, auto-refresh note appended) over the upstream body with `CURATED_DEVIATIONS` re-applied.
   - Each deviation must either apply exactly once, or already be present upstream, in which case it is logged as retired. Any other state throws.
   - Re-pinning at the current SHA reproduces the committed body byte-for-byte.
   - `refresh-mdx-pins.ts` derives its pins from the docs-index `mdx` sources and resolves each SHA from upstream.
   - Both scripts write `pinnedSha`/`pinnedAt` back to docs-index, so `pin-consistency.test.ts` holds after an automated refresh.

3. **`.github/workflows/upstream-watch.yml` runs every Monday 09:00 IST, and on demand.** On drift it:
   - re-pins the drifted sources;
   - regenerates;
   - runs the contract gates, recording each gate's own exit code (the ADR 0038 lesson);
   - opens or updates one candidate PR on `upstream-sync/auto`;
   - opens or updates one `upstream-drift` issue.

   The PR is never merged automatically. A red gate in the PR is the intended signal, for example a newly documented endpoint that no overlay declares yet (discovery Direction 2). It means implementation work is due.

## Consequences

- Upstream docs drift surfaces within a week, without an external audit.
- A human still writes the narrative refresh note, the ADR, overlay declarations and any transport work. ADR 0038 shows a new endpoint can need decisions no generator should make.
- A PR opened with `GITHUB_TOKEN` doesn't trigger `ci.yml`. The workflow runs the gates itself; an optional `UPSTREAM_SYNC_TOKEN` PAT makes normal CI run on the PR as well.
- Declined:
  - **Auto-merge:** pins carry curated content and decisions.
  - **Parse-and-reserialize the YAML to apply deviations:** that would reformat the whole spec and bury the real diff.
  - **Diffing against `ollama-js`:** revisit when a server feature lands there before the docs.
