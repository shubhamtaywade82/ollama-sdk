---
outline: [2, 3]
---

# Custom Models, Blobs & Speculative Decoding

Ollama's content-addressed blob protocol is how custom models ship: upload GGUF shards as SHA-256-addressed blobs, then reference them by digest in `/api/create`. The SDK wraps the whole pipeline — digest computation, HEAD-dedupe, streaming uploads with bounded heap, Modelfile assembly, and speculative-decoding draft networks — behind a small set of methods on `client.models`.

## Blob uploads, three ways

| Method                                 | Input                    | Best for                                                   |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| `createBlobFromData(digest, data)`     | `Uint8Array` in memory   | Small buffers you already have                             |
| `createBlobFromFile(path, opts?)`      | Local file path          | Multi-GB GGUF shards on disk                               |
| `createBlobFromStream(digest, stream)` | Any web `ReadableStream` | Your own source — fetch bodies, transforms, custom readers |

All three follow the documented protocol: `HEAD /api/blobs/<digest>` first, upload only when the blob is missing (HEAD-dedupe), so re-publishing an existing model costs one request per shard.

### Streaming uploads with bounded heap (v1.17.0)

`createBlobFromFile` never reads the whole file: it runs **two streaming passes** — an incremental SHA-256 hash pass through `node:crypto` in 256 KiB chunks (skipped entirely when you pass `opts.digest`), then an upload pass piping `createReadStream` → `Readable.toWeb` into the request body. Peak heap is O(chunk) in both passes — multi-gigabyte GGUFs never enter the Node heap. `createModelFromGguf` routes every shard through this method, so the whole assembly inherits the bound.

```typescript
import { OllamaClient, computeBlobDigest } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

// Hash + upload a multi-GB shard with bounded memory:
await client.models.createBlobFromFile('/models/qwen3-8b-q4.gguf');

// Already know the digest (e.g. from a manifest)? Skip the hash pass:
await client.models.createBlobFromFile('/models/qwen3-8b-q4.gguf', {
  digest: 'sha256:0123abcd…',
});

// Your own stream source — the digest is the address; the server verifies
// streamed content against it, so a truncated stream fails the upload
// instead of poisoning the store:
await client.models.createBlobFromStream(
  digest,
  someReadableStream, // ReadableStream<Uint8Array> — fetched, transformed, anything
);
```

Under the hood the transport sets `duplex: 'half'` exactly when a request body is a web `ReadableStream` (structural detection, so cross-realm streams from workers and VM contexts qualify). All three methods accept `RequestCancellationOptions` (`signal`/`timeoutMs`); aborts surface as `OllamaAbortError` with file-descriptor and stream hygiene.

`computeBlobDigest(data)` is the exported SHA-256 → `sha256:<hex>` helper when you need the address of an in-memory buffer.

## One-shot assembly — `createModelFromGguf`

The headline flow: upload GGUF shard blobs, then `/api/create` with a `files` map of `{ basename: digest }`:

```typescript
await client.models.createModelFromGguf('my-model', '/path/to/model.gguf', {
  template: '{{ .Prompt }}',
});
```

Every shard is uploaded through the streaming path above, HEAD-deduped, and referenced under its basename. Multi-shard models accept an array of paths.

### Speculative-decoding assembly

Pass the draft network's shards and Ollama assembles a speculative model — a small draft model proposes tokens, the primary model verifies them in one batch, and accepted drafts slash `eval_duration` on predictable workloads:

```typescript
await client.models.createModelFromGguf('my-model', '/path/to/model.gguf', {
  draftGguf: '/path/to/draft.gguf', // uploaded into draft_files, same protocol
  draftQuantize: 'q8_0', // compress the draft weights during ingestion
  parameters: { draft_num_predict: 8 }, // draft tokens per step
});
```

- `draftGguf` — local path(s) to draft shards; each is uploaded as a blob and assembled into `draft_files` under its basename (composes with an explicit `draft_files` digest map; path uploads win on basename collision).
- `draftQuantize` — quantizes the draft weights independently of the primary model.
- `parameters.draft_num_predict` — draft tokens per step. Separate draft models default to `4`; `0` disables drafting; embedded MTP tensors require an explicit value. JSDoc on create-time `parameters` documents all three.

::: tip Model capabilities
`client.showModel()` reports whether a model has a draft network. A ≈1.0 `speedupMultiplier` from the benchmark below is itself diagnostic: the model has no draft network, so the server silently ignores the option.
:::

## Does drafting pay off? — `compareDraftPerformance`

Speculative decoding is workload-dependent: accepted drafts slash latency on structured, predictable prompts; rejected drafts _add_ compute on creative ones. `compareDraftPerformance` (v1.15.0) is the deterministic A/B that answers the question for _your_ prompt:

```typescript
import { OllamaClient, compareDraftPerformance } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

const result = await compareDraftPerformance(client, {
  model: 'my-model',
  prompt: 'Summarize this transaction log and flag anomalies:\n<log>…</log>',

  draftNumPredict: 4, // speculative side; baseline always runs 0 (default 4)
  samples: 5, // measured runs per side, median reported (default 5)
  numPredict: 256, // generation cap per run
  seed: 42, // fixed seed with temperature: 0 — deterministic sampling
  warmup: true, // one throwaway run per side pays the model load
});

console.log(result.baselineTokensPerSec); // 41.9  (median, 1dp)
console.log(result.speculativeTokensPerSec); // 61.4
console.log(result.speedupMultiplier); // 1.47  (ratio of the two reported medians)
console.log(result.effectiveGain); // true  (> gainThreshold, default 1.05)
console.log(result.baseline.sampleTokensPerSecond); // every sample, both sides
```

Both sides generate the identical prompt with `temperature: 0` and a fixed seed; throughput flows through `formatTelemetry` (the official Usage-doc math — never hand-rolled nanosecond division); the **median** is reported because single samples on small models swing tens of percent.

Guard rails: `RangeError` on invalid numeric options; a side with **no** valid samples throws `OllamaClientError` (`draft_benchmark_no_valid_samples`) instead of fabricating a zero/Infinity speedup; the abort signal is checked between runs and forwarded to every call. The function is structural — it accepts any `{ generate }` client, so tests inject a plain object.

## Verifying the result

`formatTelemetry` on the benchmark generations shows where the speedup comes from — accepted drafts shrink `generationMs` while `promptTokensPerSecond` stays flat. For a deeper drill, the repository's `lab/15-speculative-draft/measure-draft-speedup.ts` sweeps `draft_num_predict` over 0/4/8/16 with medians — kept in the lab deliberately (ADR 0030): the sweep is an experimentation concern, the single-shot A/B is the API.

## Errors

Blob and create operations throw the standard `OllamaClientError` hierarchy. Notable cases: a digest mismatch (corrupted upload) fails the request server-side; `/api/create` validation errors surface as `OllamaServerError` with the daemon's message; aborts surface as `OllamaAbortError` from any pass.

## Next steps

- **[Observability](./observability)** — `formatTelemetry`, the math behind the benchmark's medians.
- **[ADR 0030](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0030-draft-benchmark-request-aware-mock-routes.md)** and **[ADR 0032](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0032-streaming-blob-uploads-tracing-verdicts-view-safety.md)** — design history for the benchmark and the streaming-upload rewrite.
- **[Testing](./testing)** — mock the blob endpoints and `/api/create` with `rawBody` + custom headers.
