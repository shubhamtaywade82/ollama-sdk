# ADR 0034: System One cloud launch — 2026-10-16 contract refresh (re-pin d9b8601, dual request-size cap, 402 taxonomy)

**Status**: Accepted
**Date**: 2026-10-16
**Context**: Scheduled upstream snapshot freshness check accepted after Task 24 ("check whether the pinned snapshot is due for a refresh against upstream `openapi.yaml@main`") — upstream had moved from `2a9ffe3` (2026-10-15) to `d9b8601` with the System One cloud launch.

## Context

The standing contract-refresh procedure is to diff the pinned OpenAPI snapshot against upstream `main` and re-pin when upstream moves. Upstream's `d9b8601` ships a substantial behavioral change on `/v1/systemone`: System One launched in Ollama's cloud. Concretely, the new pinned source declares:

- The operation `description` now reads "locally or in Ollama's cloud. Requires Ollama v0.35.0 or later, or v0.40.5 or later for cloud models."
- `/v1/systemone` declares **two servers** — `http://localhost:11434` and `https://ollama.com` — with `security: [{} | bearerAuth]`.
- The `model` field accepts cloud models ("such as nimble, or clef:cloud for Ollama's cloud"); `questions` documents cloud naming (up to 100 ASCII letters, digits, `` `_` ``, `` `.` ``, `` `-` ``).
- The local byte caps were **clarified from an either/or reading to a dual bound**: "Local requests' text and schema, excluding images, must fit within 64 KiB, and the whole request within 32 MiB." (The 2026-10-15 pin said "Requests without images must fit within 64 KiB; requests with images must fit within 32 MiB.")
- Cloud requests carry their own limits: paid plan or usage credits; up to 64 questions; up to 4 images of at most 4 MiB and 16 megapixels each (8 MiB total); requests within 13 MiB; input within the model's 65,536-token context window.
- The documented response set adds **401** ("A cloud model was requested without signing in, or with an invalid API key. Through a local server, the response includes a `signin_url`.") and **402** ("The cloud model isn't included in the Free plan. Add usage credits or upgrade. Also returned when a payment fails."), and 413 now also covers cloud requests exceeding 13 MiB or the model's context window.

A second discovery retired an old deviation: upstream now serves the Usage enum literals inline (`enum: [24h, 7d, 30d]`, `enum: [hour, day]`). The "corrupted enum literals" the 2026-10-07 pin claimed to repair (`", 7d, 30d]"`, `"our, day]"`) were **our own Bash display artifact** eating `[24h`/`[h` CSI-style sequences — the Task 20 lesson, extended to this pattern. The repair deviation is retired; the file was verbatim-clean all along.

## Decisions

1. **Re-pin at `d9b8601`; retire the enum-repair deviation; keep the families deviation.**
   The pin flow is unchanged (`contract:fetch --pin`, verbatim copy to `docs/upstream/`, long deviation-notes header). The 2026-10-07 enum "repair" is dropped (upstream serves clean inline literals); the one remaining intentional deviation is `ModelSummary.details.families` typed `[array, null]` (the server serializes a nil Go slice as JSON `null` for models without family metadata), re-applied and re-documented in the header.

2. **`environment.cloud: supported` in the systemone overlay — the guard flip is metadata, not routing.**
   The runtime's environment guard (`localMode: false` + `environment.cloud === false` → `unsupported_capability` rejection) is driven by the overlay through the IR, so the flip propagates without runtime changes. System One defines no `host:` — it rides the client's configured host, exactly like every other native operation: a cloud-host client now passes the guard and POSTs to its own baseUrl, and a local-mode client can send `clef:cloud` through the local server (which fronts cloud models and answers 401 with a `signin_url` in the body when not signed in). No special cloud routing is introduced. The `unsupported_capability` guard itself stays — it still fires for genuinely local-only operations (model management: `pull`, `push`, `copy`, `create`, `delete`, blobs), pinned by tests rewritten onto `pull`.

3. **Dual request-size cap in the runtime — a deliberate behavior tightening.**
   The old guard selected one limit by images presence (`images ? maxRequestBytesWithImages : maxRequestBytes`), which let a multi-MiB text+schema payload ride through under the 32 MiB images cap — straight into a guaranteed server 413 ("text and schema must not exceed 64 KiB", the upstream example message). The new guard checks **both bounds on every request**: the text+schema portion (images excluded, serialized via the new `serializeWithoutImages()`) against `maxRequestBytes`, and the whole serialized body against `maxRequestBytesWithImages`. The only behavior change is that image-bearing requests whose non-image portion exceeds 64 KiB now fail client-side instead of server-side — the failure was always coming; we now surface it without the round-trip, per the Wave 12 rationale for the guard's existence. `estimateSystemOneRequestBytes()` gains `{ excludeImages: true }` so pre-flight checks can replicate the dual cap exactly.

4. **`OllamaPaymentRequiredError` (402) — one typed error per documented status, billing ≠ credentials.**
   402 joined the documented `/v1/systemone` response set, so it gets a dedicated class per the 502/503 precedent (`OllamaBadGatewayError`/`OllamaOverloadedError`, ADR 0031): `code: 'payment_required'`, `retryable: false`, `status: 402`, mapped in `statusToError`. It is deliberately distinct from `OllamaAuthError` (401/403): the credentials are fine, the billing relationship is the problem — the natural recovery flow is an upgrade/add-credits prompt, not an API-key re-prompt. 401 was already mapped to `OllamaAuthError`; the `signin_url` stays in the response body (the ErrorResponse schema carries only `error`, so there is no structured field to lift onto the class — no invented fields).

5. **Declined: client-side enforcement of the cloud limits.**
   The 13 MiB cloud request cap, 64-question/100-char naming rules, 4-image/4 MiB/16-megapixel image budgets, and the 65,536-token context window are documented in the overlay notes, MCP tool description, and docs — but **not** enforced client-side. The runtime cannot reliably classify a request as "cloud": `clef:cloud` is an example, not a specification, and a `:cloud`-suffix heuristic would be an invented classification rule against undocumented behavior (the same reasoning that declined `ContextBudgetGuard` in ADR 0033 — manufacturing client-side precision the contract doesn't define). The server enforces these limits and answers with typed 402/413/400 errors, which the SDK now surfaces precisely.

## Consequences

- Version 1.19.0: the guard flip and dual-cap tightening are behavioral (both bring the SDK in line with the clarified upstream contract), and `OllamaPaymentRequiredError` is new public API (root-exported).
- Tests: the matrix "rejects cloud-mode calls (local-only)" test inverted into a cloud-passes test; the environment guard retained coverage via `pull`; the "allows bodies >64 KiB when images are present" test inverted into the dual-cap rejection; new dual-cap and 402 test files/blocks added.
- Docs: `docs-site/guide/system-one.md`, `api/decision.md`, `api/client.md`, `api/native-api.md`, `api/errors.md`, `README.md`, and the `client.ts`/`system-one.ts`/`errors.ts` JSDoc all updated — every "Local-only / Ollama Cloud rejects /v1/systemone" claim and every "64 KiB without images, 32 MiB with" either/or cap statement is gone.
- The MCP `tools.json` and generated operations metadata now carry the cloud-capable environment and updated notes (regenerated, not hand-edited).
- The generated surface remains drift-free: `contract:validate`, `contract:diff`, and the clean-tree `contract:generate` gate all pass against the new IR.
