---
outline: [2, 3]
---

# Streaming

The SDK exposes a unified streaming surface for chat, generate, and model lifecycle operations. Native Ollama endpoints use NDJSON (newline-delimited JSON); OpenAI and Anthropic compatibility endpoints use SSE (Server-Sent Events). The `OllamaStream` wrapper normalizes all of them into a single event union you can consume as either an `AsyncIterable` or an EventEmitter-like API.

## Why a unified stream

- **One event type, three transports** — chat (NDJSON), OpenAI compat (SSE), and Anthropic compat (SSE) all produce `token` / `thinking` / `tool_call` / `message` / `done` / `error` events.
- **Two consumption modes** — `for await (const event of stream)` for pipelines, `stream.on('token', ...)` for UI wiring.
- **Aggregated `finalResult`** — await `stream.finalResult` to get the reconstructed message/response without re-iterating the events.
- **Web Stream adapters** — `toTextStream`, `toDataStream`, and `toResponse` bridge into Vercel AI SDK, Next.js Route Handlers, and standard `fetch`.

## Chat streaming

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

const stream = await client.chatStream({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Write a one-paragraph product description for a smart thermostat.' }],
});

for await (const event of stream) {
  if (event.type === 'token') process.stdout.write(event.data.delta);
}

const final = await stream.finalResult;
console.log(`\n\nEval tokens/sec: ${final.usage?.tokensPerSecond}`);
```

## Event reference

Every event is a discriminated union on `event.type`:

```typescript
type OllamaStreamEvent<TChunk, TFinal> =
  | { type: 'token';     data: { delta: string; role?: string } }
  | { type: 'thinking';  data: { delta: string } }
  | { type: 'tool_call'; data: { toolCall: ToolCall } }
  | { type: 'message';   data: { chunk: TChunk } }
  | { type: 'done';      data: { result: TFinal } }
  | { type: 'error';     data: { error: OllamaClientError } };
```

| Event       | When emitted                                              | Payload                                          |
| ----------- | --------------------------------------------------------- | ------------------------------------------------ |
| `token`     | A new content token arrives.                              | `delta: string`, optional `role: string`         |
| `thinking`  | A reasoning token arrives (only with `think: 'high'` etc.). | `delta: string`                                  |
| `tool_call` | The model requests a tool call mid-stream.                | `toolCall: { id?, function: { name, arguments } }` |
| `message`   | A raw chunk is received (the underlying Ollama response). | `chunk: ChatResponse \| GenerateResponse`        |
| `done`      | The stream completed successfully.                        | `result: ChatStreamResult \| GenerateStreamResult` |
| `error`     | An error occurred (network, parse, abort, server).        | `error: OllamaClientError`                       |

## EventEmitter-style consumption

For UIs that wire up callbacks, use `.on(type, listener)`:

```typescript
const stream = await client.chatStream({ model: 'qwen3:8b', messages });

const off = stream.on('token', (event) => {
  ui.appendToken(event.data.delta);
});

stream.on('done', (event) => {
  ui.finalize(event.data.result.message.content);
  off();
});

stream.on('error', (event) => {
  ui.showError(event.data.error);
});
```

::: warning Pick one mode per stream
A stream is consumed either as an async iterator _or_ via `.on()` — not both. Mixing throws a clear error. The `finalResult` promise works in both modes.
:::

## Aborting a stream

Pass an `AbortSignal` in the request, or call `stream.abort()` directly:

```typescript
const controller = new AbortController();
const stream = await client.chatStream({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Tell me a 10,000-word story.' }],
  signal: controller.signal,
});

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5_000);

try {
  for await (const event of stream) {
    if (event.type === 'token') process.stdout.write(event.data.delta);
  }
} catch (err) {
  // OllamaAbortError — clean cancellation
}

// Or call abort() directly:
const s2 = await client.chatStream({ model: 'qwen3:8b', messages });
setTimeout(() => s2.abort(), 1_000);
```

The underlying HTTP connection is cancelled immediately on abort — no token is left dangling.

## Final result

`stream.finalResult` is a `Promise<TFinal>` that resolves with the aggregated response, regardless of how the stream was consumed:

```typescript
const stream = await client.chatStream({ model: 'qwen3:8b', messages });

// Fire-and-forget the events; await the final result elsewhere:
void (async () => {
  for await (const event of stream) {
    if (event.type === 'token') ui.append(event.data.delta);
  }
})();

const result = await stream.finalResult;
console.log(result.message.content);
console.log(result.usage); // { promptTokens, completionTokens, totalTokens, tokensPerSecond, ... }
```

## Thinking tokens in streams

For reasoning models, `thinking` events fire before `token` events. Use them to render a collapsible reasoning trace:

```typescript
const stream = await client.chatStream({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Solve: what is 17 * 23? Reason through it.' }],
  think: 'high',
});

let thinkingBuffer = '';
for await (const event of stream) {
  if (event.type === 'thinking') {
    thinkingBuffer += event.data.delta;
  } else if (event.type === 'token') {
    if (thinkingBuffer) {
      console.log(`\n--- Thinking ---\n${thinkingBuffer}\n--- Answer ---\n`);
      thinkingBuffer = '';
    }
    process.stdout.write(event.data.delta);
  }
}
```

## Generate streaming

```typescript
const stream = await client.generateStream({
  model: 'qwen3:8b',
  prompt: 'Write a Python function that returns the nth Fibonacci number.',
  think: 'high',
});

for await (const event of stream) {
  if (event.type === 'token') process.stdout.write(event.data.delta);
  if (event.type === 'thinking') process.stderr.write(`\x1b[33m${event.data.delta}\x1b[0m`);
}
```

## OpenAI compatibility streaming

The OpenAI bridge uses SSE under the hood, but the SDK exposes the same `OllamaStream`-style surface via `OpenAIChatCompletionStream`, `OpenAICompletionStream`, and `OpenAIResponsesStream`:

```typescript
const stream = await client.openai.chatCompletions({
  model: 'qwen3',
  messages: [{ role: 'user', content: 'Explain SSE.' }],
  stream: true,
  stream_options: { include_usage: true },
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content ?? '';
  if (delta) process.stdout.write(delta);
}

const final = await stream.finalResult;
console.log(`\nUsage:`, final.usage);
```

See [OpenAI Compatibility](./openai-compat) for the full bridge surface.

## Anthropic compatibility streaming

`AnthropicMessagesStream` yields the standard Anthropic SSE event types (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) and reconstructs the final `AnthropicMessagesResponse`:

```typescript
const stream = await client.anthropic.messages({
  model: 'claude-3.5-sonnet',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello via Anthropic bridge' }],
  stream: true,
});

for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}

const final = await stream.finalResult;
console.log(`\nStop reason: ${final.stop_reason}`);
```

See [Anthropic Compatibility](./anthropic-compat) for the full bridge surface.

## Web Stream adapters — Next.js / Vercel AI SDK

`toTextStream`, `toDataStream`, and `toResponse` convert an `OllamaStream` into standard Web platform primitives — `ReadableStream<string>`, `ReadableStream<Uint8Array>`, and `Response` respectively.

### Next.js Route Handler

```typescript
// app/api/chat/route.ts
import { OllamaClient, toResponse } from '@nemesis-oss/ollama-sdk';
import { after } from 'next/server';

export const runtime = 'edge';

const client = new OllamaClient({ baseUrl: process.env.OLLAMA_HOST });

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: { role: string; content: string }[] };

  const stream = await client.chatStream({
    model: 'qwen3:8b',
    messages: messages as never,
  });

  return toResponse(stream, {
    headers: { 'X-Model': 'qwen3:8b' },
  });
}
```

`toResponse` returns a `Response` with `Content-Type: text/plain; charset=utf-8` and a streaming body — drop it into any Web framework that expects a standard `Response`.

### Vercel AI SDK adapter

The Vercel AI SDK's `streamText` accepts a `ReadableStream<Uint8Array>`. Bridge with `toDataStream`:

```typescript
import { OllamaClient, toDataStream } from '@nemesis-oss/ollama-sdk';
import { streamText } from 'ai';

const client = new OllamaClient();

async function ollamaStream(prompt: string): Promise<ReadableStream<Uint8Array>> {
  const stream = await client.chatStream({
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: prompt }],
  });
  return toDataStream(stream);
}

// Pipe into any Vercel AI SDK consumer.
```

### Raw `ReadableStream<string>`

```typescript
import { toTextStream } from '@nemesis-oss/ollama-sdk';

const stream = await client.chatStream({ model: 'qwen3:8b', messages });
const textStream: ReadableStream<string> = toTextStream(stream);

const reader = textStream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(value); // string chunk
}
```

## Streaming model lifecycle operations

`pullModel` and `createModel` also stream — but they emit `ProgressStreamResult` events (`message` chunks with `status`, `completed`, `total`):

```typescript
const stream = await client.models.pull({ model: 'qwen3:8b', stream: true });

for await (const event of stream) {
  if (event.type === 'message') {
    const { status, completed, total } = event.data.chunk;
    if (total) {
      const pct = Math.round(((completed ?? 0) / total) * 100);
      process.stdout.write(`\r${status}: ${pct}%`);
    } else {
      process.stdout.write(`\r${status}`);
    }
  }
}
```

`createModel` exposes the same surface — useful for showing quantization/build progress.

## Inspecting raw chunks

For debugging, iterate `message` events to see the raw NDJSON chunks Ollama returns:

```typescript
const stream = await client.chatStream({ model: 'qwen3:8b', messages });

for await (const event of stream) {
  if (event.type === 'message') {
    console.log(JSON.stringify(event.data.chunk));
  }
}
```

Each `chunk` is a full `ChatResponse` with `done: false` until the final one, which has `done: true` and the cumulative usage stats.

## Backpressure

`OllamaStream` pulls chunks lazily — `for await` waits for your loop body to settle before pulling the next chunk. If your consumer is slow (e.g. writing to disk), the underlying HTTP connection is naturally back-pressured. There's no `highWaterMark` to tune.

## Error semantics

| Failure                | Event                                                | Behavior                                                                 |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Network/timeout/abort  | `error` with `OllamaClientError` subclass            | `finalResult` rejects with the same error.                              |
| Mid-stream server 5xx  | `error` with `OllamaServerError`                     | The stream stops; no further events fire.                                |
| Invalid NDJSON         | `error` with `OllamaNetworkError` or wrapped         | Same as server error.                                                    |
| `stream.abort()`       | `error` with `OllamaAbortError`                      | The underlying HTTP request is cancelled.                                |

The streaming pipeline participates in [failover](./failover) the same way non-streaming calls do — if the first endpoint fails mid-stream, the request retries on the next candidate (subject to the retry budget).

## Next steps

- **[Chat](./chat)** — full chat API surface
- **[OpenAI Compatibility](./openai-compat)** — SSE-based streaming for `/v1/chat/completions`
- **[Anthropic Compatibility](./anthropic-compat)** — SSE-based streaming for `/v1/messages`
- **[Failover & Routing](./failover)** — how streaming slots participate in concurrency limits
