---
outline: [2, 3]
---

# Testing with the Mock Server

The SDK ships its own deterministic test double as a public subpath — `@nemesis-oss/ollama-sdk/testing`. It's the SDK's internal mock engine, **promoted not forked** (ADR 0029): the same server that CI-tests the transport, failover, and error-classification paths is available to your test suite. Zero network, zero daemon, zero GPU, fully deterministic.

```bash
npm install --save-dev @nemesis-oss/ollama-sdk
# The testing subpath ships in the same package — no second install.
```

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { createMockOllamaServer, mockTextChunks } from '@nemesis-oss/ollama-sdk/testing';

const server = createMockOllamaServer(); // ephemeral port, defaults on
await server.start();

const client = new OllamaClient({ baseUrl: server.baseUrl });

// Defaults answer out of the box: HEAD / (ping) and GET /api/version.
// Register everything else — register() always wins over the defaults.
server.register('/api/chat', { chunks: mockTextChunks('Hello!') });

const answer = await client.chatText({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'hi' }],
});

await server.stop(); // idempotent — safe in afterEach
```

The mock is a real `node:http` server on an ephemeral port — your code under test exercises the actual transport: real `fetch`, real NDJSON framing, real streaming, real headers. Only the daemon is fake.

## Route scripting

### `register(path, options)`

Registers a route that always wins over the built-in defaults. The response shape:

```typescript
interface MockRouteResponse {
  status?: number; // HTTP status, default 200
  chunks?: string[]; // NDJSON frames, emitted in order with '\n'
  chunkDelayMs?: number; // inter-chunk delay — backpressure & timeout drills
  headers?: Record<string, string>; // override content-type for non-NDJSON bodies
  dropConnectionMidStream?: boolean; // destroy the socket after the first chunk
  rawBody?: string; // exact body, no NDJSON framing (plain text, blobs)
  injectErrorFrame?: { message: string; after?: number };
}
```

`chunks: []` emits no body at all — the "stream closed without data" case. `status: 503` with a `{"error": ...}` body reproduces overload responses.

### Request-aware routes — `responder` (v1.15.0)

Static routes return the same response on every call. When the response must vary per request — fail-twice-then-succeed retry drills, body-dependent payloads, conversation arcs — pass a `responder`:

```typescript
// Fail twice, then serve — retry/backoff drills:
let hits = 0;
server.register('/api/chat', {
  chunks: mockTextChunks('recovered'),
  responder: () =>
    hits++ < 2 ? { status: 503, chunks: ['{"error":"server queue is full"}'] } : undefined, // undefined falls back to the route's static fields
});

// Body-dependent — answer differently by what the client sent:
server.register('/api/generate', {
  responder: (record) => ({
    chunks: [
      JSON.stringify({
        model: 'mock-model',
        created_at: new Date().toISOString(),
        response: record.body?.prompt === 'ping' ? 'pong' : 'unknown',
        done: true,
      }),
    ],
  }),
});
```

The `responder` receives the recorded request (method, path, body) and returns a `MockRouteResponse` — or `undefined` to fall back to the route's static fields, so stateful scenarios compose with static ones.

### In-band mid-stream error injection — `injectErrorFrame`

How a real daemon reports GPU OOM / driver crashes mid-generation: HTTP stays 200, an `{"error": "..."}` NDJSON frame arrives while the stream is running. The default injection point is `chunks.length - 1` — every content chunk, then the error frame, with the final `done` frame **never emitted** (an error frame _after_ `done` would be unread; the stream already completed cleanly). `after: 0` errors before any content:

```typescript
server.register('/api/generate', {
  chunks: mockTextChunks('partial answer', { chunkSize: 8 }),
  injectErrorFrame: { message: 'CUDA out of memory' },
});

// The SDK's stream readers raise OllamaStreamError with the partial content.
```

`dropConnectionMidStream: true` covers the transport-fault variant — the socket is destroyed mid-body, exercising reconnect/retry classification (`ECONNRESET`-style failures map to retryable `OllamaNetworkError` since v1.16.0).

## Chunk builders

Correctly-shaped `/api/chat` frames, so your mocks match the real wire format:

- **`mockTextChunks(text, { chunkSize?, model? })`** — chunked content frames + a `done` frame with cumulative usage counters (ready for `formatTelemetry`). `chunkSize: 8` splits the text into 8-char frames for streaming drills.
- **`mockToolCallChunks(specs, { model?, content? })`** — tool-call frames where **parallel tool calls complete in a single frame**, the documented native shape. Each spec is `{ id?, name, arguments }` — `arguments` accepts an object (stringified by the builder) **or a pre-encoded string**, including invalid JSON, to test the stringified-arguments hazard.
- **`mockChatChunk(overrides?)`** — one raw `/api/chat` frame with counter defaults on the done frame.

```typescript
import { createMockOllamaServer, mockToolCallChunks } from '@nemesis-oss/ollama-sdk/testing';

const server = createMockOllamaServer();
await server.start();

server.register('/api/chat', {
  chunks: mockToolCallChunks([
    { name: 'get_weather', arguments: { city: 'Tokyo' } },
    { name: 'get_weather', arguments: { city: 'Osaka' } }, // parallel, one frame
    { name: 'broken', arguments: '{not json' }, // malformed on purpose
  ]),
});
```

## Wire-level assertions

Every request is recorded — including default-route hits and 404s:

```typescript
server.register('/api/chat', { chunks: mockTextChunks('ok') });
await client.chat({ model: 'llama3.2', messages: [/* ... */] });

expect(server.requests[0]?.body).toMatchObject({ model: 'llama3.2' });
expect(server.requests[0]?.path).toBe('/api/chat');

server.clearRequests(); // between tests
server.clear(); // remove all registered routes (defaults stay)
```

Each record carries the method, path, and parsed body — assert on exactly what went over the wire, not just that a call happened.

## Liveness defaults

Out of the box the mock answers the official liveness probe — `HEAD /` → 200, `GET /` → the plain-text "Ollama is running" body byte-for-byte, `GET /api/version` with a configurable version — so `client.ping()` works against a fresh mock with zero setup. Pass `defaultRoutes: false` to `createMockOllamaServer()` for bare 404s when you want full control.

## Testing patterns

| What you're testing                          | Recipe                                                                |
| -------------------------------------------- | --------------------------------------------------------------------- |
| Retry / backoff / failover                   | `responder` failing N times with 503, then serving                    |
| Mid-stream failure recovery                  | `injectErrorFrame` (in-band) or `dropConnectionMidStream` (transport) |
| Streaming & backpressure                     | `chunkDelayMs: 10` per chunk                                          |
| Timeout / cancellation                       | `chunkDelayMs: 10_000` + an `AbortSignal`                             |
| Tool-call handling incl. malformed arguments | `mockToolCallChunks` with string `arguments`                          |
| Wire-format assertions                       | `server.requests` + `clearRequests()`                                 |
| Non-JSON endpoints (liveness, blobs)         | `rawBody` + custom `headers`                                          |

The transport-level test suite in the SDK repository (`test/`) uses exactly this server — it's the reference consumer.

## Next steps

- **[ADR 0029](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0029-public-testing-subpath-speculative-draft-conveniences.md)** — why the mock was promoted instead of forked.
- **[Failover & Routing](./failover)** — what the retry drills exercise.
- **[Streaming](./streaming)** — how the SDK surfaces injected errors (`OllamaStreamError` with partial content).
- **[Custom Models](./custom-models)** — mocking blob uploads and `/api/create`.
