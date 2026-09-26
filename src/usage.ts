/**
 * Token usage and duration calculation utilities.
 */

export const NANOS_PER_MS = 1_000_000;
export const NANOS_PER_SECOND = 1_000_000_000;

export interface TokenUsage {
  readonly promptTokens: number;
  /** Prompt tokens read from Ollama's KV cache. */
  readonly cachedPromptTokens?: number | undefined;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly tokensPerSecond?: number | undefined;
  readonly loadDurationMs?: number | undefined;
  readonly promptEvalDurationMs?: number | undefined;
  readonly evalDurationMs?: number | undefined;
  readonly totalDurationMs?: number | undefined;
}

export interface RawUsageSource {
  readonly prompt_eval_count?: number | undefined;
  readonly prompt_eval_cached_count?: number | undefined;
  readonly eval_count?: number | undefined;
  readonly total_duration?: number | undefined;
  readonly load_duration?: number | undefined;
  readonly prompt_eval_duration?: number | undefined;
  readonly eval_duration?: number | undefined;
}

/**
 * Extracts and normalizes token usage metrics from an Ollama response.
 */
export function extractUsage(raw: RawUsageSource): TokenUsage {
  const promptTokens = raw.prompt_eval_count ?? 0;
  const completionTokens = raw.eval_count ?? 0;
  const totalTokens = promptTokens + completionTokens;

  let tokensPerSecond: number | undefined;
  if (raw.eval_count && raw.eval_duration && raw.eval_duration > 0) {
    tokensPerSecond = Number(((raw.eval_count / raw.eval_duration) * NANOS_PER_SECOND).toFixed(2));
  }

  return {
    promptTokens,
    ...(raw.prompt_eval_cached_count !== undefined
      ? { cachedPromptTokens: raw.prompt_eval_cached_count }
      : {}),
    completionTokens,
    totalTokens,
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    ...(raw.load_duration !== undefined
      ? { loadDurationMs: raw.load_duration / NANOS_PER_MS }
      : {}),
    ...(raw.prompt_eval_duration !== undefined
      ? { promptEvalDurationMs: raw.prompt_eval_duration / NANOS_PER_MS }
      : {}),
    ...(raw.eval_duration !== undefined
      ? { evalDurationMs: raw.eval_duration / NANOS_PER_MS }
      : {}),
    ...(raw.total_duration !== undefined
      ? { totalDurationMs: raw.total_duration / NANOS_PER_MS }
      : {}),
  };
}
