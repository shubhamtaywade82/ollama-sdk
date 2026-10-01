# ADR 0021: Conformance Testing Against a Real Ollama Server

## Status

Accepted

## Context

The contract-first architecture (ADRs 0013-0020) verifies the SDK against
the OpenAPI spec + the rendered docs at `docs.ollama.com`. But neither of
those is the actual server. There are three places drift can hide:

1. **Contract vs docs** — caught by `verify:contract-parity` (Wave 7).
2. **Generated code vs contract** — caught by the `contract:diff` and
   `contract:generate` idempotency gates added in v1.5.1.
3. **Server vs contract** — NOT caught. If Ollama ships a release where
   `ChatResponse.done_reason` returns `null` instead of `string`, or
   `/api/embed` adds a new field the OpenAPI spec doesn't yet list,
   nothing in the current pipeline notices until a user reports it.

The existing VCR-based tests (`test/vcr.ts` + `test/fixtures/cassettes/`)
record real interactions once and replay them — they catch regressions
in the SDK's handling of _known_ shapes, but they can't catch drift in
the server's actual output because the cassettes are frozen snapshots.

## Decision

Add a conformance test suite that hits a real Ollama server and asserts
every response matches the IR-generated Zod schema.

### Suite structure

- **Location**: `test/conformance/` (separate from the main `test/` dir
  to make the intent clear and to allow independent invocation)
- **Harness**: `test/conformance/harness.ts` provides:
  - `conformanceBaseUrl()` — reads `OLLAMA_BASE_URL` (defaults to
    `http://localhost:11434`)
  - `isOllamaReachable()` — probes `/api/version` once, caches the result
  - `setupConformance()` — returns `{ client, api, baseUrl }` or
    `undefined` when unreachable
  - `describeConformance()` / `itConformance()` — wrappers that skip
    cleanly (with a printed reason) when Ollama isn't running
- **Test file**: `test/conformance/native-api.test.ts` covers:
  - Every native REST endpoint with a Zod response schema
  - Streaming chat (every chunk validated against `ChatResponseSchema`)
  - Shape parity between `OllamaClient` (legacy) and `NativeApi` (generated)
    for `chat()` and `version()` — confirms the Wave 8 deprecation path
    won't silently break callers

### Skip behavior

When Ollama isn't running, every conformance test calls `ctx.skip()`
(vitest's runtime skip) and prints a clear reason to stderr. The main
`npm test` run reports them as `10 skipped` — visible but non-blocking.
This means:

- `npm test` (default): 302 passed, 10 skipped — conformance is visible
  but doesn't block local development
- `npm run test:conformance`: runs only the conformance suite; fails
  if any test fails OR if Ollama isn't reachable (the skips become
  visible as "10 skipped" which a CI gate can opt to fail on)
- CI `conformance` job: installs Ollama, pulls models, runs the suite —
  failures block the PR

### CI integration

A new `conformance` job in `.github/workflows/ci.yml` (needs: `test`,
so it only runs after the main suite passes):

1. Install Ollama via the official install script
2. Start `ollama serve` in the background
3. Wait for `/api/version` to be reachable (up to 30s)
4. Pull `qwen3:0.6b` and `nomic-embed-text:latest` (small models)
5. Run `npm run test:conformance` with `OLLAMA_BASE_URL` set

The job runs on every PR and push. Model pulls add ~30-60s to the CI
run; the tradeoff is catching wire-level drift before it ships.

### What the suite catches

- **Schema violations**: if Ollama returns a field with the wrong type
  (e.g. `done_reason: null` instead of `string`), the Zod `safeParse`
  fails and the test reports the exact issue.
- **Missing fields**: if the server omits a field the schema marks as
  required, the test fails.
- **Extra fields**: Zod's default behavior strips unknown fields — this
  doesn't fail, but a future "strict mode" could opt into
  `.strict()` parsing to catch them.
- **Shape parity**: the `OllamaClient vs NativeApi` tests confirm the
  two surfaces return structurally identical responses, validating the
  Wave 8 deprecation path.

### What the suite does NOT catch

- **Performance regressions**: the suite asserts correctness, not speed.
  Benchmarks (`npm run bench`) cover that separately.
- **Behavioral semantics**: e.g. `tool_choice` actually controlling
  tool selection. The suite checks the response _shape_, not whether
  the model followed instructions. That's the agent test suite's job.
- **Streaming event ordering**: the suite validates every chunk against
  the schema but doesn't assert specific event sequences (e.g. "thinking
  before token"). That would require model-specific assertions that
  drift with model updates.

## What changed

### Added

- `test/conformance/harness.ts` — shared setup + skip logic
- `test/conformance/native-api.test.ts` — 10 conformance tests covering
  version, tags, ps, show, chat, generate, embed, streaming chat, and
  OllamaClient/NativeApi shape parity
- `npm run test:conformance` script
- `conformance` job in `.github/workflows/ci.yml`
- ADR 0021 (this file)

### NOT changed

- `npm test` (default) — unchanged behavior; the 10 conformance tests
  are picked up by vitest's default glob but skip cleanly
- `package.json` `verify` script — unchanged; conformance runs in CI
  only, not as part of the local `npm run verify` chain

## Consequences

- The conformance suite is the third leg of the contract enforcement
  stool: contract vs docs (Wave 7), generated vs contract (v1.5.1),
  and now server vs contract (Wave 11).
- Wire-level drift is caught at PR time, before it reaches consumers.
  Previously it would only be caught when a user reported it.
- The CI `conformance` job adds ~60-90s to the total CI run (model
  pulls + test execution). This is acceptable given the value.
- Local developers without Ollama installed see `10 skipped` in their
  test output with a clear reason — no friction, no false failures.
- When Ollama adds a new field to a response, the conformance test
  passes (Zod strips unknown fields by default). To catch _new_ fields
  that should be added to the contract, a future wave could add a
  `.strict()` mode that fails on unknown keys — but that's a separate
  decision (see "What the suite does NOT catch" above).

## Reference

- ADR 0014 — Generated surface and runtime seam (the `NativeApi` tested here)
- ADR 0019 — Zod schema generation (the schemas used for assertion)
- ADR 0020 — Runtime Zod validation (the schema registry consulted)
