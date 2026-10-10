/**
 * Standardized telemetry normalizer — raw nanosecond counters to derived metrics.
 *
 * Ollama reports every duration as an **integer in nanoseconds** on its generation
 * responses (`total_duration`, `load_duration`, `prompt_eval_duration`,
 * `eval_duration` — see the official "Usage" documentation), plus token counters
 * (`prompt_eval_count`, `prompt_eval_cached_count`, `eval_count`). Consumers that
 * want milliseconds, tokens/second, or a cache-hit ratio otherwise each reimplement
 * the same division-and-rounding math — this module is that math, once, with the
 * formulas the official docs spell out:
 *
 * - `tokensPerSecond` = `eval_count / (eval_duration / 1e9)` — generation throughput.
 * - `promptTokensPerSecond` = `prompt_eval_count / (prompt_eval_duration / 1e9)` —
 *   prompt ingestion (pre-fill) throughput.
 * - `cacheHitRatio` = `prompt_eval_cached_count / (cached + evaluated)` — see the
 *   note on {@link FormattedTelemetry.cacheHitRatio} for why the denominator is the
 *   *sum*, not `prompt_eval_count` alone.
 *
 * Pure and dependency-free: {@link formatTelemetry} never fetches, never throws, and
 * treats every missing counter as `0` — partial responses (stream final events,
 * older servers without `prompt_eval_cached_count`) format cleanly instead of
 * producing `NaN`/`Infinity`.
 *
 * The input is structural: any response object carrying these optional fields —
 * `GenerateResponse`, `ChatResponse`, the final `GenerateStreamEvent`,
 * `EmbedResponse` — can be passed directly, no picking/plucking required.
 */

/**
 * The raw nanosecond/token counters Ollama attaches to generation responses. Every
 * field is optional because servers report a subset: streaming final events may omit
 * load counters, older builds predate `prompt_eval_cached_count`, and embeddings
 * carry no `eval_count`. Accepts full response objects structurally.
 */
export interface RawOllamaMetrics {
  /** Total end-to-end request latency, nanoseconds. */
  readonly total_duration?: number | undefined;
  /** Model cold-load and weight-transfer time into VRAM, nanoseconds. */
  readonly load_duration?: number | undefined;
  /** Prompt tokens freshly evaluated this request (not served from the KV cache). */
  readonly prompt_eval_count?: number | undefined;
  /** Prompt tokens served from the KV prompt cache (prefix reuse). */
  readonly prompt_eval_cached_count?: number | undefined;
  /** Prompt ingestion / pre-fill processing time, nanoseconds. */
  readonly prompt_eval_duration?: number | undefined;
  /** Tokens generated (the response proper). */
  readonly eval_count?: number | undefined;
  /** Token generation time, nanoseconds. */
  readonly eval_duration?: number | undefined;
}

/** The normalized, human-scale view of one response's {@link RawOllamaMetrics}. */
export interface FormattedTelemetry {
  /** `total_duration` in milliseconds, 2 decimals. */
  readonly totalLatencyMs: number;
  /** `load_duration` in milliseconds, 2 decimals — 0 when the model was already resident. */
  readonly modelLoadMs: number;
  /** `prompt_eval_duration` in milliseconds, 2 decimals. */
  readonly promptEvalMs: number;
  /** `eval_duration` in milliseconds, 2 decimals. */
  readonly generationMs: number;
  /** `eval_count / eval_duration` in tokens/second, 1 decimal — 0 when either is absent. */
  readonly tokensPerSecond: number;
  /** `prompt_eval_count / prompt_eval_duration` in tokens/second, 1 decimal. */
  readonly promptTokensPerSecond: number;
  /**
   * Share of prompt tokens served from the KV cache:
   * `cached / (cached + evaluated)`, 3 decimals.
   *
   * The denominator is the **sum**, not `prompt_eval_count` alone, because Ollama
   * reports `prompt_eval_count: 0` on a *full* cache hit — the same house semantics
   * as `ConversationSession`'s `cacheStats.hitRate` (see `src/conversation.ts`). A
   * `cached / prompt_eval_count` formula would report a perfect cache as `0`.
   */
  readonly cacheHitRatio: number;
}

/** Nanoseconds → milliseconds, rounded to 2 decimals; absent/zero stays `0`. */
function nsToMs(ns: number | undefined): number {
  return ns ? Math.round((ns / 1e6) * 100) / 100 : 0;
}

/**
 * Derives the standardized metrics summary from one response's raw nanosecond
 * counters. Pure — never throws, never fetches; every missing counter reads as `0`.
 *
 * ```ts
 * const res = await client.chat({ model: 'llama3.2', messages });
 * const t = formatTelemetry(res);
 * console.log(t.tokensPerSecond, 'tok/s |', t.totalLatencyMs, 'ms |',
 *   `${Math.round(t.cacheHitRatio * 100)}% prompt cache hit`);
 * ```
 */
export function formatTelemetry(raw: RawOllamaMetrics): FormattedTelemetry {
  const evalDurationSec = raw.eval_duration ? raw.eval_duration / 1e9 : 0;
  const promptDurationSec = raw.prompt_eval_duration ? raw.prompt_eval_duration / 1e9 : 0;

  const promptEvaluated = raw.prompt_eval_count ?? 0;
  const promptCached = raw.prompt_eval_cached_count ?? 0;
  const promptTotal = promptCached + promptEvaluated;

  return {
    totalLatencyMs: nsToMs(raw.total_duration),
    modelLoadMs: nsToMs(raw.load_duration),
    promptEvalMs: nsToMs(raw.prompt_eval_duration),
    generationMs: nsToMs(raw.eval_duration),
    tokensPerSecond:
      evalDurationSec > 0 && raw.eval_count
        ? Math.round((raw.eval_count / evalDurationSec) * 10) / 10
        : 0,
    promptTokensPerSecond:
      promptDurationSec > 0 && promptEvaluated
        ? Math.round((promptEvaluated / promptDurationSec) * 10) / 10
        : 0,
    cacheHitRatio: promptTotal > 0 ? Math.round((promptCached / promptTotal) * 1000) / 1000 : 0,
  };
}
