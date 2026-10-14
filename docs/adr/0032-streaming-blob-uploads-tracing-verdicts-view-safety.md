# ADR 0032: Streaming blob uploads, tracing-header verdicts, typed-array view safety

**Status**: Accepted
**Date**: 2026-10-14
**Context**: October 14 digest — "Raw Model Blob / Modelfile Ingestion Streaming Backpressure, W3C Distributed Tracing Baggage Injection, Defensive Serialization for Typed Arrays" + upstream-specs digest (System One batching, `expires_at`)

## Context

The audit digest arrived with a "Status: WARN" header asserting that "yesterday we
eliminated memory retention hazards in stream teeing (observeStream), guarded against
silent model context truncation (num_ctx), and added idempotent stale socket recovery
(NET-03)." That work exists — as v1.16.0 on the local stacked branch — but it has not
merged to `main` (the remote pipeline is token-blocked), so the digest's "stabilized"
premise describes a remote state that does not exist. This is the same timeline-fiction
pattern ADR 0031 recorded for the previous digest's IPC-01/OBS-01/CON-02 header; noted
here so the pattern itself stays on the record.

The findings matrix contained three claims (MOD-01, TRC-01, BUF-01); a companion
upstream-specs digest added four more (System One batching, payload caps, `expires_at`
introspection, model warmth). Every claim was audited against the codebase before any
implementation, per house discipline.

## Findings & verdicts

1. **MOD-01 (P1): "Heap exhaustion on large Modelfile/blob streaming"** — **real,
   but narrower than framed.** The real defect is on the blob path only:
   `createBlobFromFile` did `await fs.readFile(path)` — the entire GGUF enters the
   Node heap as one Buffer (multi-GB weights hit the V8 allocation ceiling before
   any network I/O) — and the transport never set `duplex: 'half'`, so the
   `ReadableStream<Uint8Array>` member `BinaryBody` already declared was a promise
   Node 18+ `fetch` rejects at dispatch (`TypeError: duplex option is required when
sending a body`). The digest's "/api/create streaming" framing is misdirected:
   `/api/create`'s request body is a small JSON document (the `files` digest map) —
   a Modelfile is a text field inside that JSON, not a streamed body. The binary
   risk lives entirely in `POST /api/blobs/:digest`.

2. **TRC-01 (P2): "Tracing headers dropped during request dispatch"** — **stale.**
   The SDK strips nothing. Three propagation mechanisms already exist: client-level
   `headers` configuration (applied to every request through the endpoint registry),
   per-request `headers` on the transport's request options (merged last, so they
   win), and the middleware pipeline, whose `RequestContext.headers` is a mutable
   record — the README's own middleware example injects a custom header. Any
   caller that captures W3C `traceparent`/`tracestate`/`baggage` and passes them
   through any of these three seams gets them forwarded verbatim.

3. **BUF-01 (P1): "Memory corruption on sub-sliced Uint8Array inputs"** — **stale
   as a defect in this codebase.** `src/` contains zero `Buffer.from()` call sites
   — the SDK is deliberately built on runtime-portable Web APIs (a property CI
   enforces: the edge-runtime gate fails on any `node:*` resolution in the main
   entry). The vulnerable pattern the digest sketches (`Buffer.from(view.buffer)`)
   does not exist; every binary touchpoint is view-safe by construction:
   `crypto.subtle.digest` hashes the view's bytes (byteOffset/byteLength respected
   per the Web Crypto `BufferSource` definition), and `fetch` serializes
   `Uint8Array` bodies per-view. Adopting the digest's `safeUint8ArrayToBuffer`
   helper would actively regress the edge-runtime property by coupling `src/` to
   Node's `Buffer`. What the audit did surface: a pointless
   `data as unknown as ArrayBuffer` cast in `computeBlobDigest` (misleading about
   the actual contract) — removed — and the value of pinning the invariant with
   the digest's own suggested probe, which the test suite now does: a
   `subarray(10, 20)` view must hash to the slice's digest (cross-checked against
   `node:crypto`) and arrive on the wire as exactly 10 bytes — never the parent
   buffer.

4. **Upstream digest, System One multi-question batching** — **stale.**
   `client.systemOne()` already evaluates N named questions against shared state
   in a single round trip, with a key-safe generic layer the digest's
   `SystemOneModule`/`client.request<any>` sketch doesn't approach: question-type
   → answer-type correlation at compile time (`AnswerFor<Q>`), the three native
   question kinds (choice/noul/score), and generated contract types. The sketch's
   `evaluateBatch(state, questions)` is the existing method with looser types.

5. **Upstream digest, payload-cap enforcement** — **stale.**
   `MAX_SYSTEM_ONE_REQUEST_BYTES` (64 KiB) and `MAX_SYSTEM_ONE_IMAGES_BYTES`
   (32 MiB) are exported constants, `estimateSystemOneRequestBytes()` is the
   pre-flight estimator, and the runtime enforces both client-side (the overlay's
   `maxRequestBytes`/`maxRequestBytesWithImages` handling) so the 413 round trip
   is avoided — exactly the digest's recommendation, already shipped.

6. **Upstream digest, `expires_at` introspection** — **stale.** `ModelResponse.expires_at`
   (types.ts, from `/api/ps`) is typed and returned by `client.ps()`. A
   `getExpiry(model)` wrapper is declined: it's a zero-config convenience around
   data that is one property away, the shape ADR 0030 declined twice already.

7. **Upstream digest, background warmth keeper** — **declined.** The supported
   primitives exist and compose: `pin()` (`keep_alive: -1`, indefinite VRAM
   residency, with the documented `unload()` counterpart), per-call `keep_alive`
   on every generation, `KEEP_ALIVE_INDEFINITE`/`KEEP_ALIVE_UNLOAD` constants,
   and `warmModelAffinity()` for the router's cache. A `ModelWarmthKeeper` daemon
   (silent-error `setInterval` in the digest's sketch) contradicts the SDK's
   explicit-lifecycle design — hidden background timers keep event loops alive,
   swallow failures, and escape the client-teardown contract. A consumer that
   wants adaptive warmth reads `ps().models` + `expires_at` and drives `generate`
   with `keep_alive` in five lines inside _their_ lifecycle, with _their_
   observability.

## Decision

Close MOD-01's real seam, pin BUF-01's invariant, and document TRC-01's existing
seams:

- **Transport (`src/transport/http.ts`)**: both fetch call sites (the middleware
  `finalHandler` and the no-middleware direct path — previously duplicated init
  construction) now share `buildFetchInit`, which adds `duplex: 'half'` exactly
  when the body is a web `ReadableStream`. The guard is structural
  (`getReader` duck-type), not `instanceof`, so streams created in other realms
  (workers, VMs) still get the member; `RequestInit` in this project's
  `@types/node` 22 doesn't yet carry `duplex`, so the builder types the init as
  `RequestInit & { duplex?: 'half' }` — assignable to the plain `RequestInit`
  `FetchLike` expects, with no runtime divergence. The member is harmless (and
  spec'd) in browsers.
- **`createBlobFromStream(digest, stream, request?)`** (new): the multi-GB-safe
  counterpart of `createBlobFromData`. The digest must be known up front — it is
  the upload URL; the server verifies streamed content against it, so a corrupted
  or truncated stream fails the upload instead of poisoning the store. HEAD-dedupe
  semantics identical to the data-based variant.
- **`createBlobFromFile` rewritten as two streaming passes**, same signature and
  result shape: pass 1 hashes through `node:crypto`'s incremental SHA-256 in
  256 KiB chunks (skipped entirely when `opts.digest` is provided — parity with
  `createBlobFromData`); pass 2 pipes `createReadStream` → `Readable.toWeb` →
  the streaming upload. Peak heap is O(chunk) in both passes, so
  `createModelFromGguf` (which routes every shard through this method) no longer
  materializes weights. The method was already Node-only (dynamic `node:fs`); the
  new `node:crypto`/`node:stream` imports follow the same hidden-specifier pattern
  that keeps the main entry edge-portable. Aborts surface as `OllamaAbortError`
  from both passes (the hash pass checks between chunks and destroys the fd; the
  upload pass forwards the signal to fetch and destroys the stream on abort).
- **Cancellation plumbing**: `createBlob` and `checkBlob` accept
  `RequestCancellationOptions` (`signal`/`timeoutMs`) like their sibling
  operations, and `createBlobFromData`'s previously decorative `signal` option is
  now actually wired through. Root `client.createBlob`/`client.checkBlob` delegate
  the new parameter through.
- **Docs**: README gains a streaming-upload subsection (both entry points, the
  memory contract, when to pass a digest) and a W3C-header propagation snippet
  (client-level `headers` + the middleware seam) under the middleware section —
  the TRC-01 answer, in the place users look.

## Consequences

- `BinaryBody`'s `ReadableStream` member is now a real capability on every
  runtime that supports it, rather than a type-level promise undici rejects.
- Multi-gigabyte uploads are bounded by transport chunk size, not file size;
  the 2 GiB V8 ceiling is no longer the practical limit for
  `createModelFromGguf`.
- Sub-view invariants (hash + wire) are pinned by tests
  (`test/streaming-blob-upload.test.ts`), so a future refactor that introduces a
  `Buffer.from(view.buffer)`-style conversion fails CI rather than corrupting
  payloads silently.
- The digest's `traceContext`-on-every-method and ambient
  `AsyncLocalStorage`-capture proposals remain declined: three existing seams
  cover propagation without inflating every method signature or adding hidden
  global state to a runtime-portable SDK.
