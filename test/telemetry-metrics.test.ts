import { describe, expect, it } from 'vitest';
import { formatTelemetry } from '../src/telemetry/metrics.js';
import type { RawOllamaMetrics } from '../src/telemetry/metrics.js';
import type { ChatResponse, EmbedResponse, GenerateResponse } from '../src/types.js';

/**
 * Standardized telemetry normalization (Oct-10 digest): Ollama reports every
 * duration as an integer in nanoseconds; `formatTelemetry` derives the
 * human-scale summary — ms latencies, tokens/second per the official Usage-doc
 * formulas, and the KV cache-hit ratio under the SDK's house semantics
 * (`cached / (cached + evaluated)`, consistent with ConversationSession — the
 * naive `cached / prompt_eval_count` reports a *full* cache hit as 0, because
 * Ollama reports `prompt_eval_count: 0` then).
 */

describe('formatTelemetry', () => {
  it('derives every field from a full payload (hand-computed)', () => {
    const t = formatTelemetry({
      total_duration: 3_712_500_000, // 3712.5 ms
      load_duration: 250_000_000, // 250 ms
      prompt_eval_count: 200,
      prompt_eval_cached_count: 150,
      prompt_eval_duration: 1_000_000_000, // 1000 ms
      eval_count: 120,
      eval_duration: 2_400_000_000, // 2400 ms
    });
    expect(t).toEqual({
      totalLatencyMs: 3712.5,
      modelLoadMs: 250,
      promptEvalMs: 1000,
      generationMs: 2400,
      tokensPerSecond: 50, // 120 tokens / 2.4 s
      promptTokensPerSecond: 200, // 200 tokens / 1.0 s
      cacheHitRatio: 0.429, // 150 / (150 + 200) = 0.42857…
    });
  });

  it('treats an empty payload as all zeros — never NaN or Infinity', () => {
    expect(formatTelemetry({})).toEqual({
      totalLatencyMs: 0,
      modelLoadMs: 0,
      promptEvalMs: 0,
      generationMs: 0,
      tokensPerSecond: 0,
      promptTokensPerSecond: 0,
      cacheHitRatio: 0,
    });
  });

  it('formats partial payloads cleanly (stream final events, old servers)', () => {
    const t = formatTelemetry({ eval_count: 42, eval_duration: 2_000_000_000 });
    expect(t.totalLatencyMs).toBe(0);
    expect(t.modelLoadMs).toBe(0);
    expect(t.promptEvalMs).toBe(0);
    expect(t.generationMs).toBe(2000);
    expect(t.tokensPerSecond).toBe(21);
    expect(t.promptTokensPerSecond).toBe(0);
    expect(t.cacheHitRatio).toBe(0);
  });

  it('guards the rate math against zero durations and counts', () => {
    expect(formatTelemetry({ eval_count: 10, eval_duration: 0 }).tokensPerSecond).toBe(0);
    expect(formatTelemetry({ eval_count: 0, eval_duration: 5_000_000_000 }).tokensPerSecond).toBe(
      0,
    );
    expect(
      formatTelemetry({ prompt_eval_count: 10, prompt_eval_duration: 0 }).promptTokensPerSecond,
    ).toBe(0);
  });

  it('rounds ns→ms to two decimals and rates to one', () => {
    const t = formatTelemetry({
      total_duration: 1_234_567, // 1.234567 ms → 1.23
      eval_count: 7,
      eval_duration: 1_500_000_000, // 4.666… tok/s → 4.7
    });
    expect(t.totalLatencyMs).toBe(1.23);
    expect(t.tokensPerSecond).toBe(4.7);
  });

  it('reports a FULL cache hit as ratio 1.0 (house semantics, not cached/prompt_eval_count)', () => {
    // Ollama reports prompt_eval_count: 0 when the entire prompt was served
    // from the KV cache. cached / prompt_eval_count would divide by zero and
    // read as "no caching at all" — the denominator is the sum.
    const t = formatTelemetry({
      prompt_eval_count: 0,
      prompt_eval_cached_count: 500,
      prompt_eval_duration: 1_000_000,
    });
    expect(t.cacheHitRatio).toBe(1);
  });

  it('reports ratio 0 when both prompt counters are absent', () => {
    expect(formatTelemetry({ eval_count: 1, eval_duration: 1_000_000 }).cacheHitRatio).toBe(0);
  });

  it('computes the prompt rate from freshly evaluated tokens only', () => {
    // prompt_eval_count is the *evaluated* (uncached) portion — the same
    // semantics ConversationSession's cacheStats uses.
    const t = formatTelemetry({
      prompt_eval_count: 50,
      prompt_eval_cached_count: 950,
      prompt_eval_duration: 500_000_000, // 0.5 s
    });
    expect(t.promptTokensPerSecond).toBe(100); // 50 evaluated tokens / 0.5 s
  });

  it('accepts full response objects structurally, no picking required', () => {
    // No casts: the raw response interfaces are structurally assignable to
    // RawOllamaMetrics — this only compiles because the optional ns/counters
    // line up. That's the ergonomic point: pass the response, not a plucked
    // subset of it.
    const chat: ChatResponse = {
      model: 'llama3.2',
      created_at: '2026-10-10T00:00:00Z',
      message: { role: 'assistant', content: 'ok' },
      done: true,
      done_reason: 'stop',
      total_duration: 1_000_000_000,
      load_duration: 100_000_000,
      prompt_eval_count: 10,
      prompt_eval_duration: 200_000_000,
      eval_count: 30,
      eval_duration: 700_000_000,
    };
    const fromChat = formatTelemetry(chat);
    expect(fromChat.generationMs).toBe(700);
    expect(fromChat.modelLoadMs).toBe(100);

    const generate: GenerateResponse = {
      model: 'llama3.2',
      created_at: '2026-10-10T00:00:00Z',
      response: 'ok',
      done: true,
      eval_count: 30,
      eval_duration: 700_000_000,
    };
    expect(formatTelemetry(generate).tokensPerSecond).toBeCloseTo(42.9, 1);

    const embed: EmbedResponse = {
      model: 'nomic-embed-text',
      embeddings: [[0.1, 0.2]],
      total_duration: 500_000_000,
      load_duration: 250_000_000,
    };
    const fromEmbed = formatTelemetry(embed);
    expect(fromEmbed.totalLatencyMs).toBe(500);
    expect(fromEmbed.tokensPerSecond).toBe(0); // embeddings carry no eval counters
  });

  it('is pure — the input object is never mutated', () => {
    const raw: RawOllamaMetrics = { eval_count: 3, eval_duration: 300_000_000 };
    const snapshot = JSON.stringify(raw);
    formatTelemetry(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
