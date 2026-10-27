---
outline: [2, 3]
---

# Chat

The chat API (`POST /api/chat`) is the primary inference surface — multi-turn conversations with system prompts, tool calling, structured output, thinking tokens, vision input, and streaming. This guide covers the practical patterns you'll reach for most often.

## Basic chat

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

const response = await client.chat({
  model: 'qwen3:8b',
  messages: [
    { role: 'system', content: 'You are a precise, no-nonsense assistant.' },
    { role: 'user', content: 'Explain async/await in three sentences.' },
  ],
  stream: false,
});

console.log(response.message.content);
console.log({
  evalTokens: response.eval_count,
  promptTokens: response.prompt_eval_count,
  cachedPromptTokens: response.prompt_eval_cached_count,
  evalDurationMs: response.eval_duration,
});
```

### `chatText` shortcut

If you only need the assistant's text, `chatText` returns it directly:

```typescript
const summary = await client.chatText({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Summarize the plot of Hamlet in two sentences.' }],
});
```

## Multi-turn conversations

Ollama is stateless — keep the full message history on your side and pass it back each call:

```typescript
const history = [
  { role: 'system', content: 'You are a travel-planning assistant.' },
  { role: 'user', content: 'I have 5 days in Tokyo. Suggest an itinerary.' },
];

const first = await client.chat({ model: 'qwen3:8b', messages: history });
history.push(first.message);
history.push({ role: 'user', content: 'Replace day 3 with a day-trip to Nikko.' });

const second = await client.chat({ model: 'qwen3:8b', messages: history });
history.push(second.message);
```

::: tip KV-cache reuse
Send the same prefix on every call and Ollama returns `prompt_eval_cached_count > 0` — only the new tokens are re-evaluated. Keep `system` + early `user`/`assistant` turns in the same order on every call.
:::

## Streaming

`chatStream` returns an `OllamaStream` — both an `AsyncIterable<event>` and an EventEmitter-like API:

```typescript
const stream = await client.chatStream({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Write a haiku about TypeScript.' }],
});

for await (const event of stream) {
  switch (event.type) {
    case 'token':
      process.stdout.write(event.data.delta);
      break;
    case 'thinking':
      process.stdout.write(`\x1b[33m${event.data.delta}\x1b[0m`);
      break;
    case 'tool_call':
      console.log(
        'Tool call:',
        event.data.toolCall.function.name,
        event.data.toolCall.function.arguments,
      );
      break;
    case 'done':
      console.log('\n\nFinal:', event.data.result.message.content);
      break;
    case 'error':
      console.error('Stream error:', event.data.error);
      break;
  }
}

// Or await the aggregated result separately:
const result = await stream.finalResult;
console.log(`Tokens/sec: ${result.usage?.tokensPerSecond}`);
```

The full event surface and patterns are covered in [Streaming](./streaming).

## Thinking tokens

Reasoning models (`qwen3`, `deepseek-r1`, `gpt-oss`) expose a `think` parameter on `chat`:

| Value                               | Meaning                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `true`                              | Use the model's default thinking budget (recommended).                                         |
| `false`                             | Disable thinking entirely.                                                                     |
| `null`                              | Model default (same as omitting).                                                              |
| `'high'`/`'low'`/`'medium'`/`'max'` | Model-defined string levels — discover them with `client.capabilities(model).thinking.values`. |

```typescript
const caps = await client.capabilities('qwen3:8b');
console.log(caps.thinking); // { values: [true, false, 'low', 'medium', 'high'], default: true }

const stream = await client.chatStream({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'What is 17 * 23? Reason through it.' }],
  think: 'high',
  options: { temperature: 0 },
});

for await (const event of stream) {
  if (event.type === 'thinking') process.stdout.write(`\x1b[33m${event.data.delta}\x1b[0m`);
  else if (event.type === 'token') process.stdout.write(event.data.delta);
}
```

`think` is also surfaced on `chat` non-streaming responses as `response.message.thinking`.

## Tool calling

Register tools with `defineTool` + `ToolRegistry`, pass `tools` to `chat`, and execute the model's requested calls:

```typescript
import { OllamaClient, defineTool, ToolRegistry } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  schema: z.object({ city: z.string().describe('City name, e.g. "Tokyo"') }),
  execute: async ({ city }) => {
    // In production, call a real weather API.
    return { city, temperature: 22, condition: 'Sunny', unit: 'celsius' };
  },
});

const registry = new ToolRegistry([weatherTool]);
const client = new OllamaClient();

// First model turn — the model decides to call get_weather
const res = await client.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
  tools: registry.definitions(),
  stream: false,
});

if (res.message.tool_calls?.length) {
  // Execute the requested tool calls in parallel
  const results = await registry.executeToolCalls(res.message.tool_calls);

  // Build the next turn with the assistant's request and the tool results
  const final = await client.chat({
    model: 'qwen3:8b',
    messages: [
      { role: 'user', content: 'What is the weather in Tokyo?' },
      res.message,
      ...results.map((r) => ({
        role: 'tool' as const,
        content: r.outputString,
        tool_name: r.toolName,
      })),
    ],
    tools: registry.definitions(),
    stream: false,
  });

  console.log(final.message.content);
}
```

For autonomous multi-turn tool loops with capability preflight, hooks, and error recovery, use the [`Agent` class](./agents) — it wraps the pattern above into a single `agent.run()` call.

::: warning Synthetic tool-call IDs
Ollama's native protocol has no OpenAI-style per-call ID. The SDK synthesizes a stable client-side `id` (see [ADR 0007](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0007-synthetic-tool-call-ids.md)) so you can correlate `toolCalls[i].id` with `toolResults[i].toolCallId`. This `id` is metadata only — it isn't sent to Ollama on the wire. Native `role: 'tool'` messages use Ollama's `tool_name` field instead.
:::

## Vision / multimodal input

`Message.images` accepts base64 strings _or_ raw `Uint8Array` bytes — `Uint8Array` entries are auto-encoded:

```typescript
import { readFile } from 'node:fs/promises';

const imageBytes = await readFile('./screenshot.png');

const res = await client.chat({
  model: 'llava',
  messages: [
    {
      role: 'user',
      content: 'Describe what is in this image and identify any UI bugs.',
      images: [imageBytes], // or base64: ['iVBORw0KGgoAAAANSUhEUgAA...']
    },
  ],
  stream: false,
});
```

`generate()` accepts a top-level `images` array too — useful for prompt-only vision models.

`images` entries can also be `data:image/...;base64,` data URIs (header stripped), `http(s)://` URLs (fetched and encoded), and local file paths like `./photo.jpg` (read on Node.js) — the client normalizes every form before the request reaches the wire.

### Resource limits & trust boundaries

URL fetches, data-URI payloads, and file reads are governed by the client's `imageResolution` policy ([ADR 0041](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0041-vision-resolution-trust-boundaries.md)). The defaults are chosen so **untrusted image input fails closed** — if your app passes user- or model-controlled strings into `images`, you get safe behavior without any configuration:

| Option                                            | Default    | Effect                                                                                                    |
| ------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `maxImageBytes`                                   | 50 MiB     | Caps remote bodies **while streaming** (the download is cancelled at the cap), data-URI payloads, and file reads. Direct `Uint8Array`/`Buffer` inputs are never capped. |
| `fetchTimeoutMs`                                  | 30 000     | Timeout for the whole remote fetch — connection, redirects, and body read; aborts by the request `signal` are honored too. |
| `maxRedirects`                                    | 5          | Redirect cap for remote images; every hop is re-validated on Node (host policy + private-address guard).  |
| `allowedImageHosts`                               | any host   | Explicit allowlist: exact hostnames, `*.example.com` wildcards, or `'*'`.                                 |
| `allowPrivateNetworkAccess`                       | `false`    | **SSRF guard.** Refuses loopback/private/link-local/CGNAT/metadata addresses — including hostnames that *resolve* to them and redirect targets — unless you flip this on. |
| `allowLocalFileReads`                             | `true`     | Whether path-shaped strings may read the local filesystem at all. Set to `false` for untrusted input.    |
| `fetchImpl`                                       | client's `fetch` | Remote image fetches flow through the client's configured `fetch` (proxies, mocks, agents) by default. |

```typescript
const client = new OllamaClient({
  imageResolution: {
    // Only fetch images from hosts you actually trust:
    allowedImageHosts: ['cdn.myapp.com', 'images.example.com'],
    maxImageBytes: 10 * 1024 * 1024,
    fetchTimeoutMs: 10_000,
  },
});

// Untrusted input now fails closed with a clear error instead of
// fetching arbitrary hosts, following redirects, or buffering unbounded bytes:
await client.chat({
  model: 'llava',
  messages: [{ role: 'user', content: 'describe', images: [untrustedUrl] }],
});
```

Fetching from a genuinely internal image host? Set `allowPrivateNetworkAccess: true` — the error message tells you exactly that. Failed local file reads throw `vision_path_read_failed` with the underlying cause instead of silently shipping the path string to the server.

## Logprobs

Set `logprobs: true` (optionally with `top_logprobs`) to get per-token log probabilities — useful for confidence scoring, agent routing, or speculative decoding.

```typescript
const res = await client.chat({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Is Paris the capital of France? Answer yes or no.' }],
  logprobs: true,
  top_logprobs: 3,
  stream: false,
});

for (const entry of res.logprobs ?? []) {
  console.log(
    entry.token,
    entry.logprob,
    entry.top_logprobs?.map((t) => t.token),
  );
}
```

## Model options

Pass `options` for sampling and runtime tuning — every Ollama-supported option is typed:

```typescript
await client.chat({
  model: 'qwen3:8b',
  messages,
  options: {
    temperature: 0.7,
    top_p: 0.9,
    num_predict: 256,
    num_ctx: 32_768,
    seed: 42,
    stop: ['\n\n'],
  },
  stream: false,
});
```

Common ones:

| Option        | Default     | Effect                                                                                                                                                               |
| ------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temperature` | model       | Sampling temperature (higher = more random).                                                                                                                         |
| `top_p`       | model       | Nucleus sampling cutoff.                                                                                                                                             |
| `top_k`       | model       | Top-k token cutoff.                                                                                                                                                  |
| `num_predict` | -1 (unlim)  | Maximum tokens to generate.                                                                                                                                          |
| `num_ctx`     | VRAM-tiered | Context window size in tokens — when unset, the daemon defaults it by VRAM (4k / 32k / 256k; see the [Context length](https://docs.ollama.com/context-length) docs). |
| `seed`        | unset       | Deterministic sampling for the same prompt.                                                                                                                          |
| `stop`        | unset       | Stop sequences — generation ends when any is matched.                                                                                                                |

See the [`ModelOptions` type](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/src/types.ts) for the complete list.

## keep_alive

`keep_alive` controls how long a model stays resident in VRAM after the request returns. Pass a duration string (`"5m"`, `"30s"`) or seconds as a number; `"0"` unloads immediately:

```typescript
await client.chat({ model: 'qwen3:8b', messages, keep_alive: '10m' });

// Unload the model to free VRAM:
await client.chat({ model: 'qwen3:8b', messages: [], keep_alive: 0 });
```

## Error handling

Every failure is an `OllamaClientError` subclass. Catch the base class or narrow to a specific `code`:

```typescript
import {
  OllamaClientError,
  OllamaRateLimitError,
  OllamaNotFoundError,
} from '@nemesis-oss/ollama-sdk';

try {
  await client.chat({ model: 'nonexistent-model', messages });
} catch (err) {
  if (err instanceof OllamaNotFoundError) {
    console.error('Model not found. Run `ollama pull <name>`.');
  } else if (err instanceof OllamaRateLimitError) {
    console.warn(`Rate limited; retry after ${err.retryAfterMs}ms`);
  } else if (err instanceof OllamaClientError) {
    console.error(`[${err.code}] ${err.message}`, { retryable: err.retryable });
  } else {
    throw err; // Re-throw programming errors.
  }
}
```

See the [Errors reference](../api/errors) for the complete hierarchy.

## Next steps

- **[Streaming](./streaming)** — abort, backpressure, SSE for OpenAI/Anthropic compat, Web Stream adapters.
- **[Agents & Tool Calling](./agents)** — let the model loop until the task is done.
- **[Structured Output](./structured-output)** — get typed JSON back from `chat`.
- **[OpenAI Compatibility](./openai-compat)** — use Ollama through `/v1/chat/completions`.
