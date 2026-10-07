# ADR 0024: Digest upgrades — universal vision resolver, dual-mode Responses bridge, KV-cache sessions, context safety, blob publishing

Date: 2026-10-07

## Status

Accepted

## Context

An upstream review of the official Ollama documentation surfaced five gaps
between the documented platform conventions and this SDK:

1. **Vision ingestion.** The docs' vision page states SDKs are expected to
   accept polymorphic image sources (local paths, URLs, byte buffers) while
   the REST API strictly requires raw base64 strings (no data-URI prefixes).
   Our `encodeImage` handled only pre-encoded strings and `Uint8Array`.
2. **Responses API ergonomics.** `POST /v1/responses` (added in Ollama
   v0.13.3) was reachable only through the wire-compatible
   `OpenAICompatClient` with OpenAI-shaped types, and only natively — older
   servers answered 404 with no recourse.
3. **KV-cache visibility.** Ollama reuses the KV cache by prompt-prefix
   matching and reports reuse via `prompt_eval_cached_count`, but nothing in
   the SDK helped callers _keep_ a stable prefix or _see_ degradation.
4. **Context-window safety.** With `num_ctx` unset, Ollama silently truncates
   oversized prompts under its default 2048–4096 window — a correctness bug
   in caller applications that nothing surfaced.
5. **Blob management.** `/api/blobs/:digest` existed as raw methods, but the
   documented custom-model protocol (SHA-256 content addressing, upload,
   `/api/create` with `files: {name: digest}`) required manual caller
   orchestration.

## Decision

### 1. Universal vision resolver (`src/vision.ts`)

`VisionInput = string | Buffer | Uint8Array` accepted anywhere `images` is.
String resolution order: data-URI (strip header) → http(s) URL (fetch via
global `fetch`, abortable through the request's signal) → image-extension
path (dynamic `node:fs` import, Node only; graceful passthrough fallback when
the read fails, matching the documented convention; descriptive error in
runtimes without `fs`) → assume raw base64.

Extension-based path detection (not "contains a slash") because `/` is a
legal base64 alphabet character — a contains-slash heuristic would misfire on
long payloads. The request pipeline (`withEncodedImages`) stays
allocation-free when every entry is already base64 (same-reference return),
preserving the hot path for existing callers. Backward compatible: every
previously valid input behaves identically or strictly better (data-URI
strings, which previously produced broken requests, are now fixed).

### 2. Dual-mode Responses bridge (`src/responses.ts`)

New `client.responses` module (ergonomic, OpenAI-SDK-shaped: `input`,
`instructions`, `tools`, `max_output_tokens`, `reasoning_effort`, `think`).
Transport: native `POST /v1/responses`; on `OllamaNotFoundError` (404 —
endpoint absent, pre-v0.13.3) re-issue through `/api/chat` mapping
`instructions` → system message and `max_output_tokens` → `num_predict`;
normalize the reply back into the Responses shape (`output_text`, OpenAI
usage naming). The result's `transport` field records the path taken.

404-only fallback, deliberately: 5xx stays a retryable server error for the
existing retry policy, and 4xx is a request bug — neither means "endpoint
doesn't exist." In `stream()`, fallback triggers only when _establishing_ the
native stream fails, never mid-iteration — a consumer who already received
deltas must not silently receive them again. The full wire-shaped surface
remains on `client.openai.responses()`; this module is the migration subset,
not a replacement.

### 3. KV-cache sessions (`src/conversation.ts`)

`ConversationSession` (via `client.session(model, systemPrompt?)`): system
prompt pinned at construction (no mutation API — a mutable system prompt is
the #1 prefix killer), append-only frozen history, per-turn overrides that
ride on the request rather than the history. Per-turn and cumulative cache
stats. Hit-rate denominator is `cached / (cached + evaluated)` — when the
entire prompt hits the cache Ollama reports `prompt_eval_count: 0`, so
dividing by `prompt_eval_count` alone would score the best case as 0%.

### 4. Context-window safety (`src/context-safety.ts`)

CJK-aware heuristic estimation (~1 token/CJK char, ~4 chars/token elsewhere,
fixed per-image budget, per-message overhead, tool schemas) — no tokenizer
download, ±20–30%. Pre-flight on every `chat`/`generate`: warn at 90% of the
effective window (`contextWarningThreshold`), or throw client-side with
`onContextOverflow: 'throw'`. Window resolution order: request `num_ctx` →
client `defaultContextLength` (injected as `num_ctx` when the request omits
it — making the window explicit instead of server-default guesswork) →
conservative 2048 fallback, which warns only when the estimate _outright
exceeds_ it (no threshold margin — the real default may be 4096, and a
margin would generate false positives).

### 5. Blob publishing (`src/models-client.ts`)

`computeBlobDigest` (Web Crypto `subtle.digest` — global in Node ≥ 20 and
every browser/edge runtime; locally-declared structural type because the
project `lib` has no DOM), `createBlobFromData` / `createBlobFromFile`
(HEAD-check, skip upload when present — re-uploading existing blobs wastes
bandwidth and quota; `BlobUploadResult.alreadyExisted` reports which
happened), and `createModelFromGguf` (upload each shard, then
`/api/create` with `files: {basename: digest}` — verified against the
official API reference: "push a blob for each file and then use its file
name and SHA256 digest in the `files` field").

## Consequences

- Five new modules, all behind the existing `OllamaClient` surface:
  `client.responses`, `client.session()`, vision resolution in the request
  pipeline, pre-flight checks in `chat`/`generate`, blob helpers on
  `ModelsClient`. No breaking changes; existing exports untouched.
- `images` type widened from `(string | Uint8Array)[]` to `VisionInput[]` —
  strictly additive (`Buffer` is structurally a `Uint8Array`).
- `defaultContextLength` changes the wire body (injects `num_ctx`) only for
  callers who opt in; default behavior is unchanged.
- 50 new unit tests (mocked fetch — CI-safe, no daemon), all 739 tests green.
- The estimators and cache stats are heuristics/observability, not billing
  data — documented as such, with `prompt_eval_count` pointed to for exact
  numbers.
