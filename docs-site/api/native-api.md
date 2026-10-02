---
outline: [2, 3]
---

# NativeApi (Generated)

`NativeApi` is the generated API surface for Ollama's native domain (`/api/*` endpoints). It's produced by `npm run contract:generate` from the canonical IR at `contracts/ir/ollama.ir.json` — every method delegates to `OllamaRuntime.invoke`, which owns transport, retry, streaming, telemetry, and error handling.

::: tip Recommended for new code
`NativeApi` inherits every contract-layer guarantee (environment guards, version guards, streaming defaults) automatically from the IR. `OllamaClient` is preserved verbatim for existing callers; the two surfaces can be mixed via `client.runtime`. See [Contract-First Architecture](../guide/contract-first).
:::

## Construction

### Standalone (with `HttpClient`)

```typescript
import { HttpClient } from '@nemesis-oss/ollama-sdk';
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';
import { NativeApi } from '@nemesis-oss/ollama-sdk/generated/api';

const http = new HttpClient({ baseUrl: 'http://localhost:11434' });
const runtime = new OllamaRuntime({ http });
const api = new NativeApi(runtime);
```

### Shared with `OllamaClient` (recommended for mixed codebases)

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { NativeApi } from '@nemesis-oss/ollama-sdk/generated/api';

const client = new OllamaClient({
  endpoints: [
    { name: 'local', baseUrl: 'http://localhost:11434', priority: 10 },
    { name: 'cloud', baseUrl: 'https://ollama.com', apiKey: process.env.OLLAMA_API_KEY!, priority: 5 },
  ],
});

// The runtime shares the client's transport, failover, retry, telemetry, and middleware.
const api = new NativeApi(client.runtime);

// Or use the convenience accessor:
const api2 = client.native;
```

`client.runtime` returns a cached `OllamaRuntime` that wraps a `FailoverHttpClient` — every request goes through the client's `executeWithFailover` machinery. The runtime is cached on first call; subsequent calls return the same instance.

## `OllamaRuntime` options

```typescript
interface OllamaRuntimeOptions {
  readonly http: RuntimeHttpBackend;
  readonly cloudHttp?: RuntimeHttpBackend;     // for host-bearing operations (web search/fetch)
  readonly localMode?: boolean;                // default true; rejects cloud-mode calls for local-only ops
  readonly serverVersion?: string;             // skip the lazy /api/version fetch
  readonly enforceVersion?: 'auto' | 'strict' | 'off'; // default 'auto'
  readonly validateRequests?: boolean;         // default false; opt-in Zod request validation
  readonly validateResponses?: boolean;        // default false; opt-in Zod response validation
}
```

| Option                 | Default | Effect                                                                                                |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `http`                 | —       | The HTTP backend (a `HttpClient` or `FailoverHttpClient`).                                             |
| `cloudHttp`            | —       | Separate backend for operations declaring a non-default `host` (e.g. web search/fetch at ollama.com). |
| `localMode`            | `true`  | When `false`, operations marked `environment.cloud === false` (e.g. System One) are rejected.         |
| `serverVersion`        | —       | Skip the lazy `/api/version` fetch for version-gated operations.                                       |
| `enforceVersion`       | `'auto'` | `'auto'`: fetch version lazily. `'strict'`: fail if version can't be determined. `'off'`: skip check. |
| `validateRequests`     | `false` | Validate every request body against the IR-derived Zod schema before sending.                          |
| `validateResponses`    | `false` | Validate every response body against the IR-derived Zod schema after receiving.                        |

See [ADR 0020](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0020-runtime-zod-validation.md) for the validation design.

## Methods

Every method delegates to `runtime.invoke({ operation, body, ... })`. Streaming methods return an `AsyncGenerator<T, void, undefined>`; non-streaming methods return a `Promise<T>`.

### `chat(request)`

```typescript
chat(request: ChatRequest & { stream?: false }): Promise<ChatResponse>;
chat(request: ChatRequest & { stream: true }): Promise<AsyncGenerator<ChatResponse, void, undefined>>;
chat(request: ChatRequest): Promise<ChatResponse | AsyncGenerator<ChatResponse, void, undefined>>;
```

`POST /api/chat`. Streaming defaults to `true` when `stream` is omitted (matching Ollama's documented behavior) — pass `stream: false` explicitly for non-streaming.

```typescript
// Non-streaming
const res = await api.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: false,
});

// Streaming
const stream = await api.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});
for await (const chunk of stream) {
  console.log(chunk.message?.content);
}
```

### `generate(request)`

```typescript
generate(request: GenerateRequest & { stream?: false }): Promise<GenerateResponse>;
generate(request: GenerateRequest & { stream: true }): Promise<AsyncGenerator<GenerateResponse, void, undefined>>;
```

`POST /api/generate`. Same streaming default as `chat`.

### `embed(request)`

```typescript
embed(request: EmbedRequest): Promise<EmbedResponse>;
```

`POST /api/embed`. Non-streaming. Supports batch `input`, `truncate`, and (for some models) `dimensions`.

### `systemOne(request)`

```typescript
systemOne(request: SystemOneRequest): Promise<SystemOneResponse>;
```

`POST /v1/systemone`. Local-only; requires Ollama >= 0.35.0. The runtime enforces the version constraint automatically and rejects cloud-mode calls. Request size is checked client-side: 64 KiB without images, 32 MiB with images.

::: tip Use `client.systemOne()` for key-safe generics
`OllamaClient.systemOne<Q>(request)` wraps this method with a generic that captures your question map at compile time, giving key-safe answer access. The generated `NativeApi.systemOne` uses the base `Record<string, ...>` type from the IR. See [System One Decisions](../guide/system-one).
:::

### Model catalog

| Method                  | Endpoint                | Streaming | Description                              |
| ----------------------- | ----------------------- | --------- | ---------------------------------------- |
| `tags()`                | `GET /api/tags`         | No        | List installed models.                   |
| `show(request)`         | `POST /api/show`        | No        | Show model details + capabilities.       |
| `ps()`                  | `GET /api/ps`           | No        | List currently loaded models.            |
| `version()`             | `GET /api/version`      | No        | Server version.                          |
| `create(request)`       | `POST /api/create`      | Yes       | Create a custom model from a Modelfile.  |
| `copy(request)`         | `POST /api/copy`        | No        | Duplicate a model.                       |
| `delete(request)`       | `DELETE /api/delete`    | No        | Remove a model.                          |
| `pull(request)`         | `POST /api/pull`        | Yes       | Download a model from a registry.        |
| `push(request)`         | `POST /api/push`        | Yes       | Upload a model to a registry.            |
| `blobs(digest, options?)` | `GET /api/blobs/{digest}` | No     | Fetch a blob by digest.                  |

### Streaming model operations

`create`, `pull`, and `push` accept `stream: true` and return an `AsyncGenerator<StatusResponse>`:

```typescript
const stream = await api.pull({ model: 'qwen3:8b', stream: true });
for await (const event of stream) {
  if (event.completed && event.total) {
    const pct = Math.round((event.completed / event.total) * 100);
    process.stdout.write(`\r${event.status}: ${pct}%`);
  } else {
    process.stdout.write(`\r${event.status}`);
  }
}
```

## Generated types

Every TypeScript interface lives in `src/generated/models/<name>.ts` and has a paired Zod schema in `src/generated/models/<name>.schema.ts`. Import them via the package's `generated/models/schemas` subpath:

```typescript
import {
  ChatRequestSchema,
  ChatResponseSchema,
  SystemOneRequestSchema,
  SystemOneResponseSchema,
  // ... 36 schemas total
} from '@nemesis-oss/ollama-sdk/generated/models/schemas';

// Per-call validation
const result = ChatRequestSchema.safeParse(userInput);
if (!result.success) {
  console.error(result.error.issues);
} else {
  await api.chat(result.data);
}
```

See [Contract-First Architecture](../guide/contract-first#runtime-validation-with-generated-zod-schemas) for runtime-wide validation.

## Contract guarantees

The runtime enforces contract-layer constraints automatically — callers don't need to handle these manually:

### Environment guard

Operations marked `environment.cloud === false` (e.g. `systemOne`, `tags`, `show`, `create`, `copy`, `delete`, `pull`, `push`) are rejected at request time when `localMode === false`:

```typescript
const runtime = new OllamaRuntime({ http: cloudHttp, localMode: false });
const api = new NativeApi(runtime);

await api.chat({ /* ... */ });              // ✓ allowed
await api.systemOne({ /* ... */ });          // ✗ OllamaUnsupportedCapabilityError
```

### Version constraint

Operations with `constraints.minOllamaVersion` (currently just `systemOne` at `0.35.0`) are checked against the server's reported version. The runtime fetches `/api/version` lazily on the first version-gated call (when `enforceVersion: 'auto'`, the default) and caches the result.

With `enforceVersion: 'strict'`, the runtime throws `OllamaServerVersionUnknownError` if it can't fetch the version (e.g. `/api/version` is unreachable). With `enforceVersion: 'off'`, the version check is skipped entirely.

### Request size guard

Operations with `constraints.maxRequestBytes` are checked client-side **before** any network call. `systemOne` declares 64 KiB (without images) / 32 MiB (with images) — exceeding it throws `OllamaRequestTooLargeError` with `actualBytes` and `maxBytes` fields.

### Streaming defaults

Operations whose IR declares `streamingDefault: true` (currently `chat`, `generate`, `create`, `pull`, `push`) stream when `stream` is omitted from the request. The runtime applies the default automatically; pass `stream: false` explicitly for non-streaming.

## Failover integration

When constructed via `client.runtime`, the runtime uses a `FailoverHttpClient` that routes every request through the parent client's `executeWithFailover` machinery — including multi-endpoint priority routing, circuit breakers, least-connections, and per-endpoint `models` allow-lists.

```typescript
const client = new OllamaClient({
  endpoints: [
    { name: 'local', baseUrl: 'http://localhost:11434', priority: 10 },
    { name: 'cloud', baseUrl: 'https://ollama.com', apiKey: process.env.OLLAMA_API_KEY!, priority: 5 },
  ],
});

const api = new NativeApi(client.runtime);

// Falls over from local to cloud automatically if local is unreachable:
const res = await api.chat({ model: 'qwen3:8b', messages, stream: false });
```

Standalone construction (with a plain `HttpClient`) doesn't fail over — only same-endpoint retry via `withRetry` applies.

## Generated MCP tools

The IR also produces 21 MCP tool descriptors at `src/generated/mcp/tools.json`. The runtime adapter at `@nemesis-oss/ollama-sdk/mcp/generated` exposes them as a callable tool registry — letting any MCP-compatible host drive an Ollama server without writing tool glue:

```typescript
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';
import { HttpClient } from '@nemesis-oss/ollama-sdk';
import {
  listGeneratedOllamaTools,
  callGeneratedOllamaTool,
} from '@nemesis-oss/ollama-sdk/mcp/generated';

const http = new HttpClient({ baseUrl: 'http://localhost:11434' });
const runtime = new OllamaRuntime({ http });

const tools = listGeneratedOllamaTools();
// [{ name: 'ollama_chat', inputSchema: {...}, annotations: {...} }, ...]

const result = await callGeneratedOllamaTool(runtime, 'ollama_version', {});
console.log(result.structuredContent); // { version: '0.5.0' }
```

See [MCP Integration](../guide/mcp#generated-mcp-tools-ollama-api-as-mcp) for the full surface.

## Other generated API classes

The IR also generates API classes for the OpenAI and Anthropic compatibility domains:

- `OpenAIApi` — `src/generated/api/openai-api.ts` (delegates to `/v1/*` endpoints)
- `AnthropicApi` — `src/generated/api/anthropic-api.ts` (delegates to `/v1/messages`)

These are lower-level than the `OpenAICompatClient` / `AnthropicCompatClient` exposed on `OllamaClient` — they're useful when you want the contract-driven types and runtime enforcement without the bridge conveniences.

## ADR references

- **[ADR 0013: Contract-First Hybrid Architecture](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0013-contract-first-architecture.md)** — why a single canonical IR.
- **[ADR 0014: Generated Surface and Runtime Seam](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0014-generated-surface-and-runtime-seam.md)** — the `OllamaRuntime` design.
- **[ADR 0018: Runtime Unification](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0018-runtime-unification.md)** — the `OllamaClient.runtime` bridge.
- **[ADR 0019: Zod Schema Generation](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0019-zod-schema-generation.md)** — paired Zod schemas.
- **[ADR 0020: Runtime Zod Validation](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0020-runtime-zod-validation.md)** — opt-in request/response validation.

## Next steps

- **[OllamaClient](./client)** — the hand-written surface (preserved verbatim).
- **[Decision Helpers](./decision)** — `client.decision.choice/noul/score/route/verify/rank`.
- **[Contract-First Architecture](../guide/contract-first)** — the full pipeline.
- **[MCP Integration](../guide/mcp)** — generated MCP tools and the `McpBridge`.
