---
outline: [2, 3]
---

# Failover & Routing

The SDK ships a production-grade multi-endpoint routing layer — priority routing, circuit breakers, active health checks, per-endpoint model allow-lists, and three load-balancing strategies (`priority`, `round-robin`, `least-connections`). It's the foundation for high-availability inference against a fleet of Ollama servers or a pool of Ollama Cloud accounts.

## Single endpoint

If you only need to talk to one Ollama instance, pass `baseUrl` (or rely on `OLLAMA_HOST`):

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient({
  baseUrl: 'http://localhost:11434',
  apiKey: process.env.OLLAMA_API_KEY, // optional, for Ollama Cloud
  timeoutMs: 30_000,
  retries: 3,
});
```

The client always builds an `EndpointRegistry` under the hood — even with a single endpoint, you still get retries, circuit-breaker state tracking, and timeout enforcement.

## Multi-endpoint failover

Pass an `endpoints` array to enable priority-based failover:

```typescript
const client = new OllamaClient({
  endpoints: [
    { name: 'local-gpu', baseUrl: 'http://localhost:11434', priority: 10 },
    { name: 'cloud-replica', baseUrl: 'https://ollama.example.com', apiKey: 'secret', priority: 5 },
    { name: 'cloud-backup', baseUrl: 'https://ollama-backup.example.com', apiKey: 'secret', priority: 1 },
  ],
  timeoutMs: 30_000,
  retries: 3,
});
```

Behavior:

1. **Candidates are tried in priority order** (higher number first). Within the same priority, registration order.
2. **Circuit breaker** — after `failureThreshold` (default 3) failures, the endpoint enters a `cooldownMs` (default 30s) cooling-down state and is skipped.
3. **Failover codes** — by default, `network_error`, `timeout`, `server_error`, `rate_limited`, `auth_error`, and `unsupported_capability` trigger failover. Configure with `failoverOn`.
4. **Same-endpoint retry** — within an endpoint, `withRetry` applies the retry budget (exponential backoff + jitter) before failover.
5. **All endpoints cooling down** — candidates are sorted soonest-to-recover and the soonest one is tried anyway, rather than throwing "circuit open".

### Active health checks

```typescript
const health = await client.healthCheck();
console.table(health);
// [{ endpoint, healthy, status, latencyMs }, ...]

const status = client.endpointStatus();
console.table(status);
// [{ endpoint, failureCount, lastFailureTimestamp, isCoolingDown, activeRequests }]
```

`healthCheck()` issues a real HTTP probe to each endpoint's `/api/version`. `endpointStatus()` returns the registry's cached circuit-breaker state without making any requests — useful for dashboards.

## Model-scoped endpoints (per-model API keys)

A common Ollama Cloud shape: several API keys, each unlocking a different set of models. Give each endpoint a `models` allow-list and the client resolves the right credential from the requested model — cross-endpoint failover only considers endpoints actually authorized for that model:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  endpoints: [
    {
      name: 'gpt-oss-key',
      apiKey: process.env.OLLAMA_KEY_1!,
      baseUrl: 'https://ollama.com',
      models: ['gpt-oss:120b'],
    },
    {
      name: 'minimax-key',
      apiKey: process.env.OLLAMA_KEY_2!,
      baseUrl: 'https://ollama.com',
      models: ['minimax-m3'],
    },
    {
      name: 'nemotron-key',
      apiKey: process.env.OLLAMA_KEY_3!,
      baseUrl: 'https://ollama.com',
      models: ['nemotron-3-super'],
    },
  ],
});

// Routed to KEY_1 automatically:
await client.chat({ model: 'gpt-oss:120b', messages });

// Routed to KEY_2 automatically:
await client.chat({ model: 'minimax-m3', messages });

// Throws OllamaModelRoutingError — no endpoint is authorized:
// await client.chat({ model: 'some-unconfigured-model', messages });
```

Requesting a model that no endpoint is scoped to throws `OllamaModelRoutingError` immediately — no network call, no probing every key to see which one happens to work. Two or more endpoints can share the same model in their `models` list to get ordinary failover between multiple keys for that one model.

### `credentials` + `modelBindings` (map-based sugar)

An equivalent, map-based way to write the same config:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    supervisor: { apiKey: process.env.OLLAMA_KEY_1! },
    coder: { apiKey: process.env.OLLAMA_KEY_2! },
    researcher: { apiKey: process.env.OLLAMA_KEY_3! },
  },
  modelBindings: {
    'gpt-oss:120b': 'supervisor',
    'minimax-m3': 'coder',
    'nemotron-3-super': 'researcher',
    // A model can be bound to several credentials — failover applies between them:
    // 'gpt-oss:120b': ['supervisor', 'supervisor-backup'],
  },
  // Optional: serves any model with no explicit binding, at lower priority than an explicit one.
  // defaultCredential: 'supervisor',
});
```

`modelBindings` referencing an unknown credential id throws at construction — a typo fails loudly, not by silently routing nowhere.

## Load balancing strategies

### `priority` (default)

Same-priority candidates are tried in registration order every time. The first healthy candidate always wins; the rest are fallbacks. Best when candidates are _not_ interchangeable (e.g. a hot primary and a cold DR replica).

### `round-robin`

Same-priority candidates are rotated by one position per request — `key1, key2, key3, key1, key2, key3, ...` — so consecutive requests spread across the pool instead of always preferring the first. Failover still applies if the rotated-to-front candidate fails.

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    key1: { apiKey: process.env.OLLAMA_KEY_1! },
    key2: { apiKey: process.env.OLLAMA_KEY_2! },
    key3: { apiKey: process.env.OLLAMA_KEY_3! },
  },
  endpointHealth: { strategy: 'round-robin' },
});
```

Best for a pool of interchangeable credentials where you want even load distribution but don't care about concurrency limits.

### `least-connections`

Each request is routed to whichever candidate currently has the **fewest requests in flight**. Deterministic — not probabilistic — because the candidate is chosen and marked in-flight synchronously with no `await` in between, so JS's single-threaded execution means no two concurrent calls can observe the same "0 active" snapshot.

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    account1: { apiKey: process.env.OLLAMA_KEY_1! },
    account2: { apiKey: process.env.OLLAMA_KEY_2! },
    account3: { apiKey: process.env.OLLAMA_KEY_3! },
  },
  endpointHealth: { strategy: 'least-connections' },
});

// Each lands on a different account — none has to wait on another's in-flight request.
const [a, b, c] = await Promise.all([
  client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'A' }] }),
  client.chat({ model: 'qwen2.5', messages: [{ role: 'user', content: 'B' }] }),
  client.chat({ model: 'mistral', messages: [{ role: 'user', content: 'C' }] }),
]);
```

::: tip Why least-connections matters for Ollama Cloud free tier
Ollama Cloud's free tier caps each account at **1 concurrent request**. With round-robin, two concurrent calls could both land on the same account, with one immediately getting a 429. Least-connections deterministically spreads concurrent calls across accounts — `N` concurrent calls against `N` accounts always land on `N` distinct ones.
:::

## Queueing past capacity

`least-connections` alone only guarantees no collision for up to `N` simultaneous calls against `N` candidates — an `(N+1)`th concurrent call would be routed to whichever account looks least busy at that instant, which means sending it to an account already at its real limit. Add `maxConcurrentPerEndpoint` to cap that exactly and queue instead:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    account1: { apiKey: process.env.OLLAMA_KEY_1! },
    account2: { apiKey: process.env.OLLAMA_KEY_2! },
  },
  endpointHealth: { strategy: 'least-connections', maxConcurrentPerEndpoint: 1 },
});

// With 2 accounts capped at 1 request each: the first two calls run immediately,
// one per account; the third waits until either finishes, then takes that freed slot.
const [a, b, c] = await Promise.all([
  client.chat({ model: 'm1', messages: [{ role: 'user', content: 'A' }] }),
  client.chat({ model: 'm2', messages: [{ role: 'user', content: 'B' }] }),
  client.chat({ model: 'm3', messages: [{ role: 'user', content: 'C' }] }),
]);
```

Waiting is bounded by the same `timeoutMs`/`AbortSignal` as the rest of the request — a queued call that times out or is cancelled is removed from the queue without ever being sent. Queue wake order is best-effort FIFO; the exact cap, not fairness, is the guarantee.

## Streaming and the slot lifecycle

Two details matter for the concurrency accounting to reflect reality rather than just the initial HTTP round trip:

- **Streaming (`chatStream`/`generateStream`) holds the slot for as long as the stream is actually being consumed**, not just until the response headers arrive. The promise `chatStream` returns resolves as soon as the stream object exists; the slot releases only once the stream is fully drained, errors, or is aborted. A returned stream that's never iterated holds its slot indefinitely — always consume or `stream.abort()` a stream you no longer need.
- **`Agent`'s tool-execution phase never holds a slot.** Each turn's `chat()` call acquires and releases its own slot independently; tool execution happens entirely between turns, outside any `chat()` call, so a slow tool never ties up one of your scarce concurrent-request accounts.

## What fails over — and what doesn't

Failover applies to **inference calls** — `chat`, `generate`, `embed`, `embeddings`, `webSearch`, `webFetch` — because a different endpoint serving the same model is a genuine substitute.

Model/blob management (`listModels`, `pullModel`, `deleteModel`, `createModel`, `copyModel`, `pushModel`, `showModel`, `ps`, `capabilities`) targets one specific endpoint's local state and **does not fail over** — retrying `deleteModel` against a different server doesn't retry the same operation, it silently acts on a different model catalog. See [ADR 0008](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0008-endpoint-failover-scope.md) for the rationale.

| Operation kind                          | Fails over? | Reason                                                |
| --------------------------------------- | ----------- | ----------------------------------------------------- |
| Inference (`chat`, `generate`, `embed`) | Yes         | Same model on a different endpoint is a substitute.   |
| Web tools (`webSearch`, `webFetch`)     | No          | Single fixed cloud host (`https://ollama.com`).        |
| Model catalog (`listModels`, `showModel`) | No        | Each endpoint has its own catalog.                     |
| Blob store (`createBlob`, `checkBlob`)  | No          | Each endpoint has its own blob store.                  |
| `capabilities`                          | No          | Reads `/api/show` on a specific endpoint.              |

## Tuning the circuit breaker

```typescript
const client = new OllamaClient({
  endpoints,
  endpointHealth: {
    failureThreshold: 5, // open the circuit after 5 failures (default 3)
    cooldownMs: 60_000,  // try again after 60s (default 30s)
    strategy: 'least-connections',
    maxConcurrentPerEndpoint: 1,
  },
  failoverOn: ['network_error', 'timeout', 'server_error', 'rate_limited', 'auth_error', 'unsupported_capability'],
});
```

## Failure visibility

```typescript
import { OllamaClientError, OllamaNetworkError, OllamaServerError, OllamaRateLimitError } from '@nemesis-oss/ollama-sdk';

try {
  await client.chat({ model: 'qwen3:8b', messages });
} catch (err) {
  if (err instanceof OllamaRateLimitError) {
    console.warn(`429 from last endpoint; retry after ${err.retryAfterMs}ms`);
  } else if (err instanceof OllamaNetworkError) {
    console.error('All endpoints unreachable');
  } else if (err instanceof OllamaServerError) {
    console.error(`Server ${err.status}: ${err.message}`);
  } else if (err instanceof OllamaClientError) {
    console.error(`[${err.code}] ${err.message}`, { retryable: err.retryable });
  }
}
```

Every failure carries a structured `code` (`network_error`, `timeout`, `server_error`, `rate_limited`, `auth_error`, `not_found`, `aborted`, `unsupported_capability`, `model_routing_error`, etc.) — see the [Errors reference](../api/errors) for the complete hierarchy.

## OpenTelemetry integration

Every endpoint attempt emits an `ollama.endpoint.attempt` span with `ollama.endpoint.name` and `ollama.endpoint.attempt` attributes, so you can see exactly which endpoint served each request — and which candidates were tried and failed before the successful one. See [ADR 0005](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0005-opentelemetry-instrumentation.md) for the full span taxonomy.

## Worked example: 3-account Ollama Cloud free-tier pool

```typescript
import { OllamaClient, OllamaRateLimitError } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    account1: { apiKey: process.env.OLLAMA_KEY_1! },
    account2: { apiKey: process.env.OLLAMA_KEY_2! },
    account3: { apiKey: process.env.OLLAMA_KEY_3! },
  },
  endpointHealth: {
    strategy: 'least-connections',
    maxConcurrentPerEndpoint: 1, // free-tier cap
    cooldownMs: 5 * 60 * 1000,   // cool a 429'd account for 5 minutes
  },
  retries: 1, // one same-endpoint retry, then failover
});

async function safeChat(prompt: string) {
  try {
    return await client.chatText({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof OllamaRateLimitError) {
      // Even after failover, all 3 accounts were rate-limited.
      throw new Error('Pool exhausted — wait for the session window to reset.');
    }
    throw err;
  }
}

// Fan out 3 concurrent calls — each lands on a different account:
const [a, b, c] = await Promise.all([
  safeChat('Summarize article A.'),
  safeChat('Summarize article B.'),
  safeChat('Summarize article C.'),
]);
```

## Next steps

- **[OpenAI Compatibility](./openai-compat)** and **[Anthropic Compatibility](./anthropic-compat)** — compat bridges participate in the same routing layer.
- **[Agents & Tool Calling](./agents)** — `Agent`'s tool execution phase never holds an endpoint slot.
- **[API Reference: OllamaClient](../api/client)** — full method list, including `healthCheck` and `endpointStatus`.
- **[ADR 0001: Circuit Breaker Failure Model](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0001-circuit-breaker-failure-model.md)** and **[ADR 0008: Endpoint Failover Scope](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0008-endpoint-failover-scope.md)** — the design rationale.
