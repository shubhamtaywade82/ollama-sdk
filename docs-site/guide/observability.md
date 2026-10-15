---
outline: [2, 3]
---

# Observability & Telemetry

Production workloads need to see what the model is doing without disturbing it. The SDK ships three root-exported observability primitives that share one philosophy: **never perturb the thing being measured** — observers can't delay a stream, telemetry math never throws, and progress callbacks drain to completion.

- **`formatTelemetry`** — turn Ollama's raw nanosecond counters into the numbers humans want.
- **`observeStream`** — tap any async stream for audit logging or token counting while the primary consumer keeps iterating.
- **`onProgress` + `createProgressSpeedTracker`** — typed model pull/push progress with a pre-computed `percent`, per-layer transfer speed, and ETA.

## Standardized telemetry — `formatTelemetry`

Ollama attaches raw counters (`total_duration`, `eval_count`, `eval_duration`, …) to generation responses. `formatTelemetry` converts them to the summary you actually log:

```typescript
import { OllamaClient, formatTelemetry } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();
const response = await client.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Summarize the repo in three bullets.' }],
});

const t = formatTelemetry(response);
console.log(t);
// {
//   totalLatencyMs: 1842.31,        // total_duration → ms
//   modelLoadMs: 0,                 // load_duration → ms (0 when already resident)
//   promptEvalMs: 210.87,           // prompt ingestion
//   generationMs: 1631.02,          // eval_duration → ms
//   tokensPerSecond: 47.3,          // eval_count / eval_duration — official Usage-doc formula
//   promptTokensPerSecond: 312.9,   // prompt_eval_count / prompt_eval_duration
//   cacheHitRatio: 0.85,            // KV prompt-cache share of the prompt
// }
```

The formulas follow Ollama's official Usage documentation. `cacheHitRatio` is the share of prompt tokens served from the KV cache — the denominator is _cached + evaluated_ tokens, not `prompt_eval_count` alone, because those two counters measure disjoint work.

Three properties make it safe to call everywhere:

- **Structural input** — pass any response object carrying the counters (`ChatResponse`, `GenerateResponse`, stream final events, `EmbedResponse`) directly; no picking or plucking.
- **Never throws** — missing counters read as `0`, never `NaN` or `Infinity`. Partial responses (streaming final events, older servers without `prompt_eval_cached_count`) format cleanly.
- **Pure** — no fetching, no clocks, no side effects. Deterministic and trivially testable.

The SDK dogfoods it internally: stream `finalResult` objects expose the derived numbers as `usage` (`tokensPerSecond` and friends), and `compareDraftPerformance` computes its medians through the same math.

## Stream observation — `observeStream`

`OllamaStream`'s two consumption modes are mutually exclusive — you can't iterate a stream and tap it with `.on()` at the same time. When you need a side channel while the primary consumer keeps iterating, `observeStream` (v1.16.0) is the safe multi-sink alternative to `ReadableStream.tee()`:

```typescript
import { OllamaClient, observeStream } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();
const stream = await client.chatStream({ model: 'qwen3:8b', messages });

const observed = observeStream(stream, {
  onChunk: async (event) => {
    if (event.type === 'token') {
      await metrics.countToken(event.data.delta); // async observers are fine
    }
  },
  onDone: () => console.log('audit log has seen every chunk'),
  onListenerError: (error, phase) => console.warn(`observer ${phase} failed`, error),
});

// The wrapper iterates exactly like the original stream:
for await (const event of observed) {
  if (event.type === 'token') process.stdout.write(event.data.delta);
}
```

It accepts any `AsyncIterable` — SDK streams, NDJSON chunk iterables, or your own sources. The contract is one-sided in favor of the primary consumer:

| Guarantee                           | Mechanism                                                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Observers never block**           | A serialized microtask chain — sync observers pay one hop, async observers run strictly FIFO with concurrency of exactly one. A slow logger throttles only its own tail.                                                                                  |
| **Observers never fail the stream** | Sync throws and async rejections route to `onListenerError` (with the phase they came from: `'chunk' \| 'done' \| 'error' \| 'abandoned'`). A failing `onListenerError` is swallowed the same way — never unhandled rejections, never pipeline poisoning. |
| **Observers stay ordered**          | `onDone` is enqueued only after the last chunk's observer settles, so an audit log has seen every chunk before its "done" marker.                                                                                                                         |

The full lifecycle: `onDone` on natural completion; `onError` + rethrow on source failure (the observer is transparent, not a circuit breaker); `onAbandon` when the consumer breaks early — fired after the iterator-close protocol has already closed the source.

::: warning Bound a stalling observer
There is no second branch to backpressure — the only retained state is one closure per backlogged observer callback. If your observer can stall _forever_, bound it on your side (queue, drop policy); the wrapper will keep enqueueing otherwise, exactly like any fire-and-forget log sink.
:::

The design is deliberately stricter than a naive `void onChunk(chunk)` fire-and-forget, which runs concurrent out-of-order observers and turns a rejected async callback into an unhandled rejection. The full rationale lives in [ADR 0031](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0031-stream-observation-network-classification-context-recommendations.md).

## Progress, speed & ETA

### `onProgress` — the typed callback

Model pulls and pushes stream NDJSON progress frames (`status`, `digest`, `total`, `completed`). `onProgress` (root-exported since v1.18.0) wraps that stream into a typed callback with the math already done:

```typescript
import { OllamaClient, onProgress } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();
const stream = await client.models.pull({ model: 'qwen3:8b', stream: true });

await onProgress(stream, (event) => {
  // PullProgressEvent:
  //   status         'pulling manifest' | 'downloading' | 'verifying sha256 digest' | ...
  //   digest?        SHA-256 of the layer being transferred
  //   total?         layer size in bytes, when reported
  //   completed?     bytes transferred so far
  //   percent?       clamped [0, 100], 2 decimals — undefined for status-only frames
  //   bytesPerSecond? cumulative average for the current layer (2nd byte-bearing frame on)
  //   etaSeconds?    remaining-time estimate, undefined when total is unknown
  const speed = event.bytesPerSecond
    ? `${(event.bytesPerSecond / 1024 / 1024).toFixed(1)} MiB/s`
    : '';
  const eta = event.etaSeconds ? ` — ETA ${Math.ceil(event.etaSeconds)}s` : '';
  process.stdout.write(`\r${event.status}: ${event.percent ?? '…'}% ${speed}${eta}   `);
});
```

`pushModel` works identically. The helper drains the stream to completion for you and resolves when the transfer finishes.

### `createProgressSpeedTracker` — the raw counter

The stateful per-layer byte counter that CLIs and dashboards used to hand-roll, exported as a standalone function (v1.18.0). Feed it every raw progress chunk and it returns that chunk's speed and ETA:

```typescript
import { createProgressSpeedTracker } from '@nemesis-oss/ollama-sdk';

const tracker = createProgressSpeedTracker();

for await (const chunk of someNdjsonProgressSource) {
  const { bytesPerSecond, etaSeconds } = tracker(chunk);
  updateProgressBar({ bytesPerSecond, etaSeconds });
}
```

The semantics are chosen for stable progress bars:

- **Cumulative average** since the layer's first byte-bearing frame — instantaneous frame-to-frame rates jitter wildly.
- **Per-layer epochs** — the tracker resets whenever `digest` changes or `completed` regresses, so a multi-layer pull never averages across layers (the classic hand-rolled-counter bug).
- **`performance.now()` monotonic timing** — immune to wall-clock adjustments.
- **Guards** — no-completed passthrough, zero-elapsed, and zero-transferred frames return no speed; a missing `total` yields `etaSeconds: undefined`, never a fake `0` or `NaN`.

### Companion helpers

`computeProgressPercent(completed, total)` is the pure clamped-percentage function, and `toPullProgressEvent(chunk)` maps a raw wire frame to a `PullProgressEvent` without measuring time — useful when you're persisting progress frames or building your own pipeline.

## What to use when

| Need                                              | Use                                                           |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Log human-scale latency/throughput for a response | `formatTelemetry(response)`                                   |
| Side-channel audit of a live stream               | `observeStream(stream, { onChunk, onDone, onListenerError })` |
| Pull/push progress with percent, speed, ETA       | `onProgress(stream, cb)`                                      |
| Custom progress UI over raw frames                | `createProgressSpeedTracker()`                                |
| Percentage math without a tracker                 | `computeProgressPercent(completed, total)`                    |

## Next steps

- **[Streaming](./streaming)** — the full `OllamaStream` surface `observeStream` taps into.
- **[Custom Models](./custom-models)** — the blob/GGUF upload flows whose progress these helpers track.
- **[ADR 0031](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0031-stream-observation-network-classification-context-recommendations.md)** and **[ADR 0033](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0033-progress-speed-decision-gates-abort-pin-systemone-refresh.md)** — design history for both waves.
