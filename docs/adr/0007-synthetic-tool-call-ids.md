# ADR 0007: Synthetic Tool-Call IDs

## Status

Accepted

## Context

Ollama's native `/api/chat` tool-calling protocol does not assign an identifier to a tool
call — a model turn's `tool_calls` array has no per-call ID the way OpenAI's
`tool_calls[].id` / `tool_call_id` does. ADR-adjacent documentation added alongside PR #6
(see the `ToolCall` type docs prior to this ADR) treated this as settled: `ToolRegistry`
correlates calls and results purely by array position, and that was judged sufficient
since execution order is preserved end-to-end.

That's still true as an execution model, but it left a real gap for consumers who need a
stable identifier for a call independent of array position — building an OpenAI-shaped
transcript, logging/tracing tool calls by ID, or just not wanting to zip two arrays by
hand to figure out which result answers which call. Every other major provider's tool-
calling protocol (OpenAI, Anthropic's `tool_use.id` / `tool_result.tool_use_id`) exposes
exactly this, so its absence here was a real interop gap, not just a documentation one.

## Decision

`src/tools/tool-call-id.ts` adds `generateToolCallId()` and `ensureToolCallIds()`:

- `ToolCall` gains an optional `id?: string` field (`src/types.ts`). It is **client-side
  synthesized**, not read from Ollama's response — Ollama never sends one. The SDK
  generates one (`call_<uuid>`, via the global `crypto.randomUUID()`) the first time it
  sees a tool call without an `id`, and reuses that exact value everywhere else that call
  is referenced.
- Three call sites assign ids to a response's tool calls, each is idempotent
  (`tc.id ?? generateToolCallId()`) so re-processing an already-enriched call never
  replaces its id:
  - `OllamaClient.chat()`'s non-streaming path, before returning the response.
  - `normalizeChatStream` (`src/streaming/normalize.ts`), via a `withStableToolCallIds`
    wrapper around the chunk source — applied **once per chunk**, before that chunk
    reaches either the per-chunk event mapper (which emits the streamed `tool_call`
    event) or the aggregator (which builds the final `ChatStreamResult.message`). Both
    read the same chunk object; assigning ids anywhere else would let the streamed event
    and the final aggregated message end up with two _different_ ids for what should be
    the same call. Covered by a test that streams a tool call and asserts the id on the
    `tool_call` event matches the id on `stream.finalResult`'s message.
  - `Agent.runLoop` (`src/agent/agent.ts`), defensively, on `response.message.tool_calls`
    — `AgentChatClient` is a minimal interface any consumer can implement, not just
    `OllamaClient`, so `Agent` doesn't assume ids arrived pre-assigned.
- `ToolExecutionResult` (`ToolExecutionSuccess`/`ToolExecutionFailure`) gains an optional
  `toolCallId?: string`, echoing the originating `ToolCall.id` — populated by
  `ToolRegistry.executeToolCall` on both the success and error-handling paths, including
  the not-registered/validation-failure early exits.
- `Message` gains an optional `tool_name?: string` for native Ollama tool-result
  messages, and `Agent` sets it to `ToolExecutionResult.toolName` on each
  `role: 'tool'` history entry.
- `Message.tool_call_id?: string` is retained as **SDK-local compatibility metadata** for
  existing transcripts and consumers. `OllamaClient.chat()` strips it from native
  `/api/chat` request bodies, so the SDK does not send an undocumented OpenAI-style field
  to Ollama. OpenAI compatibility uses its own `OpenAIMessage.tool_call_id` field.
- The `execute_tool` OTel span (ADR 0005) gains a `gen_ai.tool.call.id` attribute when the
  call has an id, matching the OpenTelemetry Gen AI semantic conventions.
- `id` is **optional**, not required, on `ToolCall` — so existing code that constructs a
  `ToolCall` object literal directly (tests, `ToolRegistry.executeToolCall` called
  directly rather than through `Agent`) keeps compiling unchanged; ids just won't be
  populated unless something in the SDK's own response-handling path assigned one.

## Rationale

- **Global Web Crypto `crypto.randomUUID()`, not `node:crypto`.** `node:crypto` is a Node
  built-in that would fail to resolve when this package is bundled for an Edge Runtime
  (Cloudflare Workers, Vercel Edge) — exactly the regression class ADR 0006's
  `verify:edge-runtime` check exists to catch. `crypto.randomUUID()` is a Web Standard
  API present as a global in Node 20+, browsers, and every Edge runtime `@edge-runtime/vm`
  models (it's part of `EdgePrimitives`), so it works everywhere this SDK already claims
  to run without any environment branching. Re-ran `verify:edge-runtime` after this change
  specifically to confirm the sandboxed Edge VM can call it — it can.
- **Optional, not required, and never overwritten.** Making `id` required would be a
  breaking change to a type used throughout the test suite and any consumer's own tool-
  handling code that constructs `ToolCall` literals directly. Making assignment
  idempotent (`tc.id ?? ...`) rather than unconditional keeps a caller-supplied id (e.g. a
  test asserting on a specific id, or a future world where Ollama does start sending one)
  intact instead of being silently replaced.
- **Enrichment lives in the SDK's response-handling paths, not in `ToolRegistry`
  itself.** `ToolRegistry.executeToolCall` only _echoes_ `toolCall.id` — it does not
  generate one. A registry that invented ids for calls it didn't receive one for would
  make `ToolRegistry` behave differently depending on whether it's driven by `Agent` (ids
  already assigned) or called directly with a hand-built `ToolCall` (no id, and none
  invented) — an inconsistency not worth introducing when the actual response-handling
  call sites (`OllamaClient.chat`, stream normalization, `Agent`) are few and are the
  natural place ids should originate anyway, mirroring where a real provider's IDs would
  arrive from (the response), not from execution.
- **This does not change dispatch/correlation semantics, only adds a convenience on
  top.** `ToolRegistry.executeToolCalls` still returns results in call order — that
  guarantee isn't replaced by `id`, both exist simultaneously. Consumers can keep
  correlating by array position (as before) or switch to `toolCallId`/`tool_call_id`
  matching; neither is deprecated in favor of the other.

## Consequences

- `ToolCall.id`/`Message.tool_call_id`/`ToolExecutionResult.toolCallId` are new optional
  fields on existing public types — additive, not breaking, but they are now part of the
  public API surface and returned by default from every `OllamaClient.chat`/`chatStream`
  call that includes tool calls, whether or not the consumer asked for id correlation.
- Native `role: 'tool'` history messages now carry the documented `tool_name` field.
  The SDK-local `tool_call_id` correlation value is not transmitted to Ollama. A regression
  test asserts the exact serialized request body for an Agent tool round trip.
- Ids are generated per-process, in-memory, with no persistence or cross-process
  stability — a call replayed from a saved transcript or reconstructed in a different
  process will get a _different_ synthesized id than it had originally. This matches how
  execution-order correlation already worked (also not persisted) and is not a regression,
  but is worth knowing if an application builds any kind of durable, id-keyed store around
  these values.
