# ADR 0018: Runtime Unification — OllamaClient → OllamaRuntime Bridge

## Status

Accepted

## Context

ADR 0014 (Wave 3) introduced the generated `OllamaRuntime` seam and the
`NativeApi` / `OpenAIApi` / `AnthropicApi` API classes. ADR 0016 (Wave 6)
added MCP tool generation that uses the runtime.

Until Wave 8, the runtime and the hand-written `OllamaClient` were two
separate code paths: each constructed its own `HttpClient`, configured its
own middleware/retry/telemetry, and had no shared state. Users wanting to
mix the two surfaces had to manage two HttpClient instances and keep their
configurations in sync manually.

This is the same kind of drift Waves 1-7 fixed elsewhere — parallel
surfaces maintained separately.

## Decision

Add a non-breaking bridge: `OllamaClient.runtime` returns an `OllamaRuntime`
backed by the same transport (HttpClient + middleware + retry + telemetry)
as the host `OllamaClient`.

### `client.runtime` accessor

The new accessor:

1. Lazily constructs a `FailoverHttpClient` that routes each request
   through `OllamaClient.executeWithFailover` — the generated surface
   now participates in full multi-endpoint failover (Wave 14).
2. Wraps that HttpClient in an `OllamaRuntime`, configured with
   `localMode` inferred from the first endpoint's baseUrl (same logic
   as `inferRuntimeMode`).
3. Also provides a `cloudHttp` backend for host-bearing operations
   (web search, web fetch) that target `https://ollama.com` (Wave 15).
4. Caches the runtime — subsequent `client.runtime` calls return the same
   instance.
5. Inherits `fetch`, `middleware`, `onLifecycleEvent` from the host
   `OllamaClient`.

### Multi-endpoint failover (Wave 14 update)

The generated surface now supports multi-endpoint failover via
`FailoverHttpClient`. Each request is routed through
`executeWithFailover`, which picks the best healthy endpoint, applies
retry/backoff, and fails over on retryable errors — matching the
behavior of the hand-written `OllamaClient` methods.

Model-aware routing is also supported (Wave 15): the runtime extracts
the `model` field from the request body and passes it to the failover
layer for endpoint filtering by `OllamaEndpoint.models`.

### Deprecation notice on `OllamaClient`

`OllamaClient` carries a Wave 8 deprecation notice in its JSDoc pointing
users to the generated `NativeApi` for new code. The class itself is
preserved verbatim — no method signature changes, no behavior changes.
Existing callers do not need to do anything. The notice exists to set
expectations: new operations will land on the generated surface first,
and `OllamaClient` will receive them only as a follow-up.

### Why non-breaking

A hard migration — replacing `OllamaClient.chat()` with `NativeApi.chat()` —
would require every consumer to update call sites, including the
agent/MCP/tooling layers that consume `OllamaClient` today. That's a
multi-PR effort that would block Wave 8 indefinitely. The bridge approach
gets the architectural seam in place now and lets individual consumers
migrate at their own pace.

## What changed

### Added

- `OllamaClient.runtime` getter — returns a cached `OllamaRuntime`
  backed by a `FailoverHttpClient` (Wave 14) and a `cloudHttp` backend
  for host-bearing operations (Wave 15).
- `OllamaClient._runtime` private field — the cached instance.
- Import of `OllamaRuntime` in `src/client.ts`.
- JSDoc deprecation notice on `OllamaClient`.
- `test/contract/runtime-bridge.test.ts` — 3 tests covering the accessor.
- ADR 0018 (this file).

### NOT changed

- `OllamaClient` method signatures, behavior, and tests are unchanged.
- The existing `chat()`, `generate()`, `embed()`, `models.list()`, etc.
  APIs continue to work as before.
- The endpoint registry, retry config, failover logic, telemetry, and
  middleware chain are all untouched.

## Consequences

- Callers can mix the two surfaces in the same process:

  ```ts
  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
  // Existing API:
  const res = await client.chat({ model, messages });
  // Generated API (shares transport):
  const api = new NativeApi(client.runtime);
  const res2 = await api.chat({ model, messages, stream: false });
  ```

- The generated runtime inherits the same transport-layer guarantees
  (middleware, retry, telemetry, streaming) as the existing client,
  because it shares the same `HttpClient`.
- The bridge is one-directional: `OllamaClient.runtime` returns an
  `OllamaRuntime`, but `OllamaRuntime` does not expose an `OllamaClient`.
  Callers wanting the legacy surface should use `OllamaClient` directly.
- Multi-endpoint users continue to use `OllamaClient` exclusively; the
  generated surface is single-endpoint only for now. A future wave may
  add endpoint-aware `OllamaRuntime` construction if needed.

## Reference

- ADR 0013 — Wave 1 contract foundation
- ADR 0014 — Waves 2+3 generated surface and runtime seam
- ADR 0016 — Wave 6 MCP tool generation
