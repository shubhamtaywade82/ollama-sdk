---
outline: [2, 3]
---

# OllamaClient

`OllamaClient` is the original, hand-written API surface — the easiest entry point for most users. It wraps an `EndpointRegistry`, an `HttpClient`, retry/transports, middleware, telemetry, and the OpenAI/Anthropic compatibility bridges into a single class.

::: tip Generated `NativeApi` is recommended for new code
For new code, prefer the generated [`NativeApi`](./native-api) — it inherits every contract-layer guarantee (environment guards, version guards, streaming defaults) automatically. `OllamaClient` is preserved verbatim; existing callers don't need to change anything. The two surfaces can be mixed via `client.runtime` (see [Contract-First Architecture](../guide/contract-first)).
:::

## Constructor

```typescript
new OllamaClient(config?: OllamaClientConfig)
```

### `OllamaClientConfig`

| Field                  | Type                                            | Default                              | Description                                                                  |
| ---------------------- | ----------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `baseUrl`              | `string`                                         | `OLLAMA_HOST` or `http://localhost:11434` | Single-endpoint base URL. Ignored if `endpoints` is provided.               |
| `apiKey`               | `string`                                         | `OLLAMA_API_KEY`                     | Bearer token for a single endpoint.                                          |
| `headers`              | `Record<string, string>`                        | —                                    | Static headers merged into every request.                                     |
| `endpoints`            | `readonly OllamaEndpoint[]`                     | —                                    | Multi-endpoint registry with priority routing and failover.                  |
| `credentials`          | `Record<string, OllamaCredentialConfig>`        | —                                    | Map-based alternative to `endpoints` for multi-key Ollama Cloud setups.      |
| `modelBindings`        | `Record<string, string \| readonly string[]>`   | —                                    | Maps model names to credential ids. Requires `credentials`.                  |
| `defaultCredential`    | `string`                                         | —                                    | Fallback credential id for models with no `modelBindings` entry.             |
| `endpointHealth`       | `EndpointRegistryOptions`                       | —                                    | Circuit-breaker tuning, load-balancing strategy, concurrency caps.           |
| `failoverOn`           | `readonly string[]`                             | `DEFAULT_FAILOVER_CODES`             | Error codes that trigger failover to the next candidate.                     |
| `timeoutMs`            | `number`                                         | `30_000`                             | Default per-request timeout in milliseconds.                                 |
| `retries`              | `number \| Partial<RetryConfig>`                | `DEFAULT_RETRY_CONFIG`               | Retry count or full retry config.                                            |
| `fetch`                | `FetchLike`                                      | `globalThis.fetch`                   | Custom fetch implementation (for testing or non-standard runtimes).          |
| `middleware`           | `readonly Middleware[]`                         | —                                    | Request/response middleware pipeline.                                        |
| `logger`               | `Logger`                                         | `NOOP_LOGGER`                        | Structured logger.                                                           |
| `debug`                | `boolean`                                        | `false`                              | Enables the console debug logger if `logger` is not set.                     |
| `onLifecycleEvent`     | `RequestLifecycleHook`                          | —                                    | Telemetry hook for request start/success/retry/error events.                 |

See [Failover & Routing](../guide/failover) for the full multi-endpoint patterns.

## Chat

### `chat(req)`

```typescript
chat(req: ChatRequestOptions & { stream: true }): Promise<OllamaStream<ChatResponse, ChatStreamResult>>;
chat(req: ChatRequestOptions & { stream?: false | undefined }): Promise<ChatResponse>;
chat(req: ChatRequestOptions): Promise<ChatResponse | OllamaStream<ChatResponse, ChatStreamResult>>;
```

The streaming variant is selected by `stream: true`. See [Chat](../guide/chat) for the full guide.

```typescript
const res = await client.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: false,
});

const stream = await client.chat({ /* same */, stream: true });
for await (const event of stream) { /* ... */ }
```

### `chatStream(req)`

```typescript
chatStream(req: Omit<ChatRequestOptions, 'stream'>): Promise<OllamaStream<ChatResponse, ChatStreamResult>>;
```

Shortcut for `chat({ ...req, stream: true })`.

### `chatText(req)`

```typescript
chatText(req: Omit<ChatRequestOptions, 'stream'>): Promise<string>;
```

Returns just the assistant's text content — equivalent to `(await client.chat({ ...req, stream: false })).message.content`.

### `chatWithSchema(req, schema)`

```typescript
chatWithSchema<T>(req: Omit<ChatRequestOptions, 'stream' | 'format'>, schema: z.ZodType<T>): Promise<T>;
```

Calls `chat` with `format: zodToJsonSchema(schema)` and parses the response with `parseStructuredOutput`. See [Structured Output](../guide/structured-output).

## Generate

### `generate(req)`

```typescript
generate(req: GenerateRequestOptions & { stream: true }): Promise<OllamaStream<GenerateResponse, GenerateStreamResult>>;
generate(req: GenerateRequestOptions & { stream?: false | undefined }): Promise<GenerateResponse>;
generate(req: GenerateRequestOptions): Promise<GenerateResponse | OllamaStream<GenerateResponse, GenerateStreamResult>>;
```

See [Generate](../guide/generate) for the full guide.

### `generateStream(req)`, `generateText(req)`, `generateWithSchema(req, schema)`

Symmetric to their `chat*` counterparts.

## Embeddings

### `embed(req)`

```typescript
embed(req: EmbedRequestOptions): Promise<EmbedResponse>;
```

Targets the modern `/api/embed` endpoint — supports batch `input`, `truncate`, and (for some models) `dimensions`.

### `embedText(model, input)`

```typescript
embedText(model: string, input: string | readonly string[]): Promise<readonly (readonly number[])[]>;
```

Returns just the embedding vectors.

### `embeddings(req)` (deprecated)

```typescript
embeddings(req: EmbeddingsRequestOptions): Promise<EmbeddingsResponse>;
```

Legacy single-prompt endpoint. New code should use `embed()` — see [Embeddings](../guide/embed).

## Model lifecycle

All model operations delegate to `ModelsClient` and target one specific endpoint's local state — they do **not** cross-endpoint fail over (see [ADR 0008](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0008-endpoint-failover-scope.md)).

| Method                          | Signature                                                                  | Description                                |
| ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| `listModels()`                  | `() => Promise<ListResponse>`                                              | `GET /api/tags` — all installed models.    |
| `showModel(req)`                | `(req: ShowRequestOptions) => Promise<ShowResponse>`                       | `POST /api/show` — model details + caps.   |
| `pullModel(r)`                  | `(r: PullRequestOptions) => Promise<ProgressResponse \| ...>`              | `POST /api/pull` — download a model.       |
| `pushModel(r)`                  | `(r: PushRequestOptions) => Promise<ProgressResponse \| ...>`              | `POST /api/push` — upload a model.         |
| `createModel(r)`                | `(r: CreateRequestOptions) => Promise<StatusResponse \| ...>`              | `POST /api/create` — build a custom model. |
| `deleteModel(req)`              | `(req: DeleteRequestOptions) => Promise<void>`                             | `DELETE /api/delete` — remove a model.     |
| `copyModel(req)`                | `(req: CopyRequestOptions) => Promise<void>`                               | `POST /api/copy` — duplicate a model.      |
| `ps()`                          | `() => Promise<PsResponse>`                                                | `GET /api/ps` — currently loaded models.   |
| `version()`                     | `() => Promise<VersionResponse>`                                           | `GET /api/version`.                        |
| `createBlob(digest, data)`      | `(digest: string, data: BinaryBody) => Promise<void>`                      | `POST /api/blobs/<digest>` — upload a blob.|
| `checkBlob(digest)`             | `(digest: string) => Promise<boolean>`                                     | `HEAD /api/blobs/<digest>` — check existence. |

`pullModel`, `pushModel`, and `createModel` stream when `stream: true` is passed — they yield `ProgressResponse` events with `status`, `completed`, and `total` fields.

## System One

### `systemOne(request)`

```typescript
systemOne<Q extends SystemOneQuestions = SystemOneQuestions>(
  request: SystemOneRequest<Q>,
): Promise<SystemOneResponse<Q>>;
```

Ollama's System One decision layer (`POST /v1/systemone`). Local-only; requires Ollama >= 0.35.0. The generic `Q` captures the caller's question map at compile time, giving key-safe answer access. See [System One Decisions](../guide/system-one).

### `decision` (accessor)

```typescript
get decision(): Decision;
```

Higher-level ergonomic helpers — `choice`, `noul`, `score`, `route`, `verify`, `rank`. See [Decision Helpers](./decision).

## Web tools (Ollama Cloud)

### `webSearch(req)`, `webFetch(req)`

```typescript
webSearch(req: WebSearchRequestOptions): Promise<WebSearchResponse>;
webFetch(req: WebFetchRequestOptions): Promise<WebFetchResponse>;
```

Wrap Ollama's hosted web tools at `https://ollama.com/api/web_search` and `/api/web_fetch`. Require an Ollama account API key (`apiKey` on the client or `OLLAMA_API_KEY`). They don't participate in multi-endpoint failover — there's only ever the one cloud host to call.

## Capabilities and health

### `capabilities(model, signal?)`

```typescript
capabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities>;
```

Queries `/api/show` and returns normalized capability flags (`supportsTools`, `supportsThinking`, `supportsStructuredOutputRequest`, `contextLength`, etc.). Single-endpoint — doesn't fail over.

### `runtimeMode()`

```typescript
runtimeMode(): 'local' | 'cloud';
```

Returns whether the first candidate endpoint is inferred as local or cloud. Used by `assertStructuredOutputSupported` to reject `format` requests against Ollama Cloud.

### `healthCheck()`

```typescript
healthCheck(): Promise<EndpointHealthCheckResult[]>;
```

Issues an active HTTP probe (`GET /api/version`) to each configured endpoint. Returns one result per endpoint with `healthy`, `status`, and `latencyMs`.

### `endpointStatus()`

```typescript
endpointStatus(): EndpointHealth[];
```

Returns the registry's cached circuit-breaker state without making any requests. Useful for dashboards.

## Compatibility bridges

### `openai` (accessor)

```typescript
get openai(): OpenAICompatClient;
```

A typed pass-through to Ollama's `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`, and `/v1/responses` endpoints. See [OpenAI Compatibility](../guide/openai-compat).

### `anthropic` (accessor)

```typescript
get anthropic(): AnthropicCompatClient;
```

A typed pass-through to Ollama's `/v1/messages` endpoint. See [Anthropic Compatibility](../guide/anthropic-compat).

## Generated surface bridges

### `runtime` (accessor)

```typescript
get runtime(): OllamaRuntime;
```

A cached `OllamaRuntime` that shares this client's transport (HttpClient + middleware + retry + telemetry + failover). Lets callers mix the existing `OllamaClient` API with the generated `NativeApi` / `OpenAIApi` / `AnthropicApi` surface without configuring two HttpClient instances. See [Contract-First Architecture](../guide/contract-first).

### `native` (accessor)

```typescript
get native(): NativeApi;
```

Lazily-constructed `NativeApi` bound to this client's runtime. Exposes the full generated native API surface (`chat`, `generate`, `embed`, `systemOne`, etc.) with contract-driven types and runtime enforcement. `systemOne()` delegates to this accessor.

## Registry

### `registry`

```typescript
readonly registry: EndpointRegistry;
```

The underlying multi-endpoint registry. Useful for advanced cases — direct candidate inspection, manual `acquire`/`release` for custom concurrency control, etc. Most callers don't need to touch this directly.

### `models` / `modelsClient`

```typescript
readonly models: ModelsClient;
get modelsClient(): ModelsClient;
```

The `ModelsClient` that backs `listModels`/`showModel`/etc. Exposed for advanced cases — most callers use the `client.listModels()` shorthand instead.

## Types

### `ChatRequestOptions`

```typescript
interface ChatRequestOptions extends RequestCancellationOptions {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly format?: FormatOption;            // 'json' | Record<string, unknown> (JSON Schema)
  readonly options?: ModelOptions;
  readonly stream?: boolean;
  readonly keep_alive?: string | number;
  readonly think?: ThinkValue;               // boolean | string | null
  readonly width?: number;                   // experimental image generation
  readonly height?: number;
  readonly steps?: number;
  readonly logprobs?: boolean;
  readonly top_logprobs?: number;
}
```

### `Message`

```typescript
interface Message {
  readonly role: 'system' | 'user' | 'assistant' | 'tool' | 'thought';
  readonly content: string;
  readonly images?: readonly (string | Uint8Array)[]; // base64 or raw bytes (auto-encoded)
  readonly tool_calls?: readonly ToolCall[];
  readonly tool_name?: string;             // for role: 'tool' — which tool produced this
  readonly tool_call_id?: string;          // SDK-local metadata, not sent on the wire
  readonly thinking?: string;              // reasoning content from a thinking model
}
```

### `RequestCancellationOptions`

```typescript
interface RequestCancellationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
```

Both `signal` and `timeoutMs` are honored on every method that accepts `RequestCancellationOptions` (chat, generate, embed, systemOne, web tools, etc.). The timeout is implemented as an `AbortSignal.timeout` that's combined with your `signal` via `AbortSignal.any`.

## Examples

### Streaming chat with thinking tokens

```typescript
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

### Multi-endpoint with least-connections

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    account1: { apiKey: process.env.OLLAMA_KEY_1! },
    account2: { apiKey: process.env.OLLAMA_KEY_2! },
    account3: { apiKey: process.env.OLLAMA_KEY_3! },
  },
  endpointHealth: { strategy: 'least-connections', maxConcurrentPerEndpoint: 1 },
});

const [a, b, c] = await Promise.all([
  client.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'A' }] }),
  client.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'B' }] }),
  client.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'C' }] }),
]);
```

### Mixing legacy and generated surfaces

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { NativeApi } from '@nemesis-oss/ollama-sdk/generated/api';

const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });

// Legacy:
const a = await client.chat({ model: 'qwen3:8b', messages });

// Generated (shares transport):
const api = new NativeApi(client.runtime);
const b = await api.chat({ model: 'qwen3:8b', messages, stream: false });
```

## Next steps

- **[Generated NativeApi](./native-api)** — the recommended surface for new code.
- **[Decision Helpers](./decision)** — `client.decision.choice/noul/score/route/verify/rank`.
- **[Errors](./errors)** — the structured error hierarchy.
- **[Guide: Chat](../guide/chat)**, **[Generate](../guide/generate)**, **[Embed](../guide/embed)**, **[Streaming](../guide/streaming)**, **[Failover](../guide/failover)** — practical guides for each surface.
