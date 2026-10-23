# ADR 0037: Per-call cancellation — `systemOne` takes a signal, and the failover layer stops dropping it

**Status**: Accepted
**Date**: 2026-10-23
**Context**: Nexum's Decision Plane calls the SDK through `OllamaRuntime.invoke` with an `AbortSignal` so that a decision can be bounded by a deadline. It also re-implements the 0.40.5 cloud-model gate (ADR 0036), because the public `OllamaClient.systemOne()` takes no options and therefore no signal. Checking whether the nexum-side signal actually reached the wire turned up a defect in the SDK, not in nexum.

## Context

1. **The caller's signal never reached the wire, for any runtime operation.** `FailoverHttpClient.request` (`src/failover-http-client.ts`) rebuilt the per-attempt options as `{ ...httpOptions, ...(httpOptions.signal !== undefined ? { signal } : { signal }) }`. Both branches assign the failover layer's own `signal`, so the caller's `httpOptions.signal` was discarded. The caller's signal was never passed to `executeWithFailover` either, so nothing merged it into the scope. Every operation that takes a `signal` and is routed through the failover client was affected: `native.tags`, `native.ps`, `native.version`, `native.blobs`, `runtime.invoke({ signal })`, and nexum's `systemOne` path. Each accepted the option and ignored it. A repro against a fetch that stalls until aborted showed the wire signal never aborting.

2. **The public `systemOne()` has no per-call options.** The generated `NativeApi.systemOne(request)` takes only the request. The cloud gate lives in `OllamaClient.systemOne` (ADR 0036), so any caller that needs cancellation has to bypass the gate by calling `runtime.invoke` directly. That is how the duplication in nexum arose.

3. **The cloud-model version probe is a cached, shared promise.** `serverVersionCache` is one `/api/version` request per client (ADR 0036). Passing a caller's signal straight into that request would let one impatient caller cancel the probe for every later caller, after which the probe would be re-issued or fail open.

## Decisions

1. **Fix the root cause in the failover layer.** `FailoverHttpClient.request` passes the caller's signal into `executeWithFailover`, which already merges it with the failover scope, so `destroy()` and the timeout still apply. The per-attempt callback uses the merged signal it receives. Behaviour change: a caller's signal now cancels the request for every operation that accepts one. A caller that passes an already-aborted signal now fails immediately instead of sending the request.

2. **`systemOne(request, options?: { signal })`.** The wrapper keeps its single gate and calls `runtime.invoke` with the same `systemOneOp` and body that `NativeApi.systemOne` uses, plus the signal. The generated `NativeApi` is not hand-edited. Adding `signal` to the generator's output for body-carrying operations is a larger change to the contract pipeline and is left for a later ADR.

3. **The signal races the probe; it does not cancel it.** `assertCloudModelSupported` awaits the shared probe through `untilAborted`. A caller that aborts rejects with `OllamaAbortError` and the probe stays cached for the next caller. A probe that fails for its own reason still fails open and is dropped so that a later call retries (ADR 0036). `untilAborted` subscribes to the shared promise even when the signal has already aborted, so a later probe failure cannot surface as an unhandled rejection.

## Declined

- **`timeoutMs` on `systemOne`.** Callers compose a deadline with `AbortSignal.timeout(ms)`. A second deadline option would duplicate that and have to be reconciled with the client's `timeoutMs`.
- **Signal in the request body.** Anything in the body is serialised to the wire.
- **Regenerating `NativeApi` with `signal` on every body-carrying operation.** Correct in principle, but it changes generated output for every operation and needs a contract-pipeline change that is out of scope for this fix.

## Consequences

- `native.tags/ps/version/blobs` and `runtime.invoke` honour their signals. Callers that relied on the signal being ignored would observe an abort they did not expect, and the CHANGELOG records this.
- Nexum can call `client.systemOne(request, { signal })` through the wrapper and drop its duplicated gate once this release is published.
- `systemOne` is a minor API addition: the new parameter is optional and existing calls are unchanged.
