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

Images must be base64 `data:` URLs — either as a string or inside the standard OpenAI `{ url, detail? }` object. Ollama documents remote `http(s)://` image URLs as **unsupported** on `/v1/chat/completions`; resolve them to base64 first (`resolveImageInput`) or use native `chat()` with `images`.

## What's supported vs. ignored

Status mirrors the checkbox lists at [docs.ollama.com/api/openai-compatibility](https://docs.ollama.com/api/openai-compatibility) and is enforced by `npm run verify:contract-parity`. The broad `OpenAI*` request types accept every field for drop-in interop; the strict `OllamaOpenAI*` types reject the unsupported ones at compile time.

| Endpoint               | Supported request fields                                                                                                                                                                 | Documented as unsupported                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `/v1/chat/completions` | `model`, `messages` (text, base64 image, content-part arrays), `frequency_penalty`, `presence_penalty`, `response_format`, `seed`, `stop`, `stream`, `stream_options.include_usage`, `temperature`, `top_p`, `max_tokens`, `tools`, `reasoning_effort`, `reasoning.effort` | `tool_choice`, `logit_bias`, `user`, `n`, logprobs, image URLs |
| `/v1/completions`      | `model`, `prompt` (string only), `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `stream`, `stream_options.include_usage`, `temperature`, `top_p`, `max_tokens`, `suffix`      | `best_of`, `echo`, `logit_bias`, `user`, `n`, logprobs      |
| `/v1/embeddings`       | `model`, `input` (string or string array), `encoding_format`, `dimensions`                                                                                                              | token / token-array `input`, `user`                         |
| `/v1/responses`        | `model`, `input`, `instructions`, `tools`, `stream`, `temperature`, `top_p`, `max_output_tokens`, `reasoning.effort`, `think` (Ollama extension)                                        | `previous_response_id`, `conversation`, `truncation`        |
| `/v1/audio/speech`     | `model`, `input` (≤ 4,096 chars), `voice`, `response_format` (`wav`, `pcm`), `speed` (`1`), `stream_format` (`audio`) — Ollama v0.40.8+                                                | `instructions`, `mp3`/`opus`/`aac`/`flac` formats           |

`parallel_tool_calls` and `top_logprobs` are SDK-typed for interop but not part of Ollama's documented surface. For token log probabilities, use native `chat()`/`generate()` with `logprobs: true` and `top_logprobs`.

`/v1/audio/speech` is documented ahead of upstream's own `openapi.yaml` and its response is a raw audio byte stream, so the SDK records it in the contract (typed `OpenAISpeechRequest`/`OllamaOpenAISpeechRequest`) but does not yet transport it — drive the endpoint over your own HTTP layer until an audio transport lands ([ADR 0038](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0038-audio-speech-contract-mdx-pin-provenance.md)).

### Direct Ollama Cloud access

No local server is needed: point the client at `https://ollama.com` with an API key and the bridge calls `https://ollama.com/v1/...` with `Authorization: Bearer <key>`. Use the hosted model identifiers from `https://ollama.com/api/tags` (e.g. `gemma4:31b`). The cloud API does not support stateful Responses, built-in web search through `/v1/responses`, or custom/freeform tool-call replay.

```typescript
const cloud = new OllamaClient({ baseUrl: 'https://ollama.com', apiKey: process.env.OLLAMA_API_KEY });
const res = await cloud.openai.chatCompletions({
  model: 'gemma4:31b',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
});
```

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
  // tool_choice: 'auto' — ❌ TypeScript error: documented as unsupported by Ollama
  // n: 2               — ❌ TypeScript error
  // logprobs: true     — ❌ TypeScript error (use native chat({ logprobs: true }))
};

await client.openai.chatCompletions(req);
```

Also available: `OllamaOpenAICompletionRequest`, `OllamaOpenAIEmbeddingRequest`, and `OllamaOpenAIResponsesRequest`. The broader `OpenAIChatCompletionRequest` type remains available for pass-through interoperability with vendor-specific fields.

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
