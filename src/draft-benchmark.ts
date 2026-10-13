/**
 * Speculative-decoding draft benchmark — measures whether the runtime
 * `draft_num_predict` option provides a net throughput gain for a specific
 * prompt (October 13 digest; see ADR 0030).
 *
 * Upstream Ollama does not emit a dedicated draft-token acceptance counter —
 * speculative efficiency is only observable as effective throughput
 * (`eval_count` / `eval_duration`). And the signal is noisy: rejected draft
 * predictions *add* compute (high-temperature, creative, non-deterministic
 * prompts), while accepted drafts dramatically cut `eval_duration` on
 * predictable workloads (structured code generation, JSON extraction). A
 * single run therefore proves nothing — this helper implements the
 * deterministic profiling protocol the upstream observations call for:
 *
 *   - **Deterministic sampling** — `temperature: 0` is forced and a fixed
 *     `seed` (default 42) is stamped on every measured run, so both sides
 *     generate comparable token streams.
 *   - **Warm-up discard** — one throwaway `num_predict: 1` generation per
 *     setting pays the model load (`load_duration`) before any sample is
 *     taken.
 *   - **Identical prompt, both sides** — baseline (`draft_num_predict: 0`,
 *     drafting disabled) vs. speculative (`draft_num_predict: N`), several
 *     samples each, **median** compared (single samples mislead).
 *   - Throughput comes from `formatTelemetry` — the official Usage-doc
 *     tokens/second math, never hand-rolled nanosecond division.
 *
 * `effectiveGain` is true when the reported `speedupMultiplier` exceeds
 * `gainThreshold` (default 1.05 — five percent, past run-to-run noise). A
 * speedup of about 1.0 usually means the model has **no draft network** (and
 * no embedded MTP tensors): the server silently ignores the option and both
 * sides measure the same — see `lab/15-speculative-draft` for a per-setting
 * table over 0/4/8/16.
 *
 * ```ts
 * import { OllamaClient, compareDraftPerformance } from '@nemesis-oss/ollama-sdk';
 *
 * const comparison = await compareDraftPerformance(new OllamaClient(), {
 *   model: 'llama3.1',
 *   prompt: 'Extract the sender, subject, and date from this email as JSON: ...',
 * });
 * if (comparison.effectiveGain) {
 *   // drafting pays off for this prompt
 * }
 * ```
 */

import { OllamaClientError } from './errors.js';
import { formatTelemetry } from './telemetry/index.js';
import type { GenerateRequestOptions, GenerateResponse } from './types.js';

/**
 * Structural dependency of {@link compareDraftPerformance}: anything that can
 * run a non-streaming `/api/generate` call. `OllamaClient` satisfies it
 * without being named (same discipline as the model-affinity router's
 * structural client), so tests and alternative transports can substitute a
 * minimal object.
 */
export interface DraftBenchmarkClient {
  generate(req: GenerateRequestOptions & { stream?: false | undefined }): Promise<GenerateResponse>;
}

/** Options for {@link compareDraftPerformance}. */
export interface CompareDraftPerformanceOptions {
  /** Model to benchmark — must be a name the target server can load. */
  readonly model: string;
  /**
   * The prompt both sides generate. The comparison is only meaningful with a
   * fixed prompt: draft acceptance — and thus speedup — is workload-dependent
   * (structured/predictable prompts gain the most; creative ones can lose).
   */
  readonly prompt: string;
  /**
   * Draft tokens per step for the speculative side. Default `4` (Ollama's
   * default for separate draft models). Must be >= 1 — the baseline side
   * always measures with drafting disabled (`0`).
   */
  readonly draftNumPredict?: number | undefined;
  /**
   * Measured runs per setting; the median is reported. Default `5`. Single
   * samples mislead — noisy small-model runs swing tens of percent.
   */
  readonly samples?: number | undefined;
  /** `num_predict` cap per measured run. Default `256`. */
  readonly numPredict?: number | undefined;
  /** Fixed sampling seed stamped on every run (with `temperature: 0`). Default `42`. */
  readonly seed?: number | undefined;
  /**
   * Run one throwaway `num_predict: 1` generation per setting before sampling
   * (pays the model load). Default `true`.
   */
  readonly warmup?: boolean | undefined;
  /**
   * `speedupMultiplier` above this reports `effectiveGain: true`. Default
   * `1.05` — five percent, past typical run-to-run noise.
   */
  readonly gainThreshold?: number | undefined;
  /** Abort signal — checked before every run and forwarded to each generate call. */
  readonly signal?: AbortSignal | undefined;
}

/** One side's measurement detail (see {@link DraftPerformanceComparison}). */
export interface DraftRunStats {
  /** The `draft_num_predict` value this side ran with (`0` = baseline). */
  readonly draftNumPredict: number;
  /** Median tokens/second across the valid samples (unrounded). */
  readonly medianTokensPerSecond: number;
  /** Every valid sample's tokens/second, in run order. */
  readonly sampleTokensPerSecond: readonly number[];
  /** Median generation-phase duration (`eval_duration`) in milliseconds. */
  readonly medianEvalDurationMs: number;
}

/** Result of {@link compareDraftPerformance}. */
export interface DraftPerformanceComparison {
  /** The model that was benchmarked. */
  readonly model: string;
  /** The prompt both sides generated. */
  readonly prompt: string;
  /** The speculative side's `draft_num_predict` (the baseline always ran `0`). */
  readonly draftNumPredict: number;
  /** Baseline median tokens/second, rounded to 1 decimal. */
  readonly baselineTokensPerSec: number;
  /** Speculative median tokens/second, rounded to 1 decimal. */
  readonly speculativeTokensPerSec: number;
  /** `speculativeTokensPerSec / baselineTokensPerSec`, rounded to 2 decimals. */
  readonly speedupMultiplier: number;
  /** `true` when the reported `speedupMultiplier` exceeds `gainThreshold`. */
  readonly effectiveGain: boolean;
  /** The threshold `effectiveGain` was evaluated against. */
  readonly gainThreshold: number;
  /** Full baseline detail (samples, medians). */
  readonly baseline: DraftRunStats;
  /** Full speculative detail (samples, medians). */
  readonly speculative: DraftRunStats;
}

const DEFAULT_DRAFT_TOKENS = 4;
const DEFAULT_SAMPLES = 5;
const DEFAULT_NUM_PREDICT = 256;
const DEFAULT_SEED = 42;
const DEFAULT_GAIN_THRESHOLD = 1.05;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `compareDraftPerformance: ${name} must be an integer >= 1 (got ${value}).`,
    );
  }
}

async function runSide(
  client: DraftBenchmarkClient,
  options: CompareDraftPerformanceOptions,
  draftNumPredict: number,
  samples: number,
  numPredict: number,
  seed: number,
): Promise<DraftRunStats> {
  const samplingOptions = {
    num_predict: numPredict,
    temperature: 0,
    seed,
    draft_num_predict: draftNumPredict,
  };

  if (options.warmup ?? true) {
    // Throwaway run: pays the model load (`load_duration`) so the measured
    // samples reflect steady-state generation, not cold-start I/O.
    await client.generate({
      model: options.model,
      prompt: options.prompt,
      options: { ...samplingOptions, num_predict: 1 },
      stream: false,
      signal: options.signal,
    });
  }

  const tokensPerSecond: number[] = [];
  const generationMs: number[] = [];
  for (let i = 0; i < samples; i++) {
    options.signal?.throwIfAborted();
    const response = await client.generate({
      model: options.model,
      prompt: options.prompt,
      options: samplingOptions,
      stream: false,
      signal: options.signal,
    });
    const telemetry = formatTelemetry(response);
    if (Number.isFinite(telemetry.tokensPerSecond) && telemetry.tokensPerSecond > 0) {
      tokensPerSecond.push(telemetry.tokensPerSecond);
      generationMs.push(telemetry.generationMs);
    }
  }

  if (tokensPerSecond.length === 0) {
    throw new OllamaClientError(
      `compareDraftPerformance: every draft_num_predict=${draftNumPredict} sample returned a ` +
        `non-positive tokens/second. The model name is likely wrong, or the server returned ` +
        `empty generations.`,
      { code: 'draft_benchmark_no_valid_samples' },
    );
  }

  return {
    draftNumPredict,
    medianTokensPerSecond: median(tokensPerSecond),
    sampleTokensPerSecond: tokensPerSecond,
    medianEvalDurationMs: median(generationMs),
  };
}

/**
 * Measure whether speculative drafting pays off for a specific prompt:
 * identical prompt, deterministic sampling (`temperature: 0` + fixed `seed`),
 * warm-up discard, several samples per setting, median baseline
 * (`draft_num_predict: 0`) vs. median speculative (`draft_num_predict: N`)
 * compared as `speedupMultiplier`.
 *
 * Both sides run through the client's non-streaming `generate` — the raw
 * counters come back on the response and throughput is derived by
 * `formatTelemetry`. Non-positive/unusable samples are skipped; if a side
 * ends up with none, an `OllamaClientError` explains why (wrong model name /
 * empty generations) rather than reporting a fabricated zero.
 */
export async function compareDraftPerformance(
  client: DraftBenchmarkClient,
  options: CompareDraftPerformanceOptions,
): Promise<DraftPerformanceComparison> {
  const draftNumPredict = options.draftNumPredict ?? DEFAULT_DRAFT_TOKENS;
  requirePositiveInteger('draftNumPredict', draftNumPredict);
  const samples = options.samples ?? DEFAULT_SAMPLES;
  requirePositiveInteger('samples', samples);
  const numPredict = options.numPredict ?? DEFAULT_NUM_PREDICT;
  requirePositiveInteger('numPredict', numPredict);
  const seed = options.seed ?? DEFAULT_SEED;
  if (!Number.isInteger(seed)) {
    throw new RangeError(`compareDraftPerformance: seed must be an integer (got ${seed}).`);
  }
  const gainThreshold = options.gainThreshold ?? DEFAULT_GAIN_THRESHOLD;
  if (!Number.isFinite(gainThreshold) || gainThreshold <= 0) {
    throw new RangeError(
      `compareDraftPerformance: gainThreshold must be a positive finite number (got ${gainThreshold}).`,
    );
  }

  options.signal?.throwIfAborted();

  // Baseline first, then speculative — a fixed order keeps runs reproducible
  // (identical prompts, deterministic sampling, shared warm-VRAM state).
  const baseline = await runSide(client, options, 0, samples, numPredict, seed);
  const speculative = await runSide(client, options, draftNumPredict, samples, numPredict, seed);

  // The reported numbers are self-consistent: the multiplier divides the two
  // rounded medians, and `effectiveGain` compares that reported multiplier
  // against the threshold.
  const baselineTokensPerSec = roundTo(baseline.medianTokensPerSecond, 1);
  const speculativeTokensPerSec = roundTo(speculative.medianTokensPerSecond, 1);
  const speedupMultiplier =
    baselineTokensPerSec > 0 ? roundTo(speculativeTokensPerSec / baselineTokensPerSec, 2) : 0;

  return {
    model: options.model,
    prompt: options.prompt,
    draftNumPredict,
    baselineTokensPerSec,
    speculativeTokensPerSec,
    speedupMultiplier,
    effectiveGain: speedupMultiplier > gainThreshold,
    gainThreshold,
    baseline,
    speculative,
  };
}
