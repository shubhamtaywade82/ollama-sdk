---
outline: [2, 3]
---

# Generate

The generate API (`POST /api/generate`) is Ollama's text-completion endpoint — a single prompt plus optional system, suffix, and structured output. Use it for one-shot completions, transforms, and prompt-template-driven workflows where message history isn't needed.

## Basic completion

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

const res = await client.generate({
  model: 'llama3.2',
  prompt: 'The capital of France is',
  stream: false,
  options: { temperature: 0, num_predict: 5 },
});

console.log(res.response); // ' Paris'
console.log({
  evalTokens: res.eval_count,
  promptTokens: res.prompt_eval_count,
  totalDurationMs: res.total_duration,
});
```

### `generateText` shortcut

```typescript
const continuation = await client.generateText({
  model: 'llama3.2',
  prompt: 'Once upon a time in a',
});
```

## Streaming

`generateStream` returns an `OllamaStream` of events with discrete `thinking`, `token`, and `done` payloads — same surface as `chatStream`:

```typescript
const stream = await client.generateStream({
  model: 'qwen3:8b',
  prompt: 'Write a limerick about a debugger.',
  think: 'high',
});

for await (const event of stream) {
  if (event.type === 'thinking') process.stdout.write(`\x1b[33m${event.data.delta}\x1b[0m`);
  else if (event.type === 'token') process.stdout.write(event.data.delta);
}

const final = await stream.finalResult;
console.log(`\nEval tokens/sec: ${final.usage?.tokensPerSecond}`);
```

## System prompt and template

`system` sets a system prompt without needing a separate message; `template` overrides the model's prompt template:

```typescript
const res = await client.generate({
  model: 'llama3.2',
  prompt: 'List three benefits of static typing.',
  system: 'You are a TypeScript expert. Be concise.',
  stream: false,
});
```

## Suffix-based completion (FIM)

Pass `suffix` for fill-in-the-middle completion — useful for code completion in editors:

```typescript
const res = await client.generate({
  model: 'qwen2.5-coder:7b',
  prompt: 'function fibonacci(',
  suffix: ') {\n  return result;\n}',
  stream: false,
  options: { temperature: 0.1, stop: ['\n}'] },
});

console.log(res.response);
// Example: n: number): number {
//   const result = n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);
```

## Context preservation

Each generate response includes a `context` token array. Pass it back on the next call to continue the same session without re-sending the prompt:

```typescript
const first = await client.generate({
  model: 'llama3.2',
  prompt: 'My favorite color is blue.',
  stream: false,
});

const second = await client.generate({
  model: 'llama3.2',
  prompt: 'What did I just say my favorite color was?',
  context: first.context,
  stream: false,
});

console.log(second.response); // 'You said your favorite color is blue.'
```

::: tip Prefer `chat` for multi-turn
`context` is opaque and tied to the model's KV cache. For multi-turn dialogue, prefer [`chat`](./chat) with explicit message history — it's portable across models and easier to debug.
:::

## Structured output

Pass a Zod schema to `generateWithSchema` for typed JSON:

```typescript
import { z } from 'zod';

const SummarySchema = z.object({
  title: z.string(),
  bullets: z.array(z.string()).min(2).max(5),
  keywords: z.array(z.string()),
});

const result = await client.generateWithSchema(
  {
    model: 'qwen3:8b',
    prompt: 'Summarize the key ideas of REST APIs.',
    system: 'You are a technical writer.',
  },
  SummarySchema,
);

console.log(result.title);
console.log(result.bullets);
```

`generateWithSchema` is the same as passing `format: zodToJsonSchema(schema)` to `generate` and then `parseStructuredOutput(res.response, schema)`. See [Structured Output](./structured-output) for the full surface, including error handling, format options, and choosing between `chat` and `generate` schemas.

## Raw JSON format

If you'd rather skip Zod and pass a raw JSON Schema, use `format` directly:

```typescript
const res = await client.generate({
  model: 'qwen3:8b',
  prompt: 'Generate a fictional user profile.',
  format: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number', minimum: 18, maximum: 99 },
      email: { type: 'string', format: 'email' },
    },
    required: ['name', 'age'],
  },
  stream: false,
});

const user = JSON.parse(res.response);
```

::: warning Cloud doesn't support structured output
Structured output (`format`) is rejected pre-flight against Ollama Cloud endpoints with `OllamaUnsupportedCapabilityError`. In a multi-endpoint setup, `unsupported_capability` is in `DEFAULT_FAILOVER_CODES`, so the request fails over to the next candidate that supports it (typically your local endpoint). See [Failover](./failover) and [ADR 0008](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0008-endpoint-failover-scope.md).
:::

## Multimodal input

`generate` accepts a top-level `images` array (same shape as chat — base64 strings or `Uint8Array`):

```typescript
import { readFile } from 'node:fs/promises';

const bytes = await readFile('./chart.png');

const res = await client.generate({
  model: 'llava',
  prompt: 'Describe this chart and list its data points.',
  images: [bytes],
  stream: false,
});
```

## Image generation (experimental)

For models that produce images (e.g. diffusion-based), pass `width`, `height`, and `steps`:

```typescript
const res = await client.generate({
  model: 'stable-diffusion',
  prompt: 'A serene mountain lake at sunrise, oil painting style',
  width: 1024,
  height: 768,
  steps: 30,
  stream: false,
});

// res.image is a base64-encoded PNG.
import { writeFile } from 'node:fs/promises';
await writeFile('./out.png', Buffer.from(res.image!, 'base64'));
```

These fields are experimental and depend on the model — `client.capabilities(model)` will tell you what the model supports.

## Thinking tokens

Like `chat`, `generate` accepts a `think` parameter for reasoning models:

```typescript
const res = await client.generate({
  model: 'deepseek-r1:8b',
  prompt: 'Solve: 17 * 23',
  think: 'high',
  options: { temperature: 0 },
  stream: false,
});

console.log('Thinking:', res.thinking);
console.log('Answer:', res.response);
```

Streaming `thinking` events come through on `generateStream` exactly like `chatStream`.

## Cancellation

Pass an `AbortSignal` to cancel any generate call, streaming or not:

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

try {
  const res = await client.generate({
    model: 'qwen3:8b',
    prompt: 'Write a 10,000-word essay on distributed systems.',
    signal: controller.signal,
    stream: false,
  });
} catch (err) {
  // OllamaAbortError with code 'aborted', retryable: false
}
```

Streaming abort is the same — pass `signal` and the stream's underlying HTTP request is cancelled immediately.

## Next steps

- **[Chat](./chat)** — message-based conversations, tools, vision
- **[Structured Output](./structured-output)** — Zod schemas, validation, format options
- **[Streaming](./streaming)** — abort, backpressure, Web Stream adapters
- **[Embeddings](./embed)** — vector representations of text
