# ADR 0027: Agent cycle detection, URL-join hardening, and vision-history hygiene

Date: 2026-10-09

## Status

Accepted

## Context

The October 9 daily production-readiness audit targeted higher-level
orchestration: autonomous tool-calling loops, memory retention in recursive
multi-turn sessions, and transport behavior behind reverse proxies. As with
prior audits, each finding was verified against the codebase before any
implementation — and the verification materially changed what was built:

1. **AGN-01 (P1) — "unbounded tool execution recursion; no SDK-native,
   boundary-checked execution runner."** Stale in its core claim: `Agent`
   has been a bounded runner since its introduction — `maxIterations`
   (default 10, `OllamaAgentMaxIterationsError`), an opt-in `maxToolCalls`
   budget (`OllamaAgentMaxToolCallsError`), and registry-side encapsulation
   of every tool failure (unregistered names → `OllamaNotFoundError`
   results, argument-validation failures, timeouts, thrown errors) as
   failed `ToolExecutionResult`s fed back as `role: 'tool'` messages — the
   loop never crashes on a tool rejection. **Real gap:** nothing
   distinguished a _stuck_ model (re-emitting one identical call, ignoring
   its own results) from a merely slow one — both burned the full iteration
   budget, with the generic max-iterations error hiding the diagnosis.

2. **URL-01 (P2) — "subpath reverse-proxy stripping during URL resolution;
   `new URL(endpoint, host)` strips path prefixes."** Stale as a defect
   claim: no request path in the SDK is built with `new URL(path, base)`.
   `HttpClient` concatenated `baseUrl + path` as strings, and
   `normalizeBaseUrl` already preserved path prefixes (unit-tested, e.g.
   `proxy.internal:8080/ollama/` → `http://proxy.internal:8080/ollama`).
   **Real gaps:** the join invariant ("exactly one slash between base and
   path") was implicit — a trailing-slash base or a future call site
   passing a path without its leading slash would silently produce
   `host//api/chat` or `hostapi/chat` — and no test proved a gateway
   subpath base end-to-end through `OllamaClient` on the wire.

3. **CTX-01 (P2) — "appending messages in-place mutates caller arrays;
   vision image base64 buffers retained across turns."** Half stale: every
   mutation claim is false — `Agent` copies `input.messages`,
   `ConversationSession` freezes messages and copies on read,
   `client.chat` maps encoded messages into new arrays, and
   `withEncodedMessageImages` is allocation-free on passthrough. **Real
   gap:** for consumer-managed vision histories there was no way to evict
   stale image payloads — `/api/chat` is stateless, so every prior base64
   image is re-sent and re-billed (context tokens, upload bytes, heap)
   on every turn, forever.

## Decision

### 1. Cycle detection: `maxRepeatedToolCalls` + `OllamaAgentToolLoopError`

`Agent` gains an opt-in per-signature execution budget:
`AgentConfig.maxRepeatedToolCalls` (positive integer; `undefined` = off).
A call's identity is its **canonical signature** —
`canonicalToolCallSignature()` (exported) renders `name(args)` with
recursively key-sorted arguments, so a model re-emitting the same call in a
different key order still counts as the same call, while different
arguments (a progressing loop) never trip the guard.

Enforcement is batch-preflight, mirroring the existing `maxToolCalls`
semantics: before a turn's calls execute — and before `onToolCallStart`
fires, keeping hook pairing consistent — each call's prospective count is
computed (duplicate calls within one batch see each other); the first that
would exceed the budget throws `OllamaAgentToolLoopError`
(`code: 'agent_tool_loop_detected'`, never retryable) carrying `toolName`,
`repeatedExecutions`, `maxRepeatedToolCalls`, and the canonical signature
(truncated at 200 chars for log hygiene). Failed, unregistered, and
timed-out executions count: re-calling a failing tool with unchanged
arguments is precisely the pathological loop being caught.

Why opt-in rather than default-on: consistency with `maxToolCalls` and the
SDK's explicit-guardrail philosophy (ADR 0026's compaction precedent) —
new throw-by-default behavior in a minor release is a compatibility hazard
the SDK doesn't take, and the right threshold is workload-specific (a
retrying data-entry agent tolerates more repeats than a search agent).

### 2. `joinUrlPath` — one owner for the URL-join invariant

`src/transport/url.ts` exports `joinUrlPath(baseUrl, path)`, which collapses
trailing/leading slashes and joins with exactly one slash; all three
`HttpClient` request methods (`request`, `requestSseStream`, `requestStream`)
now route through it instead of raw template concatenation. Behavior for
every well-formed input is byte-identical to before; the change hardens the
invariant against future call sites and concentrates the reverse-proxy
contract in one auditable place, documented with the WHY (the WHATWG
`new URL(path, base)` hazard) at the point of use. Tests pin the join at
three levels: `joinUrlPath` units (including the audit's exact
`https://gateway.internal.corp/ai/ollama` scenario and a hazard-regression
test showing what `new URL` would have done), `HttpClient` transport URLs,
and end-to-end `OllamaClient` wire URLs for `/api/chat`, `/api/generate`,
and OpenAI-compat `/v1/chat/completions` under a subpath base.

### 3. `sanitizeHistoryForNextTurn` — opt-in vision-history hygiene

A pure helper in `src/conversation.ts`: returns a copy of a message array
with `images` evicted from every message outside a trailing keep-window
(`keepImagesOnLastMessages`, default 1 — the rolling one-image window),
conversation text fully preserved, with an optional `imagePlaceholder`
note appended so the model can tell an image used to exist. Input arrays
are never mutated; untouched and kept messages are reused by reference.

Same decision shape as compaction (ADR 0026): **caller-initiated, never
automatic**, because the tradeoffs are real and workload-specific — the
model loses access to evicted images (fading visual memory in exchange for
a bounded payload), and eviction rewrites the message at that position,
invalidating the KV prompt prefix from that point (a hot cache-friendly
session shouldn't sanitize; a growing vision session should). The helper is
for consumer-managed arrays; `ConversationSession` accepts only text turns
today and is unaffected.

## Consequences

- `OllamaAgentToolLoopError` joins the public error hierarchy
  (`agent_tool_loop_detected`), documented in `docs-site/api/errors.md`;
  `canonicalToolCallSignature`, `sanitizeHistoryForNextTurn`, and
  `HistorySanitizeOptions` join the public exports.
- The audit's proposed `runToolLoop()` helper was **not** added: `Agent`
  already is the SDK-native bounded runner, and a second orchestration
  entry point would fork the API surface (two ways to do the same thing)
  without adding a capability. The PR body maps the audit's requests to
  the existing surfaces.
- The URL-01 e2e tests double as a permanent contract for gateway hosting;
  the README gained a "Hosting Behind a Reverse Proxy" section documenting
  the supported subpath configuration.
- Follow-up candidates recorded, not built: image-carrying turns in
  `ConversationSession` (would need an eviction policy decision of its
  own), and per-model repeat budgets if workload evidence ever demands
  them.
