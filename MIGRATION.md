# Migrating from the `openai` npm SDK

This guide maps the `openai` package's surface onto `@nemesis-oss/ollama-sdk`, for teams pointing existing OpenAI-shaped code at an Ollama server. Every mapping below has the same shape and semantics unless noted — Ollama implements OpenAI's compatibility endpoints **non-statefully** (see the statefulness notes).

## TL;DR mapping table

| `openai` npm SDK                                   | `@nemesis-oss/ollama-sdk`                                  | Notes                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `new OpenAI({ baseURL })`                          | `new OllamaClient({ baseUrl })`                            | Default `http://localhost:11434`; `OLLAMA_HOST` env is honored                                       |
| `openai.responses.create({...})`                   | `client.responses.create({...})`                           | **Recommended entry point** — dual-mode: native `/v1/responses`, auto-fallback to `/api/chat` on 404 |
| `openai.responses.stream({...})`                   | `client.responses.stream({...})`                           | Simplified `text_delta` / `thinking_delta` / `done` events                                           |
| `openai.chat.completions.create({...})`            | `client.openai.chatCompletions({...})`                     | Wire-compatible bridge                                                                               |
| `openai.chat.completions.create({ stream: true })` | `client.openai.chatCompletions({ stream: true })`          | Returns `OpenAIChatCompletionStream` with `finalResult`                                              |
| `openai.embeddings.create({...})`                  | `client.openai.embeddings({...})` or `client.embed({...})` | Native `embed` supports batch input                                                                  |
| `openai.models.list()`                             | `client.openai.listModels()` or `client.listModels()`      |                                                                                                      |
| `client.images.generate(...)`                      | `client.generate({ ..., width, height, steps })`           | Ollama's image generation rides `/api/generate`                                                      |
| `previous_response_id`, `conversation`             | **Not supported by Ollama**                                | Stateless — resend the full conversation in `input`, or use `client.session()`                       |

## Why `client.responses` and not just `client.openai.responses`?

Both exist, for different jobs:

- **`client.responses`** (the ergonomic bridge, added in v1.9.0) — a small surface with OpenAI parameter names (`input`, `instructions`, `max_output_tokens`, `reasoning_effort`), a normalized `output_text` result, and **dual-mode transport**: it prefers Ollama's native `POST /v1/responses` (server ≥ v0.13.3) and, on a 404 from older servers, transparently re-issues the request via `/api/chat` with `instructions` mapped to a system message. The result records which path served it in `transport: 'native' | 'chat-adapter'`. Use this when migrating `openai.responses.*` code.

- **`client.openai.responses()`** — the full wire-compatible bridge over the native endpoint only: raw `output[]` items, every SSE event object, strict `OllamaOpenAIResponsesRequest` typing. Use this when you need OpenAI's exact response shape and know your server has the endpoint.

## Responses API

```typescript
// openai npm SDK
const response = await openai.responses.create({
  model: 'gpt-4o',
  input: 'Write a haiku about caches.',
  instructions: 'You are a poet.',
  max_output_tokens: 200,
});

// @nemesis-oss/ollama-sdk — same shape, dual-mode transport
const response = await client.responses.create({
  model: 'llama3.1',
  input: 'Write a haiku about caches.',
  instructions: 'You are a poet.',
  max_output_tokens: 200, // maps to options.num_predict on fallback
  reasoning_effort: 'medium', // maps to reasoning.effort (native) — thinking models
  think: true, // Ollama-specific extension, works on both paths
});

console.log(response.output_text); // joined output_text blocks — no choices[] nesting
console.log(response.usage); // { input_tokens, output_tokens, total_tokens }
```

### Streaming

```typescript
// openai npm SDK emits granular response.* events
const stream = await openai.responses.stream({ model: 'gpt-4o', input: '...' });

// @nemesis-oss/ollama-sdk — simplified event union
for await (const event of client.responses.stream({ model: 'llama3.1', input: '...' })) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_delta':
      break; // reasoning trace delta (thinking models)
    case 'done':
      console.log('\nusage:', event.response.usage);
      break;
  }
}
```

### Tool calling

```typescript
const result = await client.responses.create({
  model: 'llama3.1',
  input: 'What is the weather in Pune?',
  tools: [
    {
      name: 'get_weather', // flat shape, like openai's
      description: 'Get current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ],
});

for (const call of result.tool_calls ?? []) {
  console.log(call.function.name, call.function.arguments); // arguments: parsed object
}
```

## Chat Completions

```typescript
// openai npm SDK
const completion = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
});

// @nemesis-oss/ollama-sdk — OpenAI-shaped bridge
const completion = await client.openai.chatCompletions({
  model: 'llama3.1',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(completion.choices[0]?.message.content);

// …or the ergonomic native surface
const answer = await client.chatText({
  model: 'llama3.1',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Vision

```typescript
// openai npm SDK — image_url content parts
const completion = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: "What's in this image?" },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    },
  ],
});

// @nemesis-oss/ollama-sdk — the native surface takes the same URL directly,
// plus data URIs, local file paths, and raw bytes — all auto-resolved:
const answer = await client.chatText({
  model: 'llava',
  messages: [
    {
      role: 'user',
      content: "What's in this image?",
      images: ['https://example.com/cat.png'], // or './cat.png', 'data:image/png;base64,…', Buffer
    },
  ],
});
```

## Statefulness notes

Ollama rejects OpenAI's server-side conversation state:

- `previous_response_id` — accepted but ignored (compat types only); Ollama has no response storage.
- `conversation` — same.
- Every call is independent. Two options:

```typescript
// 1. Manage history yourself — resend the full conversation each call
const messages = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Hi!' },
  { role: 'assistant', content: 'Hello!' },
  { role: 'user', content: 'What did I just say?' },
];
await client.chat({ model: 'llama3.1', messages });

// 2. Let ConversationSession manage it — KV-cache-preserving + cache stats
const session = client.session('llama3.1', 'You are terse.');
await session.send('Hi!');
const turn = await session.sendTurn('What did I just say?');
console.log(turn.cache.hitRate); // per-turn KV-cache hit rate
```

## Reasoning models

| `openai`                     | here                                                        | Notes                                                                                                                |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `reasoning_effort: 'medium'` | `reasoning_effort` on `client.responses`, or native `think` | Native `think` accepts `true`/`false`/`null`/model-defined strings — discover them with `client.capabilities(model)` |

## Error mapping

`openai` throws `APIError` subclasses; this SDK throws typed `Ollama*Error` classes (`OllamaNotFoundError` for 404, `OllamaRateLimitError` for 429, `OllamaTimeoutError`, …) — all carrying `code`, `status`, and `retryable` fields. See the README's "Error Handling" section for the full hierarchy and the failover configuration that automatically retries/re-routes retryable failures.
