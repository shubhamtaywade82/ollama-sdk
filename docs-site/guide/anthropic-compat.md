---
outline: [2, 3]
---

# Anthropic Compatibility

Ollama exposes an Anthropic-compatible `/v1/messages` endpoint. The SDK's `AnthropicCompatClient` (accessible via `client.anthropic`) is a typed pass-through that implements the subset of the Anthropic Messages API Ollama documents as supported — including thinking blocks, tool use, streaming, and image content.

## When to use the Anthropic bridge

- You're migrating an existing Anthropic-based application to Ollama without rewriting request shapes.
- You want strict Anthropic-typed requests for interoperability with Anthropic SDK consumers.
- You need Anthropic's content-block structure (text / image / tool_use / tool_result / thinking / redacted_thinking) instead of Ollama's flat message format.

For new code with no Anthropic legacy, prefer the native `chat` method — it supports features (vision via `Uint8Array`, `holdUntil` for streaming slot lifecycle, NDJSON streaming) the bridge doesn't surface.

## Accessing the bridge

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
const anthropic = client.anthropic; // AnthropicCompatClient
```

The bridge shares the parent client's transport, middleware, retry, failover, and telemetry — there's no separate HTTP client to configure.

## Basic message

```typescript
const res = await client.anthropic.messages({
  model: 'llama3.2',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: 'Explain vector embeddings in two sentences.' },
  ],
});

// content is an array of content blocks — typically one text block for a simple response.
const text = res.content
  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
  .map((b) => b.text)
  .join('');

console.log(text);
console.log(res.usage); // { input_tokens, output_tokens }
console.log(res.stop_reason); // 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
```

`createMessage` is an alias for `messages`.

### System prompt

Anthropic's system is a top-level field, not a message role:

```typescript
const res = await client.anthropic.messages({
  model: 'llama3.2',
  max_tokens: 512,
  system: 'You are a concise technical writer.',
  messages: [
    { role: 'user', content: 'Summarize REST in two sentences.' },
  ],
});
```

`system` accepts a string or an array of `{ type: 'text', text: string, cache_control?: ... }` blocks. The SDK strips `cache_control` (a hosted-Anthropic feature) before sending — Ollama doesn't honor it.

## Streaming

`AnthropicMessagesStream` yields the standard Anthropic SSE event types and reconstructs the final `AnthropicMessagesResponse`:

```typescript
const stream = await client.anthropic.messages({
  model: 'llama3.2',
  max_tokens: 512,
  messages: [{ role: 'user', content: 'Tell me a story.' }],
  stream: true,
});

for await (const event of stream) {
  switch (event.type) {
    case 'message_start':
      console.log('Started:', event.message.id);
      break;
    case 'content_block_start':
      console.log(`Block ${event.index}: ${event.content_block.type}`);
      break;
    case 'content_block_delta':
      if (event.delta.type === 'text_delta') {
        process.stdout.write(event.delta.text);
      } else if (event.delta.type === 'thinking_delta') {
        process.stderr.write(`\x1b[33m${event.delta.thinking}\x1b[0m`);
      }
      break;
    case 'message_delta':
      console.log(`\nStop reason: ${event.delta.stop_reason}`);
      break;
    case 'message_stop':
      console.log('Done.');
      break;
  }
}

const final = await stream.finalResult;
console.log(`Total tokens: ${final.usage.input_tokens + final.usage.output_tokens}`);
```

## Thinking blocks

For thinking models, set `thinking` on the request to enable reasoning. Ollama maps this to the native `think` parameter:

```typescript
const res = await client.anthropic.messages({
  model: 'deepseek-r1:8b',
  max_tokens: 2048,
  thinking: { type: 'enabled', budget_tokens: 1024 },
  messages: [{ role: 'user', content: 'Solve: 17 * 23. Reason through it.' }],
});

// The response content includes thinking blocks before the text block.
for (const block of res.content) {
  if (block.type === 'thinking') {
    console.log('Reasoning:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Answer:', block.text);
  }
}
```

`thinking` accepts:

| Type         | Behavior                                                       |
| ------------ | -------------------------------------------------------------- |
| `enabled`    | Enable thinking; `budget_tokens` is accepted but not enforced. |
| `disabled`   | Disable thinking entirely.                                     |
| `adaptive`   | Let the model decide.                                          |

`display` (`'omitted'`, `'summarized'`, `'updates'`) is accepted but not honored by Ollama.

## Tool use

```typescript
const res = await client.anthropic.messages({
  model: 'qwen3',
  max_tokens: 1024,
  tools: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    },
  ],
  messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
});

// The model returns a tool_use block:
const toolUse = res.content.find((b) => b.type === 'tool_use');
if (toolUse && toolUse.type === 'tool_use') {
  console.log(`Tool: ${toolUse.name}`);
  console.log(`Args:`, toolUse.input); // { city: 'Tokyo' }
  console.log(`ID:   ${toolUse.id}`);

  // Execute the tool, then send the result back:
  const weatherResult = await getWeather(toolUse.input.city);

  const final = await client.anthropic.messages({
    model: 'qwen3',
    max_tokens: 1024,
    tools: [/* same tool definitions */],
    messages: [
      { role: 'user', content: 'What is the weather in Tokyo?' },
      { role: 'assistant', content: res.content }, // include the tool_use block
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(weatherResult),
          },
        ],
      },
    ],
  });

  console.log(final.content); // [{ type: 'text', text: 'The weather in Tokyo is...' }]
}
```

`tool_choice` is typed on the request for compatibility but ignored by Ollama's compat layer — every tool given to the model remains callable.

## Multimodal input

```typescript
const res = await client.anthropic.messages({
  model: 'llava',
  max_tokens: 512,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAA...',
          },
        },
      ],
    },
  ],
});
```

Image content blocks use Anthropic's `source: { type: 'base64', media_type, data }` shape — Ollama maps this to its native `images` field.

## What's supported vs. ignored

The bridge types every standard Anthropic field, but Ollama's compat layer doesn't honor all of them:

| Field                | Supported by Ollama? | Notes                                                                |
| -------------------- | -------------------- | -------------------------------------------------------------------- |
| `system`             | ✅ Yes                | Top-level, not a message role.                                        |
| `tools`              | ✅ Yes                | Tool use works natively.                                              |
| `tool_choice`        | ⚠️ Accepted, ignored | Ollama's compat layer doesn't honor this.                            |
| `cache_control`      | ⚠️ Accepted, stripped | SDK strips it before sending; Ollama doesn't honor ephemeral caching. |
| `metadata`           | ⚠️ Accepted, ignored |                                                                        |
| `thinking`           | ✅ Yes                | `budget_tokens` accepted but not enforced.                           |
| `stop_sequences`     | ✅ Yes                |                                                                        |
| `top_p`, `top_k`, `temperature` | ✅ Yes    | Mapped to Ollama's `options`.                                         |
| `max_tokens`         | ✅ Yes                | Required by Anthropic; mapped to `num_predict`.                       |

For compile-time enforcement of the supported subset, the package exports `OllamaAnthropicMessagesRequest`. Use it when you want TypeScript to reject fields Ollama ignores.

## Strict request type

```typescript
import type { OllamaAnthropicMessagesRequest } from '@nemesis-oss/ollama-sdk';

const req: OllamaAnthropicMessagesRequest = {
  model: 'llama3.2',
  max_tokens: 512,
  messages: [{ role: 'user', content: 'Hello' }],
  // tool_choice: { type: 'auto' } — ❌ TypeScript error: Ollama doesn't honor this
};

await client.anthropic.messages(req);
```

## Failover and routing

Anthropic compat requests participate in the same [failover and routing layer](./failover) as native inference calls. The `model` field is used for `endpoints`/`models` allow-list routing, and capacity slots are held for as long as a streaming response is being consumed.

```typescript
const client = new OllamaClient({
  endpoints: [
    { name: 'local', baseUrl: 'http://localhost:11434', priority: 10 },
    { name: 'cloud', baseUrl: 'https://ollama.com', apiKey: process.env.OLLAMA_API_KEY!, priority: 5 },
  ],
});

// Routed automatically — local first, cloud as fallback.
const res = await client.anthropic.messages({
  model: 'llama3.2',
  max_tokens: 512,
  messages: [{ role: 'user', content: 'Hello via Anthropic bridge' }],
});
```

## Cancellation

Pass an `AbortSignal` as the second argument:

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const res = await client.anthropic.messages(
  { model: 'llama3.2', max_tokens: 1024, messages },
  controller.signal,
);
```

Streaming responses expose `.abort()` directly:

```typescript
const stream = await client.anthropic.messages({ /* ... */, stream: true });
setTimeout(() => stream.abort(), 5_000);

try {
  for await (const event of stream) { /* ... */ }
} catch (err) {
  // OllamaAbortError
}
```

## Errors

Bridge calls throw the same `OllamaClientError` hierarchy as native calls — `OllamaAuthError` for 401/403, `OllamaRateLimitError` for 429, `OllamaServerError` for 5xx, and so on. See the [Errors reference](../api/errors).

## Next steps

- **[OpenAI Compatibility](./openai-compat)** — symmetric bridge for `/v1/chat/completions` and `/v1/responses`.
- **[Streaming](./streaming)** — full streaming surface, including Anthropic SSE adapters.
- **[Failover & Routing](./failover)** — how compat requests participate in the endpoint registry.
- **[API Reference: OllamaClient](../api/client)** — the `client.anthropic` accessor.
