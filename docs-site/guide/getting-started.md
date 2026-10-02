---
outline: [2, 3]
---

# Getting Started

This page walks through installing the SDK, configuring your first `OllamaClient`, and making chat, generate, and embed requests. Everything here works against a local Ollama server at `http://localhost:11434` — set `OLLAMA_HOST` or pass `baseUrl` to target a remote instance.

## Prerequisites

- **Node.js 20+** (or any modern Edge runtime: Cloudflare Workers, Vercel Edge, Bun, Deno)
- **Ollama 0.5+** running locally — install it from [ollama.com](https://ollama.com) and pull at least one model:

```bash
ollama pull qwen3:8b
ollama pull nomic-embed-text:latest
```

::: tip Verify the server is up
```bash
curl http://localhost:11434/api/version
```
:::

## Installation

```bash
npm install @nemesis-oss/ollama-sdk zod
```

`zod` is a peer dependency (`^3.22.0 || ^4.0.0`) — install whichever major your project already uses. The SDK auto-detects v4's native `z.toJSONSchema` and falls back to a structural walker for v3 schemas, so both work as first-class peers.

### Optional peer dependencies

- **`@opentelemetry/api`** — automatic distributed tracing for HTTP, failover, chat/generate, and agent runs. No-op when not installed.
- **`@modelcontextprotocol/client`** — required only if you use the `@nemesis-oss/ollama-sdk/mcp/stdio` or `@nemesis-oss/ollama-sdk/mcp/http` subpaths to spawn/transport MCP clients directly.

```bash
npm install @opentelemetry/api
# Only if you use the stdio/http MCP connectors:
npm install @modelcontextprotocol/client
```

## Configuration

The client reads `OLLAMA_HOST` and `OLLAMA_API_KEY` from the environment by default, matching the official `ollama` CLI's convention.

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

// Defaults to http://localhost:11434, no API key.
const client = new OllamaClient();

// Explicit configuration
const cloudClient = new OllamaClient({
  baseUrl: 'https://ollama.com',
  apiKey: process.env.OLLAMA_API_KEY!,
  timeoutMs: 60_000,
  retries: 3,
});
```

### Multi-endpoint failover

Pass an array of `endpoints` to enable priority routing, circuit breakers, and per-endpoint `models` allow-lists. See [Failover & Routing](./failover) for the full pattern.

```typescript
const client = new OllamaClient({
  endpoints: [
    { name: 'local-gpu', baseUrl: 'http://localhost:11434', priority: 10 },
    { name: 'cloud', baseUrl: 'https://ollama.com', apiKey: process.env.OLLAMA_API_KEY!, priority: 5 },
  ],
});
```

### Environment variable resolution

| Variable           | Used by                            | Default value              |
| ------------------ | ---------------------------------- | -------------------------- |
| `OLLAMA_HOST`      | `baseUrl` when not set explicitly  | `http://localhost:11434`   |
| `OLLAMA_API_KEY`   | `apiKey` when not set explicitly   | (unset — anonymous access) |

The env read is guarded with `typeof process !== 'undefined'` so the client is safe to import in Cloudflare Workers and Vercel Edge — it simply returns `undefined` for the env var there.

## Your first request

### Chat

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

const response = await client.chat({
  model: 'qwen3:8b',
  messages: [
    { role: 'system', content: 'You are a concise assistant.' },
    { role: 'user', content: 'What is a closure in JavaScript?' },
  ],
  stream: false,
});

console.log(response.message.content);
console.log(`Tokens: ${response.eval_count} (prompt: ${response.prompt_eval_count})`);
```

Need just the text? Use `chatText()`:

```typescript
const answer = await client.chatText({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Define closure in one sentence.' }],
});
```

### Generate

`generate()` is Ollama's text-completion endpoint — a single prompt + optional system, no message history.

```typescript
const completion = await client.generate({
  model: 'llama3.2',
  prompt: 'The capital of France is',
  stream: false,
  options: { temperature: 0, num_predict: 5 },
});
console.log(completion.response); // ' Paris'
```

### Embed

```typescript
const { embeddings } = await client.embed({
  model: 'nomic-embed-text:latest',
  input: [
    'TypeScript SDK for Ollama',
    'Production-grade TypeScript client',
  ],
});

console.log(`${embeddings.length} vectors, ${embeddings[0].length} dimensions each`);
```

## Streaming

Every inference method has a streaming variant. The returned `OllamaStream` is both an `AsyncIterable` of typed events _and_ an EventEmitter-like API (`stream.on('token', ...)`).

```typescript
const stream = await client.chatStream({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Count to 5 slowly.' }],
});

for await (const event of stream) {
  if (event.type === 'token') process.stdout.write(event.data.delta);
  if (event.type === 'done') console.log('\nFinal:', event.data.result.message.content);
}
```

The [Streaming guide](./streaming) covers thinking tokens, tool-call deltas, aborting, and Web Stream adapters for Next.js/Vercel AI SDK.

## Structured output

Pass a Zod schema and get back typed data:

```typescript
import { z } from 'zod';

const SentimentSchema = z.object({
  label: z.enum(['positive', 'negative', 'neutral']),
  score: z.number().min(0).max(1),
  rationale: z.string(),
});

const result = await client.chatWithSchema(
  {
    model: 'qwen3:8b',
    messages: [
      { role: 'user', content: 'Analyze: "This SDK is fantastic — clean API, great docs."' },
    ],
  },
  SentimentSchema,
);

// result.label is 'positive' | 'negative' | 'neutral' — fully typed
console.log(result.label, result.score);
```

See [Structured Output](./structured-output) for the full surface, including `generateWithSchema`, format options, and validation error handling.

## Working with models

```typescript
// List installed models
const { models } = await client.listModels();
for (const m of models) {
  console.log(m.name, m.size, m.details?.parameter_size);
}

// Show details + capabilities for a specific model
const info = await client.showModel({ model: 'qwen3:8b' });
console.log(info.capabilities); // ['tools', 'completion', 'thinking']

// Currently loaded in VRAM
const running = await client.ps();
console.log(running.models.map((m) => `${m.name} (${m.size_vram} bytes)`));
```

The full model lifecycle (pull, push, create, copy, delete, blobs) is covered in the [API reference](../api/client#model-lifecycle).

## Edge runtime

The root package contains zero Node-only imports. Bundle it for Cloudflare Workers or Vercel Edge directly:

```typescript
// A Next.js Edge route handler
import { OllamaClient, toResponse } from '@nemesis-oss/ollama-sdk';

export const runtime = 'edge';

const client = new OllamaClient({ baseUrl: 'https://my-ollama.example.com' });

export async function POST(req: Request) {
  const { messages } = await req.json();
  const stream = await client.chatStream({ model: 'qwen3:8b', messages });
  return toResponse(stream); // standard Web Response, text/plain stream
}
```

`npm run verify:edge-runtime` runs a full round-trip in `@edge-runtime/vm` on every PR — see [ADR 0006](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0006-edge-runtime-ci-and-benchmarks.md) for the rationale.

## Where to go next

- **[Chat](./chat)** — tools, thinking tokens, logprobs, vision input
- **[Streaming](./streaming)** — abort, backpressure, Next.js adapters
- **[Failover & Routing](./failover)** — multi-endpoint, circuit breakers, least-connections
- **[System One Decisions](./system-one)** — typed choice/noul/score questions
- **[Agents & Tool Calling](./agents)** — autonomous loops with Zod-validated tools
- **[Contract-First Architecture](./contract-first)** — OpenAPI → IR → generated TypeScript + Zod + MCP
