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

1. Lazily constructs an `HttpClient` bound to the registry's first
   candidate endpoint (or the resolved single-endpoint config when no
   `endpoints` array was provided).
2. Wraps that HttpClient in an `OllamaRuntime`, configured with
   `localMode` inferred from the endpoint's baseUrl (same logic as
   `inferRuntimeMode`).
3. Caches the runtime — subsequent `client.runtime` calls return the same
   instance.
4. Inherits `fetch`, `middleware`, `onLifecycleEvent` from the host
   `OllamaClient`.

### Multi-endpoint caveat

The generated surface does not currently support multi-endpoint failover
(the runtime is bound to one HttpClient, which is bound to one baseUrl).
For multi-endpoint configs that need per-call routing, callers should
either:

- Keep using `OllamaClient` (the failover layer lives there), or
- Construct `OllamaRuntime` directly with a specific endpoint's
  `HttpClient`:

  ```ts
  const http = new HttpClient({ baseUrl: 'http://host-a:11434' });
  const runtime = new OllamaRuntime({ http });
  const api = new NativeApi(runtime);
  ```

This is documented on the `runtime` getter itself.

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
  bound to the first endpoint.
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
