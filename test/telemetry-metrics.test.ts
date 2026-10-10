import { describe, expect, it } from 'vitest';
import { formatTelemetry, type RawOllamaMetrics } from '../src/telemetry/metrics.js';
import { formatTelemetry as fromIndex } from '../src/index.js';
import type { ChatResponse } from '../src/types.js';

describe('formatTelemetry', () => {
  it('converts nanosecond durations to milliseconds with 2 decimals', () => {
    const t = formatTelemetry({
      total_duration: 1_234_567_891,
      load_duration: 5_555_555,
      prompt_eval_duration: 100_004_999,
      eval_duration: 999_999,
    });
    expect(t.totalLatencyMs).toBe(1234.57);
    expect(t.modelLoadMs).toBe(5.56);
    expect(t.promptEvalMs).toBe(100);
    expect(t.generationMs).toBe(1);
  });

  it('computes tokens/second with the official eval_count / (eval_duration / 1e9) formula', () => {
    const t = formatTelemetry({ eval_count: 250, eval_duration: 2_000_000_000 });
    expect(t.tokensPerSecond).toBe(125);
  });

  it('rounds throughput to 1 decimal', () => {
    const t = formatTelemetry({ eval_count: 100, eval_duration: 3_000_000_000 });
    expect(t.tokensPerSecond).toBe(33.3);
  });

  it('computes prompt (pre-fill) throughput from freshly evaluated tokens', () => {
    const t = formatTelemetry({ prompt_eval_count: 512, prompt_eval_duration: 250_000_000 });
    expect(t.promptTokensPerSecond).toBe(2048);
  });

  it('cacheHitRatio uses cached / (cached + evaluated)', () => {
    const t = formatTelemetry({ prompt_eval_count: 25, prompt_eval_cached_count: 75 });
    expect(t.cacheHitRatio).toBe(0.75);
  });

  it('reports a full cache hit as 1, even though Ollama sends prompt_eval_count: 0', () => {
    const t = formatTelemetry({ prompt_eval_count: 0, prompt_eval_cached_count: 900 });
    expect(t.cacheHitRatio).toBe(1);
    expect(t.promptTokensPerSecond).toBe(0);
  });

  it('rounds cacheHitRatio to 3 decimals', () => {
    expect(
      formatTelemetry({ prompt_eval_count: 2, prompt_eval_cached_count: 1 }).cacheHitRatio,
    ).toBe(0.333);
  });

  it('treats every missing counter as 0 — never NaN or Infinity', () => {
    const t = formatTelemetry({});
    for (const value of Object.values(t)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(0);
    }
  });

  it('does not divide by a zero or missing duration', () => {
    const t = formatTelemetry({ eval_count: 10, eval_duration: 0, prompt_eval_count: 10 });
    expect(t.tokensPerSecond).toBe(0);
    expect(t.promptTokensPerSecond).toBe(0);
  });

  it('accepts a full ChatResponse structurally, without plucking fields', () => {
    const res: ChatResponse = {
      model: 'llama3.2',
      created_at: '2026-10-10T00:00:00Z',
      message: { role: 'assistant', content: 'hi' },
      done: true,
      total_duration: 2_000_000_000,
      eval_count: 40,
      eval_duration: 1_000_000_000,
    };
    expect(formatTelemetry(res).tokensPerSecond).toBe(40);
  });

  it('is pure: the input is not mutated and repeated calls agree', () => {
    const raw: RawOllamaMetrics = Object.freeze({ eval_count: 5, eval_duration: 1e9 });
    expect(formatTelemetry(raw)).toEqual(formatTelemetry(raw));
  });

  it('is exported from the package root', () => {
    expect(fromIndex).toBe(formatTelemetry);
  });
});
