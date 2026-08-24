# @nemesis-oss/ollama-sdk

[![CI](https://github.com/shubhamtaywade82/ollama-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/shubhamtaywade82/ollama-sdk/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@nemesis-oss/ollama-sdk.svg)](https://www.npmjs.com/package/@nemesis-oss/ollama-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> Production-grade TypeScript SDK for Ollama. Built with native fetch, high availability failover, multi-turn tool calling, structured outputs with Zod, reasoning stream tokens, OpenAI & Anthropic compatibility bridges, MCP integration, and Web Stream adapters.

---

## Key Features

- 🚀 **Native Web Standards**: Built on native `fetch` and Web Streams. Zero external HTTP dependencies.
- 🧠 **Reasoning & Thinking Tokens**: First-class support for reasoning models (`qwen3:8b`, `deepseek-r1:8b`) via the native `think` parameter, with discrete `thinking` and `token` streaming events, plus `logprobs`/`top_logprobs` for token-level confidence scoring.
- 🖼️ **Multimodal / Vision Input**: `images` on `Message`/`generate()` accepts base64 strings or raw `Uint8Array` bytes (auto-encoded) for vision models like `llava` or `qwen2.5vl`.
- 🎯 **Zod-Powered Structured Outputs**: Strictly typed schema enforcement via `chatWithSchema` and `generateWithSchema` with resilient markdown JSON parsing.
- 🛠️ **Autonomous Agent & Tool Calling**: Multi-turn agent loop (`Agent`) with automated tool execution, parameter validation, and self-correcting error recovery.
- 🌐 **High Availability & Failover**: Multi-endpoint registry with priority routing, circuit breaker failover, and active health checks.
- 🔌 **Model Context Protocol (MCP)**: Native adapters to convert MCP tools into Ollama-compatible function schemas.
- 📚 **Full Model Lifecycle**: `pullModel`, `pushModel`, `createModel`, `copyModel`, `deleteModel`, `listModels`, `showModel`, and `ps()` (currently loaded models) — full parity with Ollama's model management API.
- 🔎 **Ollama Cloud Web Tools**: `webSearch`/`webFetch` wrap Ollama's hosted `/api/web_search` and `/api/web_fetch` tools at `ollama.com` (requires an `OLLAMA_API_KEY`), independent of any local `baseUrl`.
- 🌉 **OpenAI & Anthropic Compatibility Bridges**: Built-in clients for `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/v1/messages`, including `reasoning_effort`/`reasoning.effort` for thinking models.
- 🌊 **Web Stream Adapters**: Drop-in adapters (`toTextStream`, `toDataStream`, `toResponse`) for Next.js Route Handlers and Vercel AI SDK.
- 📈 **OpenTelemetry Instrumentation**: Automatic spans for HTTP requests, endpoint failover, chat/generate calls, and agent runs — zero-cost when OpenTelemetry isn't installed.
- ⚡ **Edge Runtime Verified**: CI bundles and runs the client in a real Edge Runtime sandbox (Cloudflare Workers/Vercel Edge-compatible) with zero Node.js APIs.
- 📦 **Dual ESM & CJS Build**: Full module support with clean TypeScript `.d.ts` declaration maps.

---

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

`think` is Ollama's native reasoning-effort parameter, exposed directly on `chat()`/`generate()` — no bridge translation needed. It accepts `true`/`false` or a level (`'low' | 'medium' | 'high' | 'max'`); the OpenAI bridge's `reasoning_effort` (see below) is a compatibility alias for the same underlying knob.

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

`images` on a `Message` (or on `generate()`'s top-level request) accepts base64-encoded strings or raw `Uint8Array` bytes — `Uint8Array` entries are base64-encoded automatically before the request is sent.

```typescript
import { readFile } from 'node:fs/promises';

const imageBytes = await readFile('./cat.png'); // Buffer, a Uint8Array subclass

const res = await client.chatText({
  model: 'llava',
  messages: [{ role: 'user', content: 'What is in this image?', images: [imageBytes] }],
});
console.log(res);

// Base64 strings work too, unchanged:
const base64Res = await client.generateText({
  model: 'llava',
  prompt: 'Describe this image.',
  images: ['iVBORw0KGgoAAAANSUhEUgAA...'],
});
```

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

Ollama's native tool-calling protocol has no OpenAI-style call ID, but the SDK
synthesizes a stable one so results are still correlatable without tracking array
position by hand: `response.turns[0].toolCalls[0].id` matches
`response.turns[0].toolResults[0].toolCallId`, and the `role: 'tool'` message `Agent`
appends to history carries the same value as `tool_call_id`. See
[ADR 0007](./docs/adr/0007-synthetic-tool-call-ids.md).

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
| `OllamaServerError`                | `server_error`                  | `true`      | The endpoint returned `5xx`.                                                                                                                                                                                                                             |
| `OllamaAbortError`                 | `aborted`                       | `false`     | The request was cancelled via `AbortSignal`.                                                                                                                                                                                                             |
| `OllamaToolValidationError`        | `tool_validation_error`         | `false`     | A tool call's arguments, or a `chatWithSchema`/`generateWithSchema` result, failed Zod validation.                                                                                                                                                       |
| `OllamaUnsupportedCapabilityError` | `unsupported_capability`        | `false`     | A `format` (structured output) request was made against an endpoint inferred as Ollama Cloud, which doesn't currently support it. Thrown before any network call; in `DEFAULT_FAILOVER_CODES`, so a multi-endpoint setup tries the next candidate first. |
| `OllamaAgentMaxIterationsError`    | `agent_max_iterations_exceeded` | `false`     | An `Agent` run exceeded `maxTurns` without producing a final answer.                                                                                                                                                                                     |
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

## Testing

The test suite contains 121 automated tests across 4 testing tiers:

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
```

---

## License

MIT © [Shubham Taywade](https://github.com/shubhamtaywade82)
