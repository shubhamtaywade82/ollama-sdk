# ADR 0025: Embedding batching, client teardown, and declaration portability

Date: 2026-10-08

## Status

Accepted

## Context

The daily production-readiness audit flagged three findings at the SDK's
scale and pipeline limits:

1. **EMB-01 (P1) — unbounded embedding concurrency.** `/api/embed` is the
   workhorse of local RAG architectures, and the idiomatic caller pattern —
   `Promise.all(chunks.map(c => client.embed(...)))` — fires every request at
   once. Against a local daemon this contends sockets, saturates
   `OLLAMA_MAX_QUEUE` (surfacing as 503 `overloaded`), and spikes GPU VRAM as
   one model instance serves N prompts simultaneously; at worst it OOMs the
   daemon. A second, quieter failure mode hides inside large inputs: Ollama
   **silently truncates** any input string longer than the model's `num_ctx`
   unless `truncate: false` is set, producing degraded vectors with no error.
2. **TYP-03 (P1) — dual CJS/ESM declaration resolution.** The audit asserted
   that `.d.ts` without `.d.cts` breaks `moduleResolution: NodeNext` CommonJS
   consumers with TS1479 ("masquerading" ESM types under `require()`).
   Verification showed the packaging was already correct — paired
   `.d.ts`/`.d.cts` per entry, nested `import`/`require` × `types`/`default`
   exports conditions, `@arethetypeswrong/cli` green in CI — but nothing
   _compiled_ a real consumer, and that net caught a genuine, different leak
   (below).
3. **THD-01 (P2) — no client teardown.** Inside `node:worker_threads` and
   short-lived processes, the SDK's own managed resources — in-flight fetch
   bodies, unconsumed stream readers, requests queued behind
   `maxConcurrentPerEndpoint` — keep the event loop (and thus the thread)
   alive. Callers had per-request `signal`s but no client-level drain.

## Decision

### 1. Batch-constrained embedding pipeline (`src/embed-batch.ts`)

`client.embedBatch()` — and the standalone `batchEmbed(client, options)` —
partition the corpus into `batchSize` slices (default 32) and embed them
through `client.embed()` with a fixed pool of at most `concurrency` workers
(default 3), so every batch inherits the full pipeline (failover, retry,
auth, logging, telemetry) with no second dispatch path to drift.

Three semantics are deliberate:

- **Order-preserving.** Results write into `embeddings[batchIndex *
batchSize + j]`, so completion order can never reorder the corpus. Vector
  ingestion zips `input[i] ↔ embeddings[i]`; a reorder-silent API would
  corrupt indexes.
- **Fail-fast, surfacing the original error.** The first batch failure aborts
  an internal controller that every in-flight sibling embed receives; sibling
  workers rethrow the _first_ error rather than their derived `AbortError`s,
  so callers diagnose root causes. Half-indexed corpora must never look like
  success — callers re-run ingestions all-or-nothing.
- **Per-string context pre-flight at the exact window.** Like chat/generate,
  `defaultContextLength` is injected as `num_ctx` and estimates are checked
  client-side — but with no 0.9 margin, because an embedding prompt _is_ the
  whole input (no output-token headroom) and the trip point is precisely
  where Ollama starts silently truncating. Warn (default) or throw
  (`onContextOverflow: 'throw'`) with offending indexes, before any wire
  traffic.

Defaults are deliberately conservative (32 × 3): a local daemon serves one
model instance per GPU, and the audit's failure mode is flood, not latency.

### 2. Declaration portability verification, not just attw

`scripts/verify-consumer-types.sh` (wired into CI's `package` job and
`verify:release`) packs the tarball and compiles two real consumer projects:
a CommonJS consumer under `--module node16` — the exact TS1479 scenario,
resolving `.d.cts` through the `require` condition — and an ESM consumer
under `--module nodenext`. Its first run caught a real leak attw cannot see:
`VisionInput` included Node's `Buffer` global, making the published
declarations un-compilable for strict consumers without `@types/node`
(browsers, Deno, lint-tight packages). The fix — `string | Uint8Array` —
keeps Node Buffers fully accepted (they are `Uint8Array` subclasses; all 13
vision tests pass unchanged) while making the declarations free of Node
ambient globals.

### 3. Client teardown via per-request abort scopes

`executeWithFailover` and `executeCloudRequest` now wrap every caller signal
in a client-owned **request scope** (an `AbortController` registered in a
private `activeRequests` set). `destroy(reason?)` aborts every registered
scope with a single `OllamaAbortError(reason)` — which `mapError` passes
through untouched, so every caller sees `code: 'aborted'` with the destroy
reason, whether the operation was dispatched, mid-stream, or still queued
behind `waitForCapacity`.

Scope lifetime is tied to the work, not the method call: plain requests
deregister when the response settles; streams deregister when `finalResult`
settles — the same moment the existing `holdUntil` logic releases the
endpoint slot. That alignment means `destroy()` can tear down a stream
mid-consumption but never leaks an entry for finished work. Because every
public surface (chat/generate/embed(+Batch), models, responses bridge,
sessions, agent, usage/balance, web tools) routes through the two executors,
all of them are covered with no per-method wiring.

`destroy()` is a **drain, not a disable**: it returns the count of aborted
operations, repeat calls return `0`, and the client remains usable — matching
the audit's ask (clean thread exit) without introducing a zombie-state
failure mode that would break long-lived clients sharing an instance.

## Consequences

- `embedBatch` adds a second knob surface (`batchSize`, `concurrency`) that
  callers must tune per daemon; defaults err safe (laptop-GPU-friendly), and
  the README documents the tuning guidance.
- Fail-fast means one poison input aborts the whole call — intentional for
  ingestion; callers wanting partial progress can catch, filter, and re-run
  (the `onBatchComplete` progress makes resumption points visible).
- The consumer-type script adds ~15s to CI/release gates; it downloads
  nothing beyond the two `npm install`s of the packed tarball plus zod and
  `@opentelemetry/api` (the SDK's own type-level peer requirements).
- `destroy()` does not (and cannot) abort work that never went through the
  client — raw `fetch` calls, or `healthCheck()`'s direct probes, are
  caller-managed; the method docs say so.
- 29 new tests cover batching/ordering/concurrency caps, fail-fast sibling
  cancellation, external + destroy teardown of batches, stream teardown with
  slot release, idempotency, post-destroy usability, and the two consumer
  compilations.
