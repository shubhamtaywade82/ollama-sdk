---
outline: [2, 3]
---

# OpenAI Compatibility

Ollama exposes OpenAI-compatible `/v1` endpoints for chat completions, completions, embeddings, models, and the newer Responses API. The SDK's `OpenAICompatClient` (accessible via `client.openai`) is a typed pass-through that implements the subset of the OpenAI API surface Ollama documents as supported — not the full hosted-OpenAI surface (no hosted tools, computer use, code interpreter, or stateful conversation state).

## When to use the OpenAI bridge

- You're migrating an existing OpenAI-based application to Ollama without rewriting request shapes.
- You want strict OpenAI typed requests for interoperability with OpenAI SDK consumers.
- You need `/v1/responses` (the newer Responses API), which Ollama supports non-statefully.

For new code with no OpenAI legacy, prefer the native `chat`/`generate`/`embed` methods — they support features (vision via `Uint8Array`, thinking tokens, failover-aware `holdUntil`) the bridge doesn't surface.

## Accessing the bridge

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
const openai = client.openai; // OpenAICompatClient
```

The bridge shares the parent client's transport, middleware, retry, failover, and telemetry — there's no separate HTTP client to configure.

## Chat completions

```typescript
const res = await client.openai.chatCompletions({
  model: 'llama3.2',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Explain vector embeddings in two sentences.' },
  ],
  temperature: 0.7,
  max_tokens: 200,
  stream: false, // default — non-streaming
});

console.log(res.choices[0]?.message.content);
console.log(res.usage); // { prompt_tokens, completion_tokens, total_tokens }
```

`createChatCompletion` is an alias for `chatCompletions`.

### Streaming chat completions

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

The returned `OpenAIChatCompletionStream` is an `AsyncIterable<OpenAIChatCompletionChunk>` with a `finalResult` promise that resolves to the reconstructed `OpenAIChatCompletionResponse`.

## Completions (legacy text completion)

```typescript
const res = await client.openai.completions({
  model: 'llama3.2',
  prompt: 'The capital of France is',
  max_tokens: 5,
  temperature: 0,
});

console.log(res.choices[0]?.text); // ' Paris'
```

`createCompletion` is an alias. Streaming works the same way as chat completions.

## Embeddings

```typescript
const res = await client.openai.embeddings({
  model: 'nomic-embed-text:latest',
  input: ['First document.', 'Second document.'],
});

console.log(res.data[0]?.embedding); // number[]
console.log(res.usage); // { prompt_tokens, total_tokens }
```

`createEmbedding` is an alias. `input` accepts a string or array of strings.

## Models

```typescript
const list = await client.openai.listModels();
for (const m of list.data) {
  console.log(m.id, m.owned_by);
}

const model = await client.openai.retrieveModel('llama3.2');
console.log(model.id, model.owned_by);
```

`getModel` is an alias for `retrieveModel`.

## Responses API (`/v1/responses`)

Ollama supports the newer OpenAI Responses API non-statefully — send the full conversation in `input` on every call. `previous_response_id` and `conversation` are accepted for OpenAI request-shape compatibility but ignored.

```typescript
const res = await client.openai.responses({
  model: 'llama3.2',
  input: 'Hello via the OpenAI Responses bridge',
});

// output is an array of items; the assistant message is typically first.
const text = res.output
  .flatMap((item) => item.type === 'message' ? item.content : [])
  .filter((c): c is { type: 'output_text'; text: string } => c.type === 'output_text')
  .map((c) => c.text)
  .join('');

console.log(text);
```

`createResponses` is an alias. Streaming produces the full `OpenAIResponsesStreamEvent` union — `response.output_text.delta`, `response.function_call_arguments.delta`, `response.reasoning_text.delta`, etc. — and the `finalResult` resolves to a reconstructed `OpenAIResponsesResponse`.

```typescript
const stream = await client.openai.responses({
  model: 'qwen3',
  input: 'Write a haiku about streaming.',
  stream: true,
});

for await (const event of stream) {
  if (event.type === 'response.output_text.delta') {
    process.stdout.write(event.delta);
  }
}
```

## Reasoning effort for thinking models

For thinking models (`deepseek-r1`, `qwen3`, `gpt-oss`), both `reasoning_effort` and `reasoning.effort` are accepted:

```typescript
await client.openai.chatCompletions({
  model: 'deepseek-r1:8b',
  messages: [{ role: 'user', content: 'Solve: 17 * 23' }],
  reasoning_effort: 'high',
  // equivalent: reasoning: { effort: 'high' }
});
```

Valid `reasoning_effort` values: `'high'`, `'medium'`, `'low'`, `'max'`, `'none'`, `'minimal'`, `'xhigh'`, `'ultra'`, or any model-defined string. Ollama's compat layer maps these to the native `think` parameter.

## Structured output (`response_format`)

```typescript
const res = await client.openai.chatCompletions({
  model: 'qwen3',
  messages: [{ role: 'user', content: 'Generate a fictional user profile.' }],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'UserProfile',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number', minimum: 18, maximum: 99 },
        },
        required: ['name', 'age'],
      },
    },
  },
});

const user = JSON.parse(res.choices[0]?.message.content ?? '{}');
```

Or for unstructured JSON: `response_format: { type: 'json_object' }`.

## Multimodal input

OpenAI-style image content parts work:

```typescript
const res = await client.openai.chatCompletions({
  model: 'llava',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...' } },
      ],
    },
  ],
});
```

Ollama accepts both data URLs and the standard OpenAI `{ url: string, detail?: 'auto' | 'low' | 'high' | 'original' }` object.

## What's supported vs. ignored

The bridge types every standard OpenAI field, but Ollama's compat layer doesn't honor all of them:

| Field              | Supported by Ollama? | Notes                                                                                                |
| ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `tools`            | ✅ Yes                | Tool calling works natively.                                                                          |
| `tool_choice`      | ⚠️ Accepted, ignored | Every tool given to the model remains callable regardless of this value.                              |
| `parallel_tool_calls` | ⚠️ Accepted, ignored | Ollama's compat layer doesn't enforce parallel-call limits.                                          |
| `n`                | ⚠️ Accepted, ignored | Ollama generates one completion.                                                                      |
| `logprobs`         | ✅ Yes (for supported models) | Reasoning/chat models may emit logprobs.                                                              |
| `top_logprobs`     | ✅ Yes (for supported models) | Requires `logprobs: true`.                                                                            |
| `user`             | ⚠️ Accepted, ignored | Ollama doesn't enforce per-user rate limits.                                                          |
| `logit_bias`       | ⚠️ Accepted, ignored |                                                                                                       |
| `seed`             | ✅ Yes                | Deterministic sampling for the same prompt.                                                           |
| `previous_response_id` | ⚠️ Accepted, ignored | `/v1/responses` is non-stateful in Ollama.                                                            |

For compile-time enforcement of the supported subset, the package also exports strict request types: `OllamaOpenAIChatCompletionRequest`, `OllamaOpenAIResponsesRequest`, `OllamaOpenAIEmbeddingRequest`. Use these when you want TypeScript to reject fields Ollama ignores.

## Failover and routing

OpenAI compat requests participate in the same [failover and routing layer](./failover) as native inference calls. The `model` field is used for `endpoints`/`models` allow-list routing, and capacity slots are held for as long as a streaming response is being consumed.

```typescript
const client = new OllamaClient({
  endpoints: [
    { name: 'local', baseUrl: 'http://localhost:11434', priority: 10 },
    { name: 'cloud', baseUrl: 'https://ollama.com', apiKey: process.env.OLLAMA_API_KEY!, priority: 5 },
  ],
});

// Routed automatically — local first, cloud as fallback.
const res = await client.openai.chatCompletions({
  model: 'qwen3',
  messages: [{ role: 'user', content: 'Hello via OpenAI bridge' }],
});
```

## Strict request types

For compile-time enforcement of Ollama's documented subset:

```typescript
import type { OllamaOpenAIChatCompletionRequest } from '@nemesis-oss/ollama-sdk';

const req: OllamaOpenAIChatCompletionRequest = {
  model: 'qwen3',
  messages: [{ role: 'user', content: 'Hello' }],
  temperature: 0.7,
  // tool_choice: 'auto' — ❌ TypeScript error: Ollama doesn't honor this
};

await client.openai.chatCompletions(req);
```

The broader `OpenAIChatCompletionRequest` type remains available for pass-through interoperability with vendor-specific fields.

## Cancellation

Pass an `AbortSignal` as the second argument to any bridge method:

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const res = await client.openai.chatCompletions(
  { model: 'qwen3', messages, stream: false },
  controller.signal,
);
```

Streaming responses expose `.abort()` directly:

```typescript
const stream = await client.openai.chatCompletions({ /* ... */, stream: true });
setTimeout(() => stream.abort(), 5_000);

try {
  for await (const chunk of stream) { /* ... */ }
} catch (err) {
  // OllamaAbortError
}
```

## Errors

Bridge calls throw the same `OllamaClientError` hierarchy as native calls — `OllamaAuthError` for 401/403, `OllamaRateLimitError` for 429, `OllamaServerError` for 5xx, and so on. See the [Errors reference](../api/errors).

## Next steps

- **[Anthropic Compatibility](./anthropic-compat)** — symmetric bridge for `/v1/messages`.
- **[Streaming](./streaming)** — full streaming surface, including OpenAI SSE adapters.
- **[Failover & Routing](./failover)** — how compat requests participate in the endpoint registry.
- **[API Reference: OllamaClient](../api/client)** — the `client.openai` accessor.
