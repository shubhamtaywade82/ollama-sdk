# ADR 0029: Public testing subpath & speculative-draft conveniences

**Status**: Accepted
**Date**: 2026-10-12
**Context**: October 12 digest — "Speculative Decoding & Draft Model Creation"

## Context

The digest made three claims about gaps between the official Ollama
specifications and this SDK, each audited against the codebase and the
official docs (fetched live, 2026-10-12) before any implementation:

1. **"SDK types only expose `files` and base `quantize`" for draft
   assembly** — **stale**. The official OpenAPI snapshot this repo pins
   (2026-10-07) carries `draft_files` + `draft_quantize` on the create
   schema, and the contract-first pipeline already surfaced them on the
   generated `CreateRequest`, the hand-written `CreateRequestOptions`, and
   the `native.yaml` parity list. The live `docs/openapi.yaml@main` is
   unchanged in this area.
2. **"`PARAMETER draft_num_predict` omitted in client creation types"** —
   **mostly stale**. The runtime `ModelOptions.draft_num_predict` has been
   typed and documented since before this digest, and create-time
   `parameters` is a `Record<string, unknown>` that accepts every Modelfile
   `PARAMETER` by design. One digest claim about upstream was itself
   inaccurate: the "DRAFT `<model_or_path>`" Modelfile **instruction** it
   describes does not appear in the current official Modelfile reference —
   only the `draft_num_predict` parameter does (and the rendered
   `docs/api.md` documents `draft_num_predict` as a runtime `options` field,
   ahead of the OpenAPI schema, which the SDK's hand-written `ModelOptions`
   already covers).
3. **"Consumers write custom ad-hoc mocks"** — **the real gap**. The repo
   has a capable in-memory mock server (`test/mocks/ollama-mock-server.ts`:
   scriptable NDJSON routes, inter-chunk delays, connection drops, request
   body capture) used by its own suite, but it is internal: consumers
   testing their Ollama integrations had nothing importable and would have
   to hand-roll HTTP stubs.

The digest also carried two "tomorrow's focus" items: measuring speculative
speedup telemetry, and tool-call mock scenarios (parallel calls, mid-stream
error injection).

## Decision

### Promote the mock engine — don't fork it

Same discipline as ADR 0027 (`runToolLoop`) and ADR 0028
(`LoadBalancedOllamaClient`): when the repo already has the engine, promote
and extend it rather than shipping a second, weaker implementation. The
digest's proposed `MockOllamaServer` (three hardcoded routes, no scripting)
is strictly less capable than what already exists.

Concretely: the engine moves to `src/testing/mock-server.ts` behind a new
`@nemesis-oss/ollama-sdk/testing` subpath export; the internal
`test/mocks/ollama-mock-server.ts` becomes a re-export shim, so the SDK's
own test suite exercises byte-for-byte the code consumers import. The
public surface adds what a consumer test suite needs on day one:

- `createMockOllamaServer(options?)` factory (the digest's requested API),
  with **default routes** answering the official liveness probe (`HEAD /`,
  `GET /` → the plain-text body "Ollama is running") and
  `GET /api/version` — so `client.ping()` (v1.12.0) works against a fresh
  mock with zero setup. Registered routes always win; `defaultRoutes: false`
  restores bare behavior.
- **Request recording** (`server.requests`, `clearRequests()`) for
  wire-level assertions, covering default-route hits and 404s as well.
- **In-band mid-stream error injection**
  (`injectErrorFrame: { message, after? }`): an `{"error": "..."}` NDJSON
  frame at HTTP 200 — how a real daemon reports GPU OOM mid-generation, and
  the exact scenario `OllamaStreamError` trapping exists for. The default
  injection point is `chunks.length - 1`, i.e. content frames, then the
  error frame, and **no** `done` frame: an error frame after `done` would be
  unread (the stream has already completed cleanly and the reader never sees
  the error) — a subtlety the first implementation got wrong and the tests
  now pin. `after: 0` errors before any content.
- A `rawBody` route option for exact non-NDJSON bodies (the liveness body
  is "Ollama is running" byte-for-byte, no trailing newline).
- **Chunk builders**: `mockChatChunk`, `mockTextChunks`, and
  `mockToolCallChunks` — the last emitting parallel tool calls complete in
  one frame, the documented native behavior, for deterministic tool-execution
  tests (the digest's tool-call scenario focus item).

### Keep the main entry Edge-safe

The testing module builds on `node:http`, which browsers and Edge runtimes
reject. It therefore lives **only** behind the dedicated subpath: a new
tsup entry + `exports["./testing"]` condition pair, never imported from
`src/index.ts`. `verify:edge-runtime` bundles the main entry for a browser
platform and would fail the build on any regression of that boundary. The
consumer-type verification now also compiles a real CJS (node16) and ESM
(nodenext) consumer importing the subpath, so the `.d.ts`/`.d.cts` pair is
proven, not assumed.

### Complete the speculative-decoding story instead of re-adding types

With the typing claims stale, the real work on the speculative side is the
convenience flow and discoverability:

- `CreateModelFromGgufOptions.draftGguf` — draft shards by local path,
  uploaded into `draft_files` exactly like primary shards, merged with any
  explicit digest map, `draft_quantize`/`parameters.draft_num_predict`
  passthrough, and no `draft_files` key on the wire when no draft is given.
- JSDoc on `CreateRequestOptions.parameters` (draft_num_predict semantics:
  separate drafts default 4, `0` disables, MTP tensors require explicit
  setting) and on `draft_files`/`draft_quantize` (verification semantics —
  draft tokens are verified, never returned, so aggressive draft compression
  is usually safe).
- Wire tests pinning the request bodies, and
  `lab/15-speculative-draft/measure-draft-speedup.ts` — a live harness
  comparing `draft_num_predict` settings with median `tokensPerSecond` via
  `formatTelemetry` (the digest's telemetry focus item; it needs a live
  daemon with a real draft network, hence a lab scenario rather than CI).

## Consequences

- Consumers get a first-class testing story without depending on
  internals or hand-rolling stubs; the SDK dogfoods the identical engine,
  so mock behavior can't drift from what consumers test against.
- The public surface adds one subpath and one options interface
  (`CreateModelFromGgufOptions`); everything else extends existing types
  additively. No breaking changes.
- The `injectErrorFrame` default (before the final `done` frame) is a
  semantic choice pinned by tests: it models the realistic crash and keeps
  the error observable; "error after done" is unreachable by design.
- The mock server remains single-process, Node-only, and explicitly not a
  load-testing tool.
