# ADR 0023: Cloud-vs-Local Tool-Replay Behavior

**Status:** Accepted (parallelToolCalls field implemented)
**Date:** 2026-10-05
**Deciders:** SDK maintainers
**Supersedes:** None
**Superseded by:** None

## Context

The second upstream digest flagged "Cloud vs. Local Tool-Replay Behavior" as a focus area for the next execution cycle. The concern is that models hosted on **Ollama Cloud** (via the `https://ollama.com` OpenAI/Anthropic-compatibility bridges) and models hosted **locally** (via the `http://localhost:11434` native API) may diverge in how they emit tool calls — specifically when the model decides to issue **parallel** tool calls vs **sequential** ones.

This is a real semantic question for any agent built on top of the SDK:

- **Local Ollama** (running open-weights models like Llama 3.x, Qwen 2.x, etc.): the model's tool-call behavior is determined by the model's own training and the `/api/chat` request shape. Some local models emit multiple `tool_calls` in a single assistant message; most emit one at a time.
- **Ollama Cloud** (running hosted proprietary models via the OpenAI/Anthropic compatibility bridges): the cloud provider's hosted model is the one deciding tool-call batching. OpenAI's GPT-4o and Anthropic's Claude both freely emit parallel tool calls; the cloud-side proxy translates them into Ollama's `tool_calls` array shape.

For an **agent loop** that dispatches tool calls via `ToolRegistry.executeToolCalls`, the two execution paths converge on the same array-of-`ToolCall` shape (see `src/tools/registry.ts`), but the **upstream emission** differs:

```ts
// Local Ollama (single tool call per turn):
{ message: { role: 'assistant', tool_calls: [{ function: { name: 'foo', arguments: {...} } }], done: true } }

// Cloud-via-OpenAI-compat (parallel tool calls in one turn):
{ message: { role: 'assistant', tool_calls: [{ function: { name: 'foo', ... } }, { function: { name: 'bar', ... } }], done: true } }
```

The SDK's `ToolRegistry` already handles both cases — it executes whatever calls the model emits in parallel via `Promise.all` (with optional `maxConcurrency` bounding — see `src/tools/registry.ts`). But the **determinism** of which case the caller gets is not documented anywhere, and downstream agent authors have no way to know in advance.

## Decision

**Document the behavior; expose a heuristic capability field; do not attempt to normalize it.**

The SDK will:

1. **Preserve the existing runtime semantics verbatim.** The `chat()` and `chatStream()` methods return whatever `tool_calls` array the server emits, with no SDK-side batching/unbatching. This matches the OpenAI and Anthropic SDK conventions and keeps the SDK a thin transport.

2. **Add a `ModelCapabilities.parallelToolCalls` field** (implemented in `src/capabilities/capabilities.ts`) reporting whether the configured model is known to emit parallel tool calls. The field is a `ParallelToolCallBehavior` union of `'yes' | 'no' | 'unknown'`, derived from:
   - The model family (extracted from `/api/show`'s `model_info.*.architecture`, with fallback to `details.family` then `details.families[0]`). Families known to ship with parallel-tool-call training: `qwen2`, `qwen2.5`, `qwen3`, `llama3.1`, `llama3.2`, `llama3.3`, `llama4`, `mistral`, `mixtral`, `hermes`, `command-r`, `command-r-plus`.
   - The model name (full string including `:tag`) — substring matches against `tool-use`, `tooluse`, `function-call`, `functioncall`, `instruct`, `hermes`, `command-r` catch fine-tunes whose base family isn't in the list but whose name advertises tool-use capabilities.
   - The runtime mode (local vs cloud — see `inferRuntimeMode()`). Cloud-mode + `supportsTools === true` → `'yes'` (the OpenAI/Anthropic compat bridges proxy to proprietary models that freely emit parallel tool calls). Cloud-mode + no tools capability → `'unknown'` (an embedding-only model on a cloud endpoint shouldn't claim parallel tool calls).

3. **Document the heuristic in the agent docs** (`docs-site/guide/agents.md`) so agent authors know to:
   - Default `maxConcurrency` on their `ToolRegistry` to `1` if they need strict sequential execution (regardless of what the model emits).
   - Default `maxConcurrency` to `undefined` (unbounded parallel) if they're fine with whatever the model emits.
   - Branch on `ModelCapabilities.parallelToolCalls` if they need to know in advance.

4. **Not implement client-side parallel-to-sequential conversion.** Some agent frameworks (e.g. LangChain) split a parallel-tool-call message into N sequential turns. We deliberately do NOT do this — it changes the model's perceived behavior, makes the SDK non-transparent, and complicates streaming. The model decides; the SDK respects the decision.

## Consequences

### Positive

- **Predictable, low-cost heuristic.** The `parallelToolCalls` field is computed from data already fetched by `detectModelCapabilities()` — no extra HTTP round-trip.
- **Cloud and local models behave identically at the SDK boundary.** A `chat()` call returns the same shape whether the underlying model is local Llama or cloud GPT-4o — only the array length differs.
- **Agents stay simple.** The `for await (const event of stream)` pattern already yields each `tool_call` event separately (see `src/streaming/normalize.ts`'s `mapChatChunk`), so consumers see one event per tool call regardless of whether they were emitted in parallel or sequentially.
- **Caller has the choice.** The field is advisory — callers can ignore it entirely and let the `ToolRegistry` execute whatever calls the model emits, or branch on it to set `maxConcurrency` upfront.

### Negative

- **Predicting parallel-tool-call behavior requires a heuristic.** The `ModelCapabilities.parallelToolCalls` field is best-effort — it's `'yes'`/`'no'`/`'unknown'`, and `'unknown'` is a legitimate answer for newly-published models. Agent authors who need hard guarantees must enforce them on their side via `maxConcurrency`.
- **Cloud-mode behavior depends on the cloud provider.** OpenAI-compat's tool-call batching follows OpenAI's conventions; Anthropic-compat's follows Anthropic's. The SDK does not normalize between them — callers using `client.openai.chatCompletion()` and `client.anthropic.createMessage()` may see different batching for "the same" prompt.
- **Conservative known-list.** Only families with a documented track record of parallel tool calls are in the `'yes'` list. New models default to `'unknown'` until someone adds them — this is intentional to avoid over-promising concurrency.

### Neutral

- **The SDK's contract is "transparent passthrough of `tool_calls`".** This ADR codifies what was already the de-facto behavior since Wave 1; the new `parallelToolCalls` field is purely additive — no breaking changes are introduced.

## Implementation Notes

- `ModelCapabilities.parallelToolCalls` is **implemented** as of commit on this PR branch. The field is part of the `ModelCapabilities` interface in `src/capabilities/capabilities.ts`.
- The detection matrix lives in two functions in `src/capabilities/capabilities.ts`:
  - `inferCloudParallelToolCalls(supportsTools)` — `'yes'` for tool-capable cloud models, `'unknown'` otherwise.
  - `inferLocalParallelToolCalls(model, family)` — `'yes'` if family is in `PARALLEL_TOOL_CALL_LOCAL_FAMILIES` OR the full model name (including `:tag`) contains any `PARALLEL_TOOL_CALL_NAME_HINTS` substring; `'unknown'` otherwise.
- The `ToolRegistry.executeToolCalls` method already supports a `maxConcurrency` option (see `src/tools/registry.ts`); agent authors can use it today to enforce sequential execution regardless of model behavior.
- The streaming pipeline in `src/streaming/normalize.ts`'s `mapChatChunk` already emits one `tool_call` event per call, so consumers see parallel calls as N separate events in a single chunk — see the `tool_call` event type in `src/streaming/types.ts`.
- `ParallelToolCallBehavior` is exported from the SDK's public entry point (`src/index.ts`).

## Alternatives Considered

1. **Client-side parallel-to-sequential conversion.** Rejected — changes model behavior, complicates streaming, breaks determinism.
2. **Server-side normalization in Ollama.** Out of scope for this SDK; the Ollama server's behavior is upstream.
3. **Ignoring the question entirely.** Rejected — agent authors have repeatedly asked about this; the ADR documents the answer so it stops being re-litigated.

## References

- `src/capabilities/capabilities.ts` — `detectModelCapabilities`, `inferLocalParallelToolCalls`, `inferCloudParallelToolCalls`, `ParallelToolCallBehavior`
- `src/tools/registry.ts` — `ToolRegistry.executeToolCalls` with `maxConcurrency` option
- `src/streaming/normalize.ts` — `mapChatChunk` emits one `tool_call` event per call
- `src/integrations/openai.ts` — OpenAI-compat client (cloud models)
- `src/integrations/anthropic.ts` — Anthropic-compat client (cloud models)
- ADR 0007 — Synthetic Tool-Call IDs (relevant because parallel tool calls need stable IDs for correlation)
- ADR 0011 — MCP Boundary and Agent Tool Preconditions
