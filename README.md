# @nemesis-oss/ollama-sdk

[![CI](https://github.com/shubhamtaywade82/ollama-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/shubhamtaywade82/ollama-sdk/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@nemesis-oss/ollama-sdk.svg)](https://www.npmjs.com/package/@nemesis-oss/ollama-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> Production-grade TypeScript SDK for Ollama. Built with native fetch, high availability failover, multi-turn tool calling, structured outputs with Zod, reasoning stream tokens, OpenAI & Anthropic compatibility bridges, MCP integration, and Web Stream adapters.

---

## Key Features

- 🚀 **Native Web Standards**: Built on native `fetch` and Web Streams. Zero external HTTP dependencies.
- 🧠 **Reasoning & Thinking Tokens**: First-class support for reasoning models (`qwen3:8b`, `deepseek-r1:8b`) via the native `think` parameter, with discrete `thinking` and `token` streaming events, plus `logprobs`/`top_logprobs` for token-level confidence scoring.
- 🖼️ **Multimodal / Vision Input**: `images` on `Message`/`generate()` is a universal resolver — pass raw base64 strings, `data:image/...;base64,` data URIs, `http(s)://` URLs (fetched), local file paths (`.png`/`.jpg`/`.webp`/…, read via `node:fs` on Node), or raw `Buffer`/`Uint8Array` bytes — everything is normalized to the raw base64 Ollama's REST API expects, matching the official SDK vision convention.
- 🎯 **Zod-Powered Structured Outputs**: Strictly typed schema enforcement via `chatWithSchema` and `generateWithSchema` with resilient markdown JSON parsing.
- 🛠️ **Autonomous Agent & Tool Calling**: Multi-turn agent loop (`Agent`) with automated tool execution, parameter validation, and self-correcting error recovery.
- 🌐 **High Availability & Failover**: Multi-endpoint registry with priority routing, circuit breaker failover, active health checks, and per-endpoint `models` allow-lists for routing several model-specific API keys through one client.
- 🔌 **Model Context Protocol (MCP)**: First-class, transport-neutral `McpBridge` for converting MCP tool descriptors into Ollama function definitions and registering executable MCP-backed tools.
- 📚 **Full Model Lifecycle**: `pullModel`, `pushModel`, `createModel`, `copyModel`, `deleteModel`, `listModels`, `showModel`, and `ps()` (currently loaded models) — full parity with Ollama's model management API.
- 🔎 **Ollama Cloud Web Tools**: `webSearch`/`webFetch` wrap Ollama's hosted `/api/web_search` and `/api/web_fetch` tools at `ollama.com` (requires an `OLLAMA_API_KEY`), independent of any local `baseUrl`.
- 💳 **Ollama Cloud Usage & Balance**: `usage()`/`balance()` wrap Ollama's hosted account endpoints (`GET /api/usage`, `GET /api/balance`) — request counts, USD spend, cached-token totals bucketed by hour/day, and remaining included/purchased credits (including the legacy session/weekly plan shapes) — with the same fixed-cloud-host, API-key, timeout, and retry semantics as the web tools.
- 🌉 **OpenAI & Anthropic Compatibility Bridges**: Built-in clients for `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/v1/messages`, including `reasoning_effort`/`reasoning.effort` for thinking models — plus an ergonomic dual-mode `client.responses.create()` bridge that prefers native `/v1/responses` and transparently re-issues via `/api/chat` on older servers (pre-v0.13.3).
- 💬 **KV-Cache-Aware Conversation Sessions**: `client.session(model, systemPrompt)` keeps an append-only, prefix-stable history that maximizes Ollama's KV-cache reuse across turns, surfaces per-turn + cumulative cache hit rates (`prompt_eval_cached_count`) so cache degradation is visible instead of silent, and offers a one-call `compact()` sliding-window escape hatch when a session outgrows its window.
- 🛑 **Context-Window Safety**: Heuristic client-side token estimation warns (or throws, `onContextOverflow: 'throw'`) before a request is sent when the prompt approaches the effective `num_ctx` window — Ollama's default behavior is to _silently truncate_ oversized prompts — and `defaultContextLength` makes the window explicit on every request.
- 📦 **Blob & Custom Model Publishing**: Content-addressed blob management per Ollama's documented protocol — `computeBlobDigest()` (SHA-256 → `sha256:<hex>`), `createBlobFromData()`/`createBlobFromFile()` (HEAD-check + upload, skipping existing blobs), and one-shot `createModelFromGguf()` (upload GGUF shard blobs, then `/api/create` with `files: {name: digest}`).
- 🧵 **Batched Embeddings with Backpressure**: `client.embedBatch()` splits corpora of any size into bounded `/api/embed` batches (default 32 inputs × 3 in flight) — order-preserving, fail-fast, progress-reporting — so RAG/vector ingestion can't OOM a local daemon or saturate `OLLAMA_MAX_QUEUE` the way `Promise.all` floods do, with per-string context-window pre-flight against silent truncation.
- 🧹 **Client Teardown (`destroy()`)**: One call aborts every in-flight request, active stream, and queued capacity waiter with `OllamaAbortError` — the clean-exit path for `worker_threads`, CLI runners, and short-lived scripts where dangling fetch bodies keep the event loop alive.
- 🧠 **Dynamic Context-Window Discovery**: `client.models.getContextLength({ model })` resolves the real window from the server — the allocated window of the running instance (`/api/ps`), the Modelfile `num_ctx` default, and the native GGUF maximum (`model_info`), in precedence order — so applications stop hardcoding 2048/4096 guesses.
- 🔁 **Model-Affinity Scheduling**: `ModelAffinityScheduler` runs multi-model workloads through per-model serial queues with a distinct-model cap (default 1), deepening the already-hot model before loading the next — the anti-thrashing order for `OLLAMA_NUM_PARALLEL`/`OLLAMA_MAX_LOADED_MODELS`-bounded daemons — and routes candidate lists to whichever model is already loaded.
- 🌊 **Web Stream Adapters**: Drop-in adapters (`toTextStream`, `toDataStream`, `toResponse`) for Next.js Route Handlers and Vercel AI SDK.
- 📈 **OpenTelemetry Instrumentation**: Automatic spans for HTTP requests, endpoint failover, chat/generate calls, and agent runs — zero-cost when OpenTelemetry isn't installed.
- 📊 **Client-Side Quota Monitoring**: `QuotaManager` tracks token/request usage against budgets you configure across rolling windows (e.g. Ollama Cloud's 5-hour session / 7-day weekly resets) and fails fast with `OllamaQuotaExceededError` before a request is sent.
- ⚡ **Edge Runtime Verified**: CI bundles and runs the client in a real Edge Runtime sandbox (Cloudflare Workers/Vercel Edge-compatible) with zero Node.js APIs.
- 📦 **Dual ESM & CJS Build**: Full module support with paired `.d.ts`/`.d.cts` declarations mapped through conditional `exports` — verified in CI by `@arethetypeswrong/cli` **and** by compiling real CommonJS (node16) and ESM (nodenext) consumer projects against the packed tarball.
- 🧩 **Contract-First Architecture**: A single canonical IR (`contracts/ir/ollama.ir.json`) drives TypeScript interfaces, generated API classes (`NativeApi`/`OpenAIApi`/`AnthropicApi`), MCP tool descriptors, Zod schemas, and field-level parity verification. New Ollama endpoints (like `/v1/systemone`) are caught automatically by bidirectional endpoint discovery. See [ADRs 0013-0019](./docs/adr/README.md).

---

### Contract parity verification

The repository keeps the Ollama compatibility contract in the canonical IR at
`contracts/ir/ollama.ir.json` (compiled from `contracts/sources/` + `contracts/overlays/`)
and checks it against the current official documentation with
`npm run verify:contract-parity`. Each operation's `parity:` block distinguishes
**supported**, **explicitly unsupported**, and **SDK-only** fields, and also tracks
documented response fields plus the public streaming-event union for compatibility
adapters. This prevents a field merely being mentioned in upstream documentation
from being mistaken for a supported Ollama feature.

For callers who want compile-time enforcement of the documented Ollama subset, the package
also exports strict request types such as `OllamaOpenAIChatCompletionRequest`,
`OllamaOpenAIResponsesRequest`, `OllamaOpenAIEmbeddingRequest`, and
`OllamaAnthropicMessagesRequest`. The broader compatibility request types remain
available for pass-through interoperability and vendor-specific fields.

### SSE Streaming Foundation

Compatibility endpoints use Server-Sent Events when `stream: true`. The SDK now exposes a provider-neutral `parseSseStream()` and `HttpClient.requestSseStream()`, plus typed adapters for OpenAI Chat/Completions/Responses and Anthropic Messages. Native Ollama NDJSON streaming remains separate.

```typescript
const stream = await client.openai.chatCompletions({
  model: 'qwen3',
  messages: [{ role: 'user', content: 'Explain SSE.' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}

const final = await stream.finalResult;
console.log(final.usage);
```

## MCP bridge

The SDK exposes a transport-neutral `McpBridge` that converts MCP `tools/list` descriptors into native Ollama function tools and registers executable MCP-backed tools. MCP tool arguments are validated against the advertised JSON Schema at the `ToolRegistry` boundary (including object, array, scalar, required, enum, and common numeric/string constraints).

- Paginated `tools/list` discovery follows `nextCursor`, with repeated-cursor and page-limit protection.
- MCP JSON Schema is preserved in the generated Ollama tool definition.
- `structuredContent` and non-text MCP content blocks are retained in the model-visible tool result.
- MCP `isError: true` results remain model-readable; they are not treated as transport failures.
- Manual `input_required` responses and legacy task creation/status results are preserved without silently polling.
- Tools declaring `execution.taskSupport: "required"` are invoked as tasks only when the server advertises task calls; optional task use is opt-in.

`loadMcpTools()` keeps the historical model-oriented string result by default. Set `resultMode: 'structured'` when application code needs the raw MCP `CallToolResult`, including `structuredContent`, content blocks, `isError`, and `_meta`:

```typescript
const tools = await loadMcpTools(mcpClient, { resultMode: 'structured' });
```

- Input JSON Schema validation happens before the MCP server is called, preventing invalid model-generated arguments from crossing the protocol boundary.
- `resultMode: 'structured'` is available for lossless programmatic access to raw MCP tool results while preserving the legacy text mode by default.
- `AbortSignal` propagates through discovery and tool execution.
- The optional Node-only `@nemesis-oss/ollama-sdk/mcp/stdio` subpath uses the official MCP v2 stdio transport without importing Node-only code from the root package.

For remote MCP servers, the optional `@nemesis-oss/ollama-sdk/mcp/http` subpath uses the official MCP client v2 transport. Streamable HTTP is the default; legacy SSE can be selected explicitly, or `transport: 'auto'` can try Streamable HTTP first and fall back to SSE only on a compatible non-authentication 4xx response.

```typescript
import { Agent, McpBridge, OllamaClient, ToolRegistry } from '@nemesis-oss/ollama-sdk';
import { connectMcpHttpClient } from '@nemesis-oss/ollama-sdk/mcp/http';

const connection = await connectMcpHttpClient({
  url: 'https://example.com/mcp',
  transport: 'auto',
  requestInit: {
    headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
  },
});

const bridge = new McpBridge(connection.client, { namePrefix: 'mcp_' });
const registry = new ToolRegistry();
await bridge.register(registry);

const agent = new Agent(new OllamaClient(), { tools: registry });
const result = await agent.run({
  model: 'qwen3',
  messages: [{ role: 'user', content: 'Use the MCP tools to complete this task.' }],
});

await connection.close();
console.log(result.finalMessage.content);
```

The stdio and HTTP connectors accept host-provided elicitation handlers. The requested modes are declared as client capabilities before connection, and the host retains control over user interaction. Form handlers should display and validate the requested fields; URL handlers should show the destination and obtain consent before accepting or opening it. No URL is opened automatically:

```typescript
const connection = await connectStdioMcpClient(
  { command: 'npx', args: ['-y', '@modelcontextprotocol/server-example'] },
  {
    elicitation: {
      form: async (request) => collectAndValidateForm(request),
      url: async (request) => {
        const approved = await askUserToOpen(request.url, request.message);
        return { action: approved ? 'accept' : 'decline' };
      },
    },
    inputRequiredMode: 'manual',
  },
);
```

`inputRequiredMode` defaults to `manual` on these connectors. The bridge forwards `input_required` results unchanged (use `resultMode: 'structured'` for raw values), including their opaque `requestState` and keyed `inputRequests`; it does not solicit data or retry the tool call itself. Set `inputRequiredMode: 'automatic'` to let the MCP client use the registered elicitation handlers and retry internally. In manual mode, the host can gather responses and retry with the same `requestState`:

```typescript
await connection.client.callTool(
  { name, arguments: args, inputResponses, requestState },
  { allowInputRequired: true },
);
```

For legacy task-capable servers, required task tools are invoked using task augmentation. Optional task-capable tools remain synchronous unless `taskMode: 'all-supported'` is set. Set `taskTtlMs` to request a task lifetime. Task creation and `input_required` task statuses are preserved (serialized as JSON in text mode); no polling starts automatically. The host controls progress with `bridge.getTaskStatus(taskId)`, retrieves a completed payload with `bridge.getTaskResult(taskId)`, and can stop work with `bridge.cancelTask(taskId)`.

Use `connection.terminateSession()` when the remote Streamable HTTP server exposes a session you want to terminate explicitly. Legacy SSE connections do not expose that method.

The MCP TypeScript SDK v2 treats Streamable HTTP as the preferred remote transport and keeps SSE as a legacy fallback during migration. citeturn514654search0turn514654search6

The MCP TypeScript SDK v2 implements the 2026-07-28 protocol revision. Its `listTools()` client path aggregates pagination, and `CallToolResult` represents tool failures as ordinary results with `isError`, while `structuredContent` is available for machine-readable output. citeturn0search0turn1search4turn0search6

### MCP stdio example

```typescript
import { connectStdioMcpClient } from '@nemesis-oss/ollama-sdk/mcp/stdio';
import { Agent, McpBridge, OllamaClient, ToolRegistry } from '@nemesis-oss/ollama-sdk';

const connection = await connectStdioMcpClient({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
});

const bridge = new McpBridge(connection.client, { namePrefix: 'mcp_' });
const registry = new ToolRegistry();
await bridge.register(registry);

const client = new OllamaClient();
const agent = new Agent(client, { tools: registry });
const result = await agent.run({
  model: 'qwen3',
  messages: [{ role: 'user', content: 'List the available files.' }],
});

await connection.close();
console.log(result.finalMessage.content);
```

## Installation

```bash
npm install @nemesis-oss/ollama-sdk zod
```

`zod` is a peer dependency (`^3.22.0 || ^4.0.0`) — install whichever major version your project already uses instead of getting a second copy bundled in.

---

## Quick Start

### Basic Chat & Completion

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

// Text helper
const answer = await client.chatText({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Explain quantum computing in one sentence.' }],
});
console.log(answer);
```

### Thinking & Reasoning Token Streams

`think` is Ollama's native reasoning-effort parameter, exposed directly on `chat()`/`generate()`. It accepts `true`, `false`, `null` (model default), or a model-defined string. Use `client.capabilities(model).thinking` to discover the exact string values and default reported by `/api/show`. The OpenAI bridge's `reasoning_effort`/`reasoning.effort` follows the same model-defined convention.

```typescript
const stream = await client.chatStream({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'What is 18 * 4?' }],
  think: 'high',
  options: { temperature: 0 },
});

for await (const event of stream) {
  if (event.type === 'thinking') {
    process.stdout.write(`\x1b[33m${event.data.delta}\x1b[0m`); // Thinking trace
  } else if (event.type === 'token') {
    process.stdout.write(event.data.delta); // Final answer token
  }
}

const final = await stream.finalResult;
console.log(`\nEval tokens/sec: ${final.usage?.tokensPerSecond}`);
```

### Cached Prompt Tokens

Ollama reports `prompt_eval_cached_count` as the number of prompt tokens read from the KV cache. The raw value is preserved on native chat/generate responses, and normalized stream usage exposes it as `cachedPromptTokens`.

```typescript
const res = await client.chat({
  model: 'gpt-oss:20b',
  messages: [{ role: 'user', content: 'hello' }],
});

console.log(res.prompt_eval_count, res.prompt_eval_cached_count);
console.log(res.prompt_eval_cached_count ?? 0);
```

### KV-Cache-Aware Conversation Sessions

Ollama reuses the model's KV cache across turns by **prompt prefix matching** — anything that mutates the prefix (changing the system prompt, injecting per-call timestamps, reordering past turns) invalidates the whole cache and forces a full re-evaluation. `client.session()` makes the cache-friendly structure the default: a system prompt pinned at construction, an append-only frozen history, and per-turn options that never touch the prefix.

```typescript
const session = client.session('llama3.1', 'You are a concise assistant.');

// Ergonomic path — just the reply text
await session.send('Hi!');

// Detailed path — per-turn KV-cache statistics + raw response
const turn = await session.sendTurn('Why is the sky blue?');
console.log(turn.cache);
// { cachedTokens: 48, evaluatedTokens: 6, hitRate: 0.89 }

// Cumulative view across the whole session
console.log(session.cacheStats);
// { turns: 2, cachedTokens: 48, evaluatedTokens: 54, totalPromptTokens: 102, hitRate: 0.47 }

session.reset(); // back to system-prompt-only, stats zeroed
session.getMessages(); // defensive copy of the frozen history
```

Note the hit-rate denominator: when the _entire_ prompt hits the cache, Ollama reports `prompt_eval_count: 0` — the session's `hitRate` adds both counters so the best case scores `1`, not `0`.

### OpenAI Responses API (dual-mode)

`client.responses.create()` gives migrating OpenAI code a small, familiar surface (`model`, `input`, `instructions`, `tools`, `temperature`, `top_p`, `max_output_tokens`, `reasoning_effort`, `think`) with **dual-mode transport**: the native `POST /v1/responses` endpoint is preferred (Ollama ≥ v0.13.3), and a `404` from older servers transparently re-issues the request through `/api/chat` — `instructions` mapped to a system message, the reply mapped back into the Responses shape. The result's `transport` field records which path served it.

```typescript
const res = await client.responses.create({
  model: 'gpt-oss:20b',
  input: 'Explain KV caches in one paragraph.',
  instructions: 'Be precise.',
  max_output_tokens: 256,
  reasoning_effort: 'medium',
});

console.log(res.output_text);
console.log(res.usage); // { input_tokens, output_tokens, total_tokens }
console.log(res.transport); // 'native' | 'chat-adapter'

// Streaming variant — simplified text/thinking deltas + final response
for await (const event of client.responses.stream({ model: 'qwen3', input: 'Tell me a haiku.' })) {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
  else if (event.type === 'done') console.log('\n', event.response.usage);
}
```

Ollama implements the Responses API **non-statefully** — `previous_response_id` and `conversation` don't exist, so send the full conversation in `input` every call (or use `ConversationSession` to manage it). For the full OpenAI-shaped surface (raw `output` items, SSE event objects), use `client.openai.responses()`.

### Context-Window Safety (silent-truncation guard)

With `num_ctx` unset, Ollama loads the model with a conservative default window (commonly 2048–4096 tokens) and **silently truncates** prompts that don't fit — the model simply loses the top of the conversation with no error. The client estimates the prompt size before every `chat`/`generate` call and surfaces the risk:

```typescript
const client = new OllamaClient({
  // Make the window explicit on every request that omits options.num_ctx
  defaultContextLength: 8192,

  // 'warn' (default): log through `logger` and send anyway
  // 'throw': reject client-side with OllamaClientError before anything hits the wire
  onContextOverflow: 'warn',
});

// Warnings fire when the estimate crosses 90% of the effective window:
// "OllamaClient.chat(): estimated prompt size ~1900 tokens is close to or
//  beyond the request's context window (num_ctx=2048). The server will
//  likely silently truncate …"
```

The estimators are exported for custom pipelines: `estimateTokens(text)` (CJK-aware — ~1 token per CJK character, ~4 chars/token elsewhere), `estimateChatRequestTokens(req)` / `estimateGenerateRequestTokens(req)` (message overhead + tool schemas + `IMAGE_TOKEN_ESTIMATE` per image), and the underlying `checkChatContext` / `checkGenerateContext` / `contextWarningMessage`. All are heuristics (±20–30%) — for exact counts, ask the server (`prompt_eval_count`).

### Discovering the Real Context Window

Guessing context windows ("it's probably 2048… or 4096?") is how silent truncation happens. Ollama advertises the real numbers in two places, and they answer _different questions_: `GET /api/ps` reports the window the **running instance actually allocated** (exact, reflects the Modelfile `num_ctx` default and what fit in memory), while `POST /api/show` exposes the Modelfile's `num_ctx` default _and_ the model's **native GGUF maximum** in `model_info["<architecture>.context_length"]` — the official API examples show a model with a 131072-token native max whose running instance allocated 4096, a 32× gap. `getContextLength()` consults them in precedence order and returns every signal it found:

```typescript
const window = await client.models.getContextLength({ model: 'gemma4' });
// -> { contextLength: 4096,        // program against this — resolved by precedence
//      source: 'running',          // 'running' | 'parameters' | 'model-info' | 'fallback'
//      runningContextLength: 4096, // allocated by the loaded instance (when loaded)
//      nativeContextLength: 131072 } // the ceiling you could raise num_ctx toward

// The canonical wiring — make the client's own pre-flight checks exact:
const client = new OllamaClient({ defaultContextLength: window.contextLength });

// Or raise the window deliberately when the model supports it (native max):
await client.chat({
  model: 'gemma4',
  messages,
  options: { num_ctx: window.nativeContextLength }, // 131072 — needs VRAM to match
});
```

`skipRunningCheck: true` skips the `/api/ps` round-trip (e.g. cloud/compat-only endpoints); a 404 from `/api/ps` is treated as "not running" and never fails the lookup. The pure pieces — `resolveContextLength()`, `extractParameterNumCtx()`, `findRunningModelContextLength()`, `extractNativeContextLength()` — are exported for callers that already hold `ps`/`show` responses.

### Compacting Long Conversations

Sessions grow monotonically; windows don't. When `cacheStats.hitRate` collapses while history grows — or the pre-flight warnings above start firing — `compact()` is the explicit fix: it keeps the pinned system prompt plus the most recent turns that fit the budget, dropping the oldest turns in between.

```typescript
const session = client.session('llama3.1', 'You are terse.', {
  options: { num_ctx: 4096 },
});

// …many turns later…
const result = session.compact();
// -> { droppedMessages: 14, estimatedTokensBefore: 4180,
//      estimatedTokensAfter: 3552, effectiveBudget: 3686 }  // num_ctx − 10% reply reserve

// Or compact any message array with an explicit budget (the pure helper):
import { compactConversationHistory } from '@nemesis-oss/ollama-sdk';
const kept = compactConversationHistory(session.getMessages(), {
  maxEstimatedTokens: 4096,
  reserveForReply: 512, // headroom for the model's next reply
  minTailMessages: 2, // never drop the latest exchange (default)
});
```

Compaction is deliberately **manual, never automatic**: rewriting the history invalidates the prompt prefix, so the next turn starts with a cold KV cache (visible as a one-turn `evaluatedTokens` spike in `cacheStats`). That recompute-for-a-fitting-window tradeoff is sometimes exactly right and sometimes wasteful — the SDK surfaces the numbers and leaves the call to you. Estimates use the same CJK-aware heuristic as the pre-flight checks (tool calls and images included); `minTailMessages` (default 2) guarantees the newest exchange survives even when oversized.

### Model-Affinity Scheduling (multi-model anti-thrashing)

Ollama's concurrency model (per the official FAQ) makes same-model parallelism cheap — KV cache scales as `OLLAMA_NUM_PARALLEL × context_length` for the _loaded_ model — but switching models is expensive: a request for a different model queues until the first goes idle or is evicted (`OLLAMA_MAX_LOADED_MODELS`, default 3× GPU count), paying an unload/cold-load swap each time. Workloads that interleave models arbitrarily (extraction on a coder model, reasoning on a thinking model) thrash the daemon that way. `ModelAffinityScheduler` is the client-side fix:

```typescript
import { ModelAffinityScheduler } from '@nemesis-oss/ollama-sdk';

const scheduler = new ModelAffinityScheduler(client, {
  concurrentModels: 1, // one model hot at a time (default) — the anti-thrash setting
  perModelConcurrency: 1, // mirror the daemon's OLLAMA_NUM_PARALLEL if you raise it
});

// Per-model serial queues; the active model deepens before the next one loads:
await scheduler.run('deepseek-r1', () => reason(client));
await scheduler.run('qwen2.5:coder', () => extract(client));

// Candidate lists: picks whichever model is already loaded (GET /api/ps, TTL-cached):
const code = await scheduler.run(['qwen2.5:coder', 'qwen2.5:14b'], (model) =>
  extractWith(client, model),
);

scheduler.stats; // { activeModels: ['deepseek-r1'], queuedTasks: 3 }
await scheduler.dispose(); // waits for every queue to drain
```

Dispatch is **affinity-sticky, not round-robin**: when a queued model is already active, its tasks start before a different model's (up to `perModelConcurrency`), because deepening the hot model avoids a swap. Tasks are your own functions — the scheduler adds no retry, timeout, or failover, and a rejected task only rejects its own `run()` promise. Candidate selection degrades gracefully: if `/api/ps` fails, the first candidate runs and the failure is never cached.

### Capacity Planning: OLLAMA_NUM_PARALLEL, MAX_QUEUE & KV-Cache Memory

The server-side knobs (official FAQ defaults) and the client-side surfaces that map onto them:

| Server knob                         | Default                   | Effect                                                                                                                                                     | Client-side counterpart                                                                                                                                                       |
| ----------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OLLAMA_NUM_PARALLEL`               | 1                         | Parallel requests **per loaded model**; required memory scales `NUM_PARALLEL × CONTEXT_LENGTH` (a 4K-context model at 4 parallel allocates a 16K KV cache) | `ModelAffinityScheduler({ perModelConcurrency })`, `ToolRegistry({ maxConcurrency })` for agent tool dispatch                                                                 |
| `OLLAMA_MAX_LOADED_MODELS`          | 3× GPUs (3 on CPU)        | Concurrently loaded models; beyond it, requests queue until a model goes idle or is evicted — the swap/thrash cycle                                        | `ModelAffinityScheduler({ concurrentModels })` — keep the working set small; `client.models.pin()`/`unload()` for explicit lifecycle                                          |
| `OLLAMA_MAX_QUEUE`                  | 512                       | Queued requests beyond this are rejected immediately with **503**                                                                                          | `endpointHealth.maxConcurrentPerEndpoint` (queue client-side instead of saturating the daemon), `embedBatch({ batchSize, concurrency })` for ingestion, retry/failover on 503 |
| `OLLAMA_CONTEXT_LENGTH` / `num_ctx` | 2048–4096 model-dependent | The window per request — prompts beyond it are **silently truncated**                                                                                      | `models.getContextLength()` for the real number, `defaultContextLength` to make it explicit, pre-flight warnings + `session.compact()` to stay inside it                      |

The two failure modes this table prevents: `Promise.all`-style floods (hundreds of simultaneous requests → queue saturation → 503s, VRAM spikes) and model ping-pong (alternating models → repeated unload/reload stalls). The SDK's request path already caps and queues per endpoint via `endpointHealth` — including `strategy: 'least-connections'` for pools — and `embedBatch`/`ModelAffinityScheduler` extend that discipline to ingestion and multi-model workloads. `OLLAMA_KV_CACHE_TYPE` (`f16`/`q8_0`/`q4_0`) trades KV precision for memory headroom at the daemon level; benchmark its latency impact against these client-side levers before relying on it for throughput.

### Blob Management & Custom GGUF Model Publishing

Ollama's documented import protocol: push a blob for each file, then reference it in `/api/create`'s `files` map by file name and SHA-256 digest. The SDK wraps the whole flow:

```typescript
// Content-addressed digest: SHA-256 -> "sha256:<64 lowercase hex>"
const digest = await client.models.computeBlobDigest(ggufBytes);

// HEAD-check + upload (skips the POST when the blob already exists)
const { digest, alreadyExisted } = await client.models.createBlobFromData(ggufBytes);
const upload = await client.models.createBlobFromFile('/models/my-model.gguf');
// -> { digest: 'sha256:…', alreadyExisted: false, fileName: 'my-model.gguf' }

// One-shot: upload every GGUF shard, then POST /api/create with files: {name: digest}
await client.models.createModelFromGguf('my-model', '/models/my-model.gguf', {
  template: '{{ .Prompt }}',
  parameters: { temperature: 0.7 },
});

// Split GGUFs: pass every shard
await client.models.createModelFromGguf('my-model', [
  '/models/model-00001-of-00002.gguf',
  '/models/model-00002-of-00002.gguf',
]);
```

### Token Log Probabilities (`logprobs`)

Set `logprobs: true` (optionally with `top_logprobs`) on `chat()`/`generate()` to get per-token log probabilities back — useful for confidence scoring, speculative decoding, or agent routing decisions.

```typescript
const res = await client.chat({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Is Paris the capital of France?' }],
  logprobs: true,
  top_logprobs: 3,
  stream: false,
});

for (const entry of res.logprobs ?? []) {
  console.log(entry.token, entry.logprob, entry.top_logprobs);
}
```

### Multimodal / Vision Input

`images` on a `Message` (or on `generate()`'s top-level request) is a **universal vision resolver** — every polymorphic form is normalized to the raw base64 string Ollama's REST API expects (no `data:image/...;base64,` URI prefixes ever reach the wire):

```typescript
// 1. Local file paths (Node.js — read via dynamically-imported node:fs)
const res = await client.chatText({
  model: 'llava',
  messages: [
    {
      role: 'user',
      content: 'What is in this image?',
      images: ['./cat.png'],
    },
  ],
});

// 2. Data URIs — the header is stripped automatically
await client.chat({
  model: 'llava',
  messages: [
    {
      role: 'user',
      content: 'Describe this.',
      images: ['data:image/png;base64,iVBORw0KGgo...'],
    },
  ],
});

// 3. Web URLs — fetched and encoded
await client.chat({
  model: 'llava',
  messages: [{ role: 'user', content: 'OCR this.', images: ['https://example.com/receipt.png'] }],
});

// 4. Raw bytes — Buffer / Uint8Array, base64-encoded automatically
import { readFile } from 'node:fs/promises';
await client.chat({
  model: 'llava',
  messages: [
    {
      role: 'user',
      content: 'What is in this image?',
      images: [await readFile('./cat.png')],
    },
  ],
});

// 5. Plain base64 strings — passed through unchanged
await client.generateText({
  model: 'llava',
  prompt: 'Describe this image.',
  images: ['iVBORw0KGgoAAAANSUhEUgAA...'],
});
```

The resolver is also exported standalone for custom pipelines: `resolveImageInput(input)` (single) and `resolveImages(images)` (batch, parallel). In browsers/edge runtimes, file-path strings throw a descriptive error (no `node:fs`) — read the file yourself and pass the bytes.

### Structured Outputs with Zod

```typescript
import { z } from 'zod';

const ProductSchema = z.object({
  name: z.string(),
  category: z.enum(['electronics', 'books', 'apparel']),
  price: z.number(),
  tags: z.array(z.string()),
});

const product = await client.chatWithSchema(
  {
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'Generate a gaming keyboard item.' }],
  },
  ProductSchema,
);

console.log(product.name, product.price);
```

### Vector Embeddings & Similarity

```typescript
const res = await client.embed({
  model: 'nomic-embed-text:latest',
  input: [
    'Machine learning and neural networks',
    'Artificial intelligence algorithms',
    'Baking traditional French sourdough bread',
  ],
});

console.log(
  `Generated ${res.embeddings.length} vectors with dimension ${res.embeddings[0].length}`,
);
```

`embed()` targets the modern `/api/embed` endpoint (batch `input`, `truncate`, and `dimensions` truncation are all supported). The older single-prompt `/api/embeddings` is still available as `client.embeddings()`, but it's `@deprecated` — Ollama's own docs consider it legacy in favor of `/api/embed`.

#### Batched embeddings with backpressure (large corpora)

Embedding a whole corpus with `Promise.all(chunks.map(c => client.embed(...)))` is the failure mode every RAG pipeline eventually hits: hundreds of simultaneous requests contend sockets, saturate the daemon's request queue (`OLLAMA_MAX_QUEUE` → 503s), and spike GPU VRAM as the model instance serves every prompt at once. Long inputs have a second, quieter failure mode — Ollama **silently truncates** any input string longer than the model's context window unless `truncate: false` is set.

`embedBatch()` is the safe building block for ingestion:

```typescript
const { embeddings, batchCount } = await client.embedBatch({
  model: 'nomic-embed-text:latest',
  input: corpus, // any size — 10 strings or 10 million
  batchSize: 32, // inputs per /api/embed request (default 32)
  concurrency: 3, // batches in flight simultaneously (default 3)
  keep_alive: '10m', // pin the model for the whole ingestion
  onBatchComplete: (done, total) => progress.log(`${done}/${total} batches`),
});

// embeddings[i] always corresponds to corpus[i], no matter which batch
// finished first — safe to zip straight into a vector store.
await vectorStore.upsert(corpus.map((text, i) => ({ id: i, text, vector: embeddings[i] })));
```

Every batch rides the client's full pipeline — failover, retry, auth, telemetry — and the operation is **order-preserving** and **fail-fast**: the first batch error aborts its in-flight siblings and rejects the whole call with the original error, so a half-indexed corpus never looks like success. The caller's `signal` cancels queued and in-flight batches alike (`code: 'aborted'`).

Like `chat`/`generate`, `embedBatch()` injects `defaultContextLength` as `num_ctx` and pre-checks each input string's estimated tokens against the resolved window — warn (default) or throw (`onContextOverflow: 'throw'`) with the offending indexes _before_ any request is sent, since Ollama truncates embedding inputs silently. Tune `batchSize`/`concurrency` per daemon: lower both for a laptop GPU, raise `concurrency` for remote or multi-endpoint clients.

### Model Lifecycle Management

Full parity with Ollama's model catalog and blob-store API — every method targets one specific endpoint's local state and deliberately does **not** cross-endpoint fail over (see [ADR 0008](./docs/adr/0008-endpoint-failover-scope.md)):

```typescript
// What's currently loaded in VRAM right now
const running = await client.ps();
console.log(running.models.map((m) => `${m.name} (${m.size_vram} bytes VRAM)`));

// Create a custom model from an existing base, without hand-writing a Modelfile string
await client.createModel({
  model: 'my-assistant',
  from: 'llama3.2',
  system: 'You are a terse, no-nonsense assistant.',
  parameters: { temperature: 0.2 },
});

await client.copyModel({ source: 'my-assistant', destination: 'my-assistant-backup' });
await client.pushModel({ model: 'my-namespace/my-assistant' });
await client.deleteModel({ model: 'my-assistant-backup' });
```

### Web Search & Web Fetch (Ollama Cloud)

`webSearch`/`webFetch` wrap Ollama's **hosted** web tools (`POST https://ollama.com/api/web_search` and `/api/web_fetch`) — a fixed Ollama Cloud service, entirely separate from whatever local `baseUrl`/`endpoints` the client is configured with. They require an Ollama account API key (`apiKey` on the client, or the `OLLAMA_API_KEY` environment variable) regardless of where your inference traffic goes:

```typescript
const client = new OllamaClient({
  baseUrl: 'http://localhost:11434', // local inference — unrelated to the calls below
  apiKey: process.env.OLLAMA_API_KEY, // required for webSearch/webFetch specifically
});

const search = await client.webSearch({ query: 'latest Ollama release notes', max_results: 5 });
for (const result of search.results) {
  console.log(result.title, result.url, result.content);
}

const page = await client.webFetch({ url: 'https://ollama.com/blog' });
console.log(page.title, page.content.slice(0, 200));
```

These two methods don't participate in the multi-endpoint failover below — there's only ever the one cloud host to call — but they do use the same default `timeoutMs` and retry policy as everything else.

### Cloud Usage & Balance (Ollama Cloud account)

`usage`/`balance` wrap Ollama's **hosted account endpoints** (`GET https://ollama.com/api/usage` and `/api/balance`) — the same fixed Ollama Cloud service and API-key requirements as `webSearch`/`webFetch` above, so everything said there about auth, timeouts, and retry applies identically here:

```typescript
const client = new OllamaClient({
  baseUrl: 'http://localhost:11434', // local inference — unrelated to the calls below
  apiKey: process.env.OLLAMA_API_KEY, // required for usage/balance specifically
});

// Usage for the last 24 hours, bucketed hourly (omit options for the server
// defaults: range='7d', scope='self'). Team scope requires a team admin.
const usage = await client.usage({ range: '24h' });
console.log(usage.totals.request_count, usage.totals.usage_usd, usage.totals.cached_input_tokens);
for (const bucket of usage.buckets) {
  if (bucket.partial) continue; // the current hour — still in progress
  console.log(bucket.from, bucket.request_count);
}

// Remaining credits. `included` is either the plan-period credits object
// (`balance_usd`/`allowance_usd`/`period`) or, on legacy plans, the
// session/weekly percentage-limits shape — discriminated by the response.
const balance = await client.balance();
if ('balance_usd' in balance.included) {
  console.log(`included: $${balance.included.balance_usd} of $${balance.included.allowance_usd}`);
} else {
  console.log(`session limit: ${balance.included.session.remaining_percent}% remaining`);
}
console.log(`purchased: $${balance.purchased.balance_usd}`);
```

Both endpoints are rate-limited to 10 requests/minute per user (429 responses carry `Retry-After`); polling about once a minute is the recommended cadence.

### Autonomous Agent & Tool Calling

```typescript
import { Agent, defineTool, ToolRegistry, OllamaClient } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';

const client = new OllamaClient();

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, temperature: '22°C', condition: 'Sunny' }),
});

const registry = new ToolRegistry([weatherTool]);
const agent = new Agent(client, { tools: registry, maxIterations: 5 });

const response = await agent.run({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
});

console.log(response.finalMessage.content);
```

Ollama's native tool-calling protocol has no OpenAI-style call ID, so the SDK
synthesizes a stable client-side ID for tracing and execution correlation:
`response.turns[0].toolCalls[0].id` matches
`response.turns[0].toolResults[0].toolCallId`. Native `role: 'tool'` history entries
use Ollama's documented `tool_name` field; the SDK-local `toolCallId` is not sent on
the wire. See [ADR 0007](./docs/adr/0007-synthetic-tool-call-ids.md).

Running several `Agent`s against different models/API keys for different roles (e.g. a
planning model, a coding model, a research model) is a single `OllamaClient` with
per-endpoint `models` allow-lists (see
["Multiple API keys, each entitled to different models"](#multiple-api-keys-each-entitled-to-different-models)) —
the client resolves the right key from the model name, and `Agent` itself stays
unaware of credentials entirely. See
[Guide: Benchmarking Agent Models Across Multiple Ollama Cloud Keys](./docs/guides/multi-model-agent-benchmarking.md)
for a worked example and a runnable scenario.

### MCP Bridge & Agent Capability Preflight

The SDK exposes `McpBridge` as a transport-neutral adapter between an MCP client and
Ollama's native function-tool format. The bridge does not own the MCP transport or spawn
processes; your application supplies an MCP client with `listTools()` and `callTool()`.
This keeps the package root Edge-runtime safe while still supporting Node-specific
transports such as stdio through your chosen MCP implementation.

```typescript
import { McpBridge, ToolRegistry } from '@nemesis-oss/ollama-sdk';

const bridge = new McpBridge(mcpClient, { namePrefix: 'mcp_' });

const registry = new ToolRegistry();
await bridge.register(registry);

// The same MCP definitions can also be inspected before registration.
const definitions = await bridge.definitions();
console.log(definitions);
```

For tool-enabled `Agent` runs, capability preflight is enabled by default when the
chat client exposes `capabilities()` (including `OllamaClient`). The agent queries
`/api/show` before the first model turn and throws `OllamaIncompatibleModelError` when
the selected model does not advertise `tools`.

The same metadata can size the tool context automatically: when `options.num_ctx` is
not supplied, the default is `32768`, clamped to the model-reported
`capabilities.contextLength` when available. An explicit `options.num_ctx` always
takes precedence.

For legacy or custom `AgentChatClient` implementations, set
`validateToolCapability: false` to skip capability discovery and the automatic
context-size override.

See [ADR 0011](./docs/adr/0011-mcp-boundary-and-agent-tool-preconditions.md) for the
MCP boundary and agent-precondition rationale.

### Tool Execution Safety & Sandboxing

Tool arguments and, indirectly, which tools get called at all are driven by model
output — treat them as untrusted input. `ToolRegistry` supports three defensive
controls, all opt-in (disabled by default, matching prior behavior) so existing agents
aren't affected until you turn them on:

```typescript
const registry = new ToolRegistry({
  tools: [weatherTool],
  // Fail a call that runs longer than this instead of stalling the agent loop forever.
  // Override per-tool via `defineTool({ ..., timeoutMs: 2_000 })`.
  timeoutMs: 10_000,
  // Cap how many tool calls run in parallel when the model requests several at once.
  maxConcurrency: 4,
  // Truncate oversized tool output before it re-enters the conversation history.
  maxOutputChars: 20_000,
});
```

- **`timeoutMs`** races the tool call against a timer and rejects with
  `OllamaToolTimeoutError` on expiry. Enforcement is cooperative: it stops the _agent_
  from waiting indefinitely, but genuinely halting a tool's in-flight work still
  requires the tool itself to check `ToolExecutionContext.signal` (which the registry
  aborts on timeout) — plain synchronous or non-abort-aware async code cannot be
  force-killed from the same thread. See [ADR 0004](./docs/adr/0004-tool-execution-sandboxing.md)
  for the full rationale and what a stronger guarantee would require.
- **`maxConcurrency`** bounds parallel execution instead of the previous unconditional
  `Promise.all`, so a model requesting dozens of simultaneous tool calls can't exhaust
  connection pools, rate limits, or memory all at once.
- **`maxOutputChars`** truncates `outputString` (what gets fed back into the
  conversation) while leaving the untruncated value on `result.result` for callers who
  need it — bounding how much a single tool call can inflate context size or memory.
- Zod's `safeParse` already validates every tool call's arguments against its schema
  before `execute` runs (`OllamaToolValidationError` on mismatch). By default, Zod
  objects silently strip unrecognized keys rather than rejecting them; call `.strict()`
  on a tool's schema if you need to reject unexpected extra arguments outright.

### Web Standard Streams & Next.js Integration

```typescript
import { toResponse } from '@nemesis-oss/ollama-sdk';

export async function POST(req: Request) {
  const { messages } = await req.json();
  const stream = await client.chatStream({
    model: 'qwen3:8b',
    messages,
  });

  return toResponse(stream);
}
```

### OpenAI & Anthropic Compatibility Bridges

```typescript
// OpenAI compatibility endpoint (/v1/chat/completions)
const openAIRes = await client.openai.chatCompletions({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hello via OpenAI bridge' }],
});

// OpenAI Responses API endpoint (/v1/responses) — added in Ollama v0.13.3
const responsesRes = await client.openai.responses({
  model: 'llama3.2',
  input: 'Hello via the OpenAI Responses bridge',
});
console.log(responsesRes.output[0]?.content[0]?.text);

// Anthropic compatibility endpoint (/v1/messages)
const anthropicRes = await client.anthropic.messages({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hello via Anthropic bridge' }],
});
```

`/v1/responses` is implemented non-statefully by Ollama: send the full conversation in
`input` on every call — `previous_response_id` and `conversation` are accepted for
OpenAI request-shape compatibility but ignored (see `OpenAIResponsesRequest` JSDoc).

For thinking models (`deepseek-r1`, `qwen3`, etc.), both compatibility bridges' chat
completions request accept a reasoning effort knob:

```typescript
await client.openai.chatCompletions({
  model: 'deepseek-r1:8b',
  messages: [{ role: 'user', content: 'Solve: 17 * 23' }],
  reasoning_effort: 'high', // or `reasoning: { effort: 'high' }`
});
```

`tool_choice` and `parallel_tool_calls` are also typed on the request so a standard
OpenAI request object type-checks unmodified, but Ollama's compat layer does not honor
either — see the `@remarks` on each field in `OpenAIChatCompletionRequest`.

### Multi-Endpoint High Availability Failover

```typescript
const client = new OllamaClient({
  endpoints: [
    { name: 'local-gpu', baseUrl: 'http://localhost:11434', priority: 10 },
    {
      name: 'cloud-replica',
      baseUrl: 'https://ollama.internal.net',
      apiKey: 'secret',
      priority: 5,
    },
  ],
  timeoutMs: 30_000,
  retries: 3,
});

// Active health check probe
const health = await client.healthCheck();
console.log(health);
```

Failover applies to inference calls (`chat`, `generate`, `embed`, `embeddings`,
`webSearch`, `webFetch`) — a different endpoint serving the same model is a genuine
substitute for those. Model/blob management (`listModels`, `pullModel`, `deleteModel`,
etc.) and `capabilities()` target one specific endpoint's local state and deliberately do
**not** fail over to a different candidate: retrying `deleteModel` against a different
server doesn't retry the same operation, it silently acts on a different model catalog.
See [ADR 0008](./docs/adr/0008-endpoint-failover-scope.md).

#### Multiple API keys, each entitled to different models

A common Ollama Cloud shape: several API keys, each unlocking a different set of models
under your plan (e.g. one free-tier key per model family). Give each endpoint a `models`
allow-list and the client resolves the right credential from the `model` you request —
cross-endpoint failover only ever considers endpoints actually authorized for that model,
so it never burns a request retrying an unrelated key:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  endpoints: [
    {
      name: 'gpt-oss-key',
      apiKey: process.env.OLLAMA_KEY_1!,
      baseUrl: 'https://ollama.com',
      models: ['gpt-oss:120b'],
    },
    {
      name: 'minimax-key',
      apiKey: process.env.OLLAMA_KEY_2!,
      baseUrl: 'https://ollama.com',
      models: ['minimax-m3'],
    },
    {
      name: 'nemotron-key',
      apiKey: process.env.OLLAMA_KEY_3!,
      baseUrl: 'https://ollama.com',
      models: ['nemotron-3-super'],
    },
  ],
});

// Routed to KEY_1 automatically:
await client.chat({ model: 'gpt-oss:120b', messages });
// Routed to KEY_2 automatically:
await client.chat({ model: 'minimax-m3', messages });
```

An endpoint with no `models` field stays eligible for every model (the pre-existing
behavior), so this is fully opt-in and mixes freely with unscoped endpoints. Requesting a
model no configured endpoint is scoped to throws `OllamaModelRoutingError` immediately —
no network call, no probing every key to see which one happens to work. Two or more
endpoints can share the same model in their `models` list to get ordinary failover
between multiple keys/replicas for that one model. See
[Guide: Benchmarking Agent Models Across Multiple Ollama Cloud Keys](./docs/guides/multi-model-agent-benchmarking.md)
for the full multi-key/multi-role pattern this was built for.

**`credentials` + `modelBindings`** is an equivalent, map-based way to write the same
config, if you prefer keying by an id you choose over an array of endpoint objects — both
compile down to the same `endpoints`/`models` routing underneath, so pick whichever reads
better in your codebase:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    supervisor: { apiKey: process.env.OLLAMA_KEY_1! },
    coder: { apiKey: process.env.OLLAMA_KEY_2! },
    researcher: { apiKey: process.env.OLLAMA_KEY_3! },
  },
  modelBindings: {
    'gpt-oss:120b': 'supervisor',
    'minimax-m3': 'coder',
    'nemotron-3-super': 'researcher',
    // A model can also be bound to several credentials — failover applies between them:
    // 'gpt-oss:120b': ['supervisor', 'supervisor-backup'],
  },
  // Optional: serves any model with no entry above, at lower priority than an explicit binding.
  // defaultCredential: 'supervisor',
});
```

`modelBindings` referencing a `credentials` id that doesn't exist throws immediately at
construction — a typo in this config fails loudly, not by silently routing nowhere.
`credentials`/`modelBindings` merge additively with an `endpoints` array if you pass both.

#### A free pool of interchangeable keys — and spreading load across it

Register several keys as `credentials` and skip `modelBindings` for them entirely: an
unbound credential is eligible for every model, so any of them can serve any request:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    key1: { apiKey: process.env.OLLAMA_KEY_1! },
    key2: { apiKey: process.env.OLLAMA_KEY_2! },
    key3: { apiKey: process.env.OLLAMA_KEY_3! },
  },
});

await client.chat({ model: 'any-model-you-like', messages });
```

By default, candidates at the same priority (the case here — none of these keys were
given an explicit `priority`) are tried in registration order every time: `key1` first,
falling over to `key2`/`key3` only if `key1` fails. To spread consecutive requests across
the pool instead — so `key1`, `key2`, `key3` each take a turn rather than `key1` always
going first — set `endpointHealth: { strategy: 'round-robin' }`:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    key1: { apiKey: process.env.OLLAMA_KEY_1! },
    key2: { apiKey: process.env.OLLAMA_KEY_2! },
    key3: { apiKey: process.env.OLLAMA_KEY_3! },
  },
  endpointHealth: { strategy: 'round-robin' },
});
```

Each `chat`/`generate`/`embed`/etc. call rotates the starting candidate by one position
within its priority tier — `key1, key2, key3, key1, key2, key3, ...` — while failover
still applies if whichever key ends up first happens to fail. Round-robin never lets a
lower-priority candidate jump ahead of a higher-priority one; it only reorders candidates
that were already tied. This works identically with plain `endpoints` (no `credentials`
required) and composes with `models`/`modelBindings` scoping — a scoped credential's tier
of one is unaffected, only an actual multi-candidate tier rotates.

#### Concurrent requests across single-slot accounts (least-connections)

Round-robin spreads requests over time, but it doesn't track whether a previous request
on a given account is still running — with uneven request durations, two round-robin
picks can still land on the same still-busy account back to back. That matters
specifically for Ollama Cloud's free tier, which caps each account at **1 concurrent
request**: if your application fires several requests at once (e.g. `Promise.all` across
different models) using $N$ free-tier accounts, you want a guarantee that no two land on
the same account while it's still busy — not just "spread out on average".

`strategy: 'least-connections'` provides that guarantee. Each request is routed to
whichever candidate currently has the fewest requests still in flight:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    account1: { apiKey: process.env.OLLAMA_KEY_1! },
    account2: { apiKey: process.env.OLLAMA_KEY_2! },
    account3: { apiKey: process.env.OLLAMA_KEY_3! },
  },
  endpointHealth: { strategy: 'least-connections' },
});

// Each of these lands on a different account — none has to wait on another's
// in-flight request, and no single free-tier account gets hit with a 2nd concurrent
// request while its 1st is still running.
const [llama, qwen, mistral] = await Promise.all([
  client.chat({ model: 'llama3', messages: llamaMessages }),
  client.chat({ model: 'qwen2.5', messages: qwenMessages }),
  client.chat({ model: 'mistral', messages: mistralMessages }),
]);
```

This is deterministic, not probabilistic: the endpoint chosen for one request and the
`acquire()` that marks it in-flight happen synchronously with no `await` in between, and
JS's single-threaded execution means no two concurrent calls can ever observe the same
"0 active" snapshot for the same candidate — so `N` concurrent calls against `N`
same-priority candidates always land on `N` distinct ones, regardless of how the calls
happen to interleave. In-flight counts are also exposed via `client.endpointStatus()[].activeRequests`
for observability, and release automatically on both success and failure (including when
an account's actual 429 forces failover to the next-least-busy candidate). Priority tiers
are respected the same way as `'round-robin'` — a higher-priority candidate is still
always tried first regardless of its active count.

#### Queueing past capacity, instead of overrunning an account

`'least-connections'` alone only guarantees no collision for up to `N` _simultaneous_
calls against `N` candidates — an `(N+1)`th concurrent call would still be routed to
whichever account looks least busy at that instant, which, once all `N` already have one
request each, means sending it to an account that's already at its real limit. Add
`maxConcurrentPerEndpoint` to cap that exactly and queue instead:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    account1: { apiKey: process.env.OLLAMA_KEY_1! },
    account2: { apiKey: process.env.OLLAMA_KEY_2! },
  },
  endpointHealth: { strategy: 'least-connections', maxConcurrentPerEndpoint: 1 },
});

// With 2 accounts capped at 1 request each: the first two calls run immediately, one
// per account; the third waits (no fetch is made for it yet) until either finishes,
// then takes that freed slot.
const [a, b, c] = await Promise.all([
  client.chat({ model: 'm1', messages: m1Messages }),
  client.chat({ model: 'm2', messages: m2Messages }),
  client.chat({ model: 'm3', messages: m3Messages }),
]);
```

Waiting is bounded by the same `timeoutMs`/`AbortSignal` as the rest of the request — a
queued call that times out or is cancelled is removed from the queue and rejects without
ever having been sent, rather than hanging indefinitely. Queue wake order is best-effort
FIFO (a slot that frees can, rarely, be won by a brand-new call instead of the
longest-waiting one) — the exact cap, not fairness, is the guarantee this exists for.

#### Slot lifecycle: streaming and tool-calling agents

Two details matter for the concurrency accounting (`'least-connections'`/
`maxConcurrentPerEndpoint`/`activeRequests`) to reflect reality rather than just the
initial HTTP round trip:

- **Streaming (`chatStream`/`generateStream`) holds the slot for as long as the stream is
  actually being consumed**, not just until the response headers arrive. The promise
  `chatStream` returns resolves as soon as the stream object exists (mirroring the real
  HTTP connection, which is still open at that point); the slot releases only once the
  stream is fully drained, errors, or is aborted. A returned stream that's never iterated
  (or `.on()`'d) holds its slot indefinitely — same as the underlying HTTP connection
  would stay open — so always consume or `stream.abort()` a stream you no longer need.
- **`Agent`'s tool-execution phase never holds a slot.** Each turn's `chat()` call
  acquires and releases its own slot independently; tool execution happens entirely
  between turns, outside any `chat()` call, so a slow tool never ties up one of your
  scarce concurrent-request accounts.

### Client Teardown: `destroy()`

Inside `node:worker_threads` tasks, CLI runners, serverless handlers, and other
short-lived processes, the things that keep an event loop (and therefore the
thread or process) alive are exactly the things this SDK manages: in-flight
fetch bodies, unconsumed stream readers, and requests queued behind
`maxConcurrentPerEndpoint`. `destroy()` is the one-call drain for all of them:

```typescript
import { parentPort, workerData } from 'node:worker_threads';

const client = new OllamaClient({ baseUrl: workerData.ollamaUrl });
try {
  await processTask(client, workerData.payload);
} finally {
  // Aborts every request/stream still in flight with OllamaAbortError
  // (code 'aborted'), releases their endpoint slots, and lets the worker
  // thread exit cleanly. Idempotent — safe to call from a signal handler.
  const aborted = client.destroy('worker task finished');
  if (aborted > 0) logger.warn(`torn down ${aborted} in-flight operations`);
}
```

Every aborted operation — dispatched **or** still queued — rejects with
`OllamaAbortError` carrying the reason; active streams reject their
`finalResult` and release their concurrency slots, so nothing dangles after
the call returns the count of operations it aborted. `destroy()` is a drain,
not a permanent disable: the client stays usable afterward (spawn a fresh one
if you want a hard cut), and calling it on an idle client is a no-op that
returns `0`.

---

### Observability with OpenTelemetry

The client automatically emits [OpenTelemetry](https://opentelemetry.io/) spans for HTTP
requests, endpoint failover attempts, `chat`/`generate` calls (using the
[Gen AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)), and
`Agent` runs (`invoke_agent` → `ollama.agent.turn` → `execute_tool`) — no client
configuration required. `@opentelemetry/api` is an **optional peer dependency**: if it
isn't installed, or if your process hasn't registered a `TracerProvider`, tracing is a
no-op and costs nothing beyond a single cached import attempt.

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
```

```typescript
// instrumentation.ts — run before importing the rest of your app
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
```

Once a `TracerProvider` is registered, every `OllamaClient`/`Agent` call in your process
produces spans automatically. See [ADR 0005](./docs/adr/0005-opentelemetry-instrumentation.md)
for exactly which spans and attributes are emitted, and the tradeoffs behind that design.

---

### Quota Monitoring

Ollama Cloud doesn't expose account-level quota through the API — chat/generate
responses carry only per-request token counts, and there's no header or endpoint that
reports how much of your plan's session or weekly limit is left. The only way to see
that today is the [ollama.com dashboard](https://ollama.com) or the 90%-usage email (see
[ollama/ollama#15663](https://github.com/ollama/ollama/issues/15663)). Free-tier usage
resets on a session window (~5 hours) and a weekly window (7 days), and is measured in
compute, not a fixed token count, so a budget you set for one model won't transfer
exactly to another.

`QuotaManager` is a client-side safety net, not a mirror of Ollama's real limits: it
tracks usage you record against budgets _you_ configure over one or more rolling
windows, and fails fast — before a request is even sent — once a window's budget is
spent. Pair it with catching `OllamaRateLimitError` (the server's actual `429`) as the
authoritative signal.

```typescript
import {
  OllamaClient,
  OllamaQuotaExceededError,
  OllamaRateLimitError,
  createOllamaCloudFreeTierQuota,
} from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient({ apiKey: process.env.OLLAMA_API_KEY });

// Session (5h) and weekly (7d) windows, with budgets you choose empirically —
// Ollama doesn't publish the actual ceilings.
const quota = createOllamaCloudFreeTierQuota({
  session: { maxTokens: 50_000 },
  weekly: { maxTokens: 200_000 },
});

async function chatWithQuota(prompt: string) {
  quota.assertCanProceed(); // throws OllamaQuotaExceededError if any window is spent

  try {
    const res = await client.chat({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: prompt }],
    });
    quota.recordUsage(res); // reads prompt_eval_count/eval_count off the raw response
    return res.message.content;
  } catch (error) {
    if (error instanceof OllamaRateLimitError) {
      console.warn('Server-side rate limit hit — pause until the session window resets.');
    }
    throw error;
  }
}
```

`quota.status()` returns per-window `tokensUsed`/`requestsMade`/`remainingTokens`/
`windowResetAt` for building your own usage dashboard, and `quota.reset(windowId?)` lets
you clear a window manually (e.g. after confirming a reset on the ollama.com dashboard).
For budgets that don't match the free tier's cadence, construct `new QuotaManager({
windows: [...] })` directly with your own `windowMs`/`maxTokens`/`maxRequests` per window.

---

### Edge Runtime Compatibility

The core client (`OllamaClient`, `Agent`, `ToolRegistry`, and everything exported from
the package root) is built entirely on native `fetch` and Web Streams, so it runs
unmodified on Cloudflare Workers, Vercel Edge Runtime, and Next.js Edge middleware/route
handlers — no Node.js APIs required. The only Node-specific code (`SkillRegistry`, which
reads `SKILL.md` files from disk) lives behind the separate `@nemesis-oss/ollama-sdk/skills`
subpath export and is never pulled into the main bundle.

This is enforced in CI, not just asserted: `npm run verify:edge-runtime` bundles
`dist/index.js` with `esbuild` targeting a browser/edge platform (which hard-fails on any
`node:*` import, the same way Cloudflare's and Vercel's own bundlers do) and then runs a
full `OllamaClient` + `Agent` + tool-calling round trip inside `@edge-runtime/vm` — a
real Edge Runtime sandbox exposing only Web Standard globals. See
[ADR 0006](./docs/adr/0006-edge-runtime-ci-and-benchmarks.md) for the full rationale.

---

## Contract-First Architecture

Starting with v1.4.0, the SDK ships a **contract-first hybrid architecture** where a single
canonical IR (`contracts/ir/ollama.ir.json`) drives seven consumers:

1. **TypeScript interfaces** — `src/generated/models/<name>.ts` (36 schemas)
2. **Generated API classes** — `NativeApi` / `OpenAIApi` / `AnthropicApi` in `src/generated/api/`
3. **MCP tool descriptors** — `src/generated/mcp/tools.json` (21 tools, one per documented operation)
4. **Operation metadata** — `src/generated/metadata/operations.json`
5. **Field-level parity** — overlay `parity:` blocks verified by `npm run verify:contract-parity`
6. **Zod schemas** — `src/generated/models/<name>.schema.ts` (paired with every TypeScript interface)
7. **Bidirectional endpoint discovery** — catches new Ollama endpoints like `/v1/systemone` that the OpenAPI spec doesn't yet cover

The IR is compiled from upstream OpenAPI + hand-maintained behavioral overlays by
`npm run contract:normalize`. Run `npm run contract:generate` to regenerate every TypeScript /
Zod / MCP artifact from the IR. See [ADRs 0013-0019](./docs/adr/README.md) for the full design.

### Using the generated `NativeApi` (recommended for new code)

The generated surface is opt-in — existing `OllamaClient` callers don't need to change anything.
For new code, the generated API inherits every contract-layer guarantee (environment guards,
version guards, streaming defaults) automatically:

```typescript
import { HttpClient } from '@nemesis-oss/ollama-sdk';
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';
import { NativeApi } from '@nemesis-oss/ollama-sdk/generated/api';

const http = new HttpClient({ baseUrl: 'http://localhost:11434' });
const runtime = new OllamaRuntime({ http });
const api = new NativeApi(runtime);

// Non-streaming chat:
const res = await api.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: false,
});

// Streaming chat — explicitly request a stream:
const stream = await api.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});
for await (const chunk of stream) {
  console.log(chunk.message?.content);
}
```

### Mixing the legacy client with the generated surface

`OllamaClient.runtime` returns a cached `OllamaRuntime` that shares the client's
transport (HttpClient + middleware + retry + telemetry), so you can mix both
surfaces in the same process without configuring two HttpClient instances:

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { NativeApi } from '@nemesis-oss/ollama-sdk/generated/api';

const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });

// Existing API:
const res = await client.chat({ model: 'qwen3:8b', messages });

// Generated API (shares transport):
const api = new NativeApi(client.runtime);
const res2 = await api.chat({ model: 'qwen3:8b', messages, stream: false });
```

`OllamaClient` carries a deprecation notice pointing to `NativeApi` for new code, but
no method signatures have changed — existing callers continue to work.

### Runtime validation with generated Zod schemas

Every TypeScript interface in `src/generated/models/<name>.ts` has a paired Zod schema
in `src/generated/models/<name>.schema.ts`. Two ways to use them:

**Per-call validation** — for one-off checks, import the schema directly:

```typescript
import { ChatRequestSchema } from '@nemesis-oss/ollama-sdk/generated/models/schemas';

const result = ChatRequestSchema.safeParse(userInput);
if (!result.success) {
  console.error(result.error.issues);
} else {
  // result.data is typed as ChatRequest
}
```

**Runtime-wide validation** (Wave 10) — opt in once on the runtime constructor
and every request body is validated automatically before the HTTP call:

```typescript
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';

const runtime = new OllamaRuntime({ http, validateRequests: true });
// Every chat/generate/embed/create/copy/delete/pull/push/show request
// is now validated against the IR-derived Zod schema. Malformed requests
// throw OllamaRequestValidationError BEFORE any network call is made.
// Unknown fields are stripped (Zod default), so callers can't accidentally
// send extra fields the contract doesn't allow.
```

When validation fails, the runtime throws `OllamaRequestValidationError`
(an `OllamaClientError` subclass with `code: 'request_validation_error'`,
`retryable: false`) carrying the operation ID and the Zod issues array.
Zero overhead when `validateRequests` is not set — the default behavior
is unchanged. See [ADR 0020](./docs/adr/0020-runtime-zod-validation.md).

### Generated MCP tools

The IR also produces 21 MCP tool descriptors (one per documented Ollama operation) at
`src/generated/mcp/tools.json`. The runtime adapter at
`@nemesis-oss/ollama-sdk/mcp/generated` exposes them as a callable tool registry:

```typescript
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';
import {
  listGeneratedOllamaTools,
  callGeneratedOllamaTool,
} from '@nemesis-oss/ollama-sdk/mcp/generated';

const tools = listGeneratedOllamaTools();
// tools: [{ name: 'ollama_chat', inputSchema: {...}, annotations: {...} }, ...]

const result = await callGeneratedOllamaTool(runtime, 'ollama_version', {});
console.log(result.structuredContent); // { version: '0.5.0' }
```

### Contract maintenance commands

| Command                          | What it does                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm run contract:fetch`         | Re-pull the upstream OpenAPI spec into `contracts/sources/`                                                                        |
| `npm run contract:normalize`     | Compile sources + overlays → `contracts/ir/ollama.ir.json`                                                                         |
| `npm run contract:validate`      | Run schema + compatibility + bidirectional endpoint discovery validators                                                           |
| `npm run contract:diff`          | Fail if the committed IR is stale (CI gate)                                                                                        |
| `npm run contract:generate`      | Regenerate every TypeScript / Zod / MCP artifact from the IR (idempotent)                                                          |
| `npm run contract:drift`         | Print drift report between generated types and `src/types.ts` (pass `--strict` to fail CI on unexpected drift)                     |
| `npm run verify:contract-parity` | Verify parity blocks against `src/types.ts` (structural) and `docs.ollama.com` (live-docs); pass `--skip-live-docs` for offline CI |

---

## Error Handling

Every failure thrown by the client is an `OllamaClientError` subclass, so you can catch the base
class or narrow to a specific `code`:

| Class                              | `code`                          | `retryable` | Thrown when                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OllamaNetworkError`               | `network_error`                 | `true`      | The request failed before a response was received (DNS, connection refused, etc).                                                                                                                                                                        |
| `OllamaTimeoutError`               | `timeout`                       | `true`      | The request exceeded `timeoutMs`.                                                                                                                                                                                                                        |
| `OllamaAuthError`                  | `auth_error`                    | `false`     | The endpoint returned `401`/`403`.                                                                                                                                                                                                                       |
| `OllamaNotFoundError`              | `not_found`                     | `false`     | The endpoint returned `404` (e.g. unknown model).                                                                                                                                                                                                        |
| `OllamaRateLimitError`             | `rate_limited`                  | `true`      | The endpoint returned `429`.                                                                                                                                                                                                                             |
| `OllamaQuotaExceededError`         | `quota_exceeded`                | `false`     | `QuotaManager.assertCanProceed` was called and would exceed a configured usage budget. Thrown client-side, before any network call — see [Quota Monitoring](#quota-monitoring).                                                                          |
| `OllamaModelRoutingError`          | `model_routing_error`           | `false`     | No configured `endpoints` entry's `models` allow-list includes the requested model. Thrown client-side, before any network call — see [Multiple API keys, each entitled to different models](#multiple-api-keys-each-entitled-to-different-models).      |
| `OllamaServerError`                | `server_error`                  | `true`      | The endpoint returned `5xx`.                                                                                                                                                                                                                             |
| `OllamaAbortError`                 | `aborted`                       | `false`     | The request was cancelled via `AbortSignal`.                                                                                                                                                                                                             |
| `OllamaToolValidationError`        | `tool_validation_error`         | `false`     | A tool call's arguments, or a `chatWithSchema`/`generateWithSchema` result, failed Zod validation.                                                                                                                                                       |
| `OllamaUnsupportedCapabilityError` | `unsupported_capability`        | `false`     | A `format` (structured output) request was made against an endpoint inferred as Ollama Cloud, which doesn't currently support it. Thrown before any network call; in `DEFAULT_FAILOVER_CODES`, so a multi-endpoint setup tries the next candidate first. |
| `OllamaIncompatibleModelError`     | `incompatible_model`            | `false`     | A tool-enabled `Agent` run was blocked by capability preflight because `/api/show` did not advertise `tools`.                                                                                                                                            |
| `OllamaAgentMaxIterationsError`    | `agent_max_iterations_exceeded` | `false`     | An `Agent` run exceeded `maxIterations` without producing a final answer.                                                                                                                                                                                |
| `OllamaMcpError`                   | `mcp_error`                     | varies      | An MCP `listTools`/`callTool` call failed.                                                                                                                                                                                                               |
| `OllamaSkillNotFoundError`         | `skill_not_found`               | `false`     | `applySkill` referenced a skill that isn't registered.                                                                                                                                                                                                   |
| `OllamaSkillInvalidError`          | `skill_invalid`                 | `false`     | A skill's frontmatter or contents failed to parse.                                                                                                                                                                                                       |
| `OllamaGenericClientError`         | `client_error`                  | `false`     | Any other non-2xx response not covered above.                                                                                                                                                                                                            |

All subclasses carry `status`, `retryable`, and optional `request`/`response` context, and preserve
the original error via the standard `cause` property:

```typescript
import { OllamaClientError, OllamaRateLimitError } from '@nemesis-oss/ollama-sdk';

try {
  await client.chatText({ model: 'qwen3:8b', messages: [...] });
} catch (err) {
  if (err instanceof OllamaRateLimitError) {
    console.warn(`Rate limited, retry after ${err.retryAfterMs}ms`);
  } else if (err instanceof OllamaClientError) {
    console.error(`[${err.code}] ${err.message}`, { retryable: err.retryable, cause: err.cause });
  } else {
    throw err;
  }
}
```

Multi-endpoint failover (`endpoints: [...]`) fails open rather than throwing a dedicated
"circuit open" error: once an endpoint's failure count crosses `failureThreshold`, it's skipped in
favor of healthy endpoints for `cooldownMs`, and only used again — sorted soonest-to-recover — if
every endpoint is cooling down. Call `client.healthCheck()` or inspect the registry's `status()` to
observe per-endpoint circuit state directly.

---

## Documentation

The repository maintains implementation-facing documentation alongside the package README:

- [Architecture Decision Records](./docs/adr/README.md) — rationale for durable API and architecture choices.
- [Canonical Ollama IR](./contracts/ir/ollama.ir.json) — machine-readable Ollama contract compiled from sources + overlays, checked by CI.
- [Multi-model agent benchmarking guide](./docs/guides/multi-model-agent-benchmarking.md) — running agent roles across multiple Ollama endpoints.
- [Upstream compatibility notes](./docs/upstream/) — pinned OpenAI/Anthropic compatibility references and the upstream OpenAPI snapshot.
- [Manual laboratory](./LAB_README.md) — runnable experiments for protocol, tool, streaming, and agent behavior.

## Contract parity verification

`npm run verify:contract-parity` checks the canonical IR against the official Ollama
documentation. The structural half verifies that every `parity.request.fields` /
`parity.response.fields` entry exists on the hand-written TypeScript interfaces
in `src/types.ts` and `src/integrations/*`. The live-docs half (when run without
`--skip-live-docs`) fetches the rendered docs at `docs.ollama.com` and asserts each
supported field is documented as supported, each unsupported field is explicitly
marked as such, and each streaming event type is present.

The gate covers every documented native REST endpoint (`chat`, `generate`, `embed`,
`tags`, `ps`, `show`, `create`, `copy`, `pull`, `push`, `delete`, and `version`)
plus the OpenAI and Anthropic compatibility request surfaces. SDK-only fields
that exist in `src/types.ts` but are absent from the OpenAPI snapshot are declared
as `sdkOnlyFields` in the overlay parity blocks and treated as expected drift,
not findings.

## Middleware and request lifecycle

`OllamaClient` accepts `middleware` and `onLifecycleEvent` configuration. Middleware runs
around the underlying HTTP request for native endpoints, OpenAI/Anthropic compatibility,
model health checks, and the hosted web tools. Lifecycle events expose `start`, `success`,
`retry`, and `error` events with a request id, timing, and status/error information.

```ts
const client = new OllamaClient({
  middleware: [
    async ({ request, next }) => {
      request.headers['X-Request-Source'] = 'my-app';
      return next();
    },
  ],
  onLifecycleEvent: (event) => {
    console.log(event.type, event.requestId);
  },
});
```

Retry backoff is also cancellation-aware: passing an `AbortSignal` to `withRetry` or cancelling an `OllamaClient` request interrupts an in-progress backoff immediately instead of waiting for the next retry delay.

## Compatibility routing and stream lifecycle

OpenAI and Anthropic compatibility requests use the same endpoint registry, model-scoped
routing, failover, concurrency limits, and request cancellation as native inference calls.
When `stream: true`, an endpoint capacity slot remains held until the compatibility stream
finishes, errors, or is explicitly aborted.

Compatibility stream objects expose `.abort()` and `finalResult`. The configured request
timeout remains active for the lifetime of the stream rather than ending when HTTP headers
arrive.

## Testing

The test suite is exercised across unit, integration, and functional coverage:

```bash
# Run unit, integration, and functional test suite
npm test

# Run typechecker
npm run typecheck

# Run linter
npm run lint

# Verify the built package runs correctly in a real Edge Runtime sandbox with zero
# Node.js APIs (see "Edge Runtime Compatibility" above) — requires `npm run build` first
npm run verify:edge-runtime

# Run the benchmark suite (NDJSON streaming, schema conversion, tool dispatch, the
# request pipeline)
npm run bench

# Run full CI verification pipeline (typecheck, lint, test, build, edge runtime check)
npm run verify

# Non-disastrous smoke test: contract gates (validate, IR diff, type drift) + full
# verify chain + package type-resolution check + real CJS/ESM consumer compile.
# Read-only — no clean, no codegen rewriting src/generated. Live conformance runs
# automatically if an Ollama server is reachable on localhost:11434 (otherwise
# those tests skip cleanly).
npm run smoke
```

---

## License

MIT © [Shubham Taywade](https://github.com/shubhamtaywade82)
