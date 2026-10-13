import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareDraftPerformance,
  type DraftBenchmarkClient,
  OllamaClient,
  OllamaClientError,
} from '../src/index.js';
import type { GenerateRequestOptions } from '../src/types.js';
import { createMockOllamaServer } from '../src/testing/index.js';

/**
 * `compareDraftPerformance` (Oct-13 digest) — the deterministic draft_num_predict
 * A/B benchmark. The whole suite runs daemonless against the public mock
 * server's request-aware `responder` routes: the scripted frames carry
 * eval_count/eval_duration counters, and throughput flows through
 * formatTelemetry exactly as it would against a live daemon.
 */

let server: ReturnType<typeof createMockOllamaServer>;

beforeEach(() => {
  server = createMockOllamaServer();
});

afterEach(async () => {
  await server.stop();
});

function generateFrame(opts: { evalCount: number; evalDurationNs: number }): string {
  return JSON.stringify({
    model: 'bench-model',
    created_at: '2026-10-13T00:00:00.000Z',
    response: 'benchmark output',
    done: true,
    eval_count: opts.evalCount,
    eval_duration: opts.evalDurationNs,
    total_duration: opts.evalDurationNs + 5_000_000,
  });
}

interface GenerateWireBody {
  options?: { draft_num_predict?: number; num_predict?: number; [key: string]: unknown };
  [key: string]: unknown;
}

function wireOptions(record: { body?: unknown }): GenerateWireBody['options'] {
  return (record.body as GenerateWireBody | undefined)?.options;
}

/** Draft-aware responder: baseline (draft 0) vs speculative (draft > 0). */
function registerDraftAwareRoute(
  baselineTps: number,
  speculativeTps: number,
  opts: { jitter?: readonly number[]; warmupCounts?: boolean } = {},
): void {
  const hits: Record<string, number> = {};
  server.register('/api/generate', {
    responder: (record) => {
      const draft = wireOptions(record)?.draft_num_predict ?? -1;
      const key = draft > 0 ? 'spec' : 'base';
      const i = (hits[key] = (hits[key] ?? 0) + 1);
      const jitter = opts.jitter?.[(i - 1) % opts.jitter.length] ?? 1;
      const tps = (draft > 0 ? speculativeTps : baselineTps) * jitter;
      return { chunks: [generateFrame({ evalCount: tps, evalDurationNs: 1_000_000_000 })] };
    },
  });
}

describe('compareDraftPerformance — measurement', () => {
  it('reports the scripted speedup: 200 tok/s drafting vs 100 tok/s baseline', async () => {
    registerDraftAwareRoute(100, 200);
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    const result = await compareDraftPerformance(client, {
      model: 'bench-model',
      prompt: 'Write a one-paragraph product description.',
    });

    expect(result.model).toBe('bench-model');
    expect(result.draftNumPredict).toBe(4); // default
    expect(result.baselineTokensPerSec).toBe(100);
    expect(result.speculativeTokensPerSec).toBe(200);
    expect(result.speedupMultiplier).toBe(2);
    expect(result.effectiveGain).toBe(true);
    expect(result.gainThreshold).toBe(1.05); // default
    expect(result.baseline.draftNumPredict).toBe(0);
    expect(result.speculative.draftNumPredict).toBe(4);
    expect(result.baseline.sampleTokensPerSecond).toHaveLength(5); // default samples
    expect(result.speculative.sampleTokensPerSecond).toHaveLength(5);
    expect(result.baseline.medianEvalDurationMs).toBe(1000);
    expect(result.speculative.medianEvalDurationMs).toBe(1000);
  });

  it('compares medians, not single samples (jittered throughput)', async () => {
    registerDraftAwareRoute(100, 200, {
      jitter: [0.9, 1.0, 1.1, 0.9, 1.0],
    });
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    const result = await compareDraftPerformance(client, {
      model: 'bench-model',
      prompt: 'p',
      warmup: false,
    });

    // baseline samples [90,100,110,90,100] → median 100; spec → median 200
    expect(result.baseline.sampleTokensPerSecond).toEqual([90, 100, 110, 90, 100]);
    expect(result.speculative.sampleTokensPerSecond).toEqual([180, 200, 220, 180, 200]);
    expect(result.baseline.medianTokensPerSecond).toBe(100);
    expect(result.speculative.medianTokensPerSecond).toBe(200);
    expect(result.speedupMultiplier).toBe(2);
  });

  it('median of an even sample count averages the middle pair', async () => {
    const perSide: Record<string, number> = {};
    const fake: DraftBenchmarkClient = {
      generate: async (req) => {
        const draft = req.options?.draft_num_predict ?? 0;
        const key = draft > 0 ? 'spec' : 'base';
        const i = (perSide[key] = (perSide[key] ?? 0) + 1);
        const start = draft > 0 ? 160 : 80;
        return {
          model: req.model,
          created_at: '2026-10-13T00:00:00.000Z',
          response: 'ok',
          done: true,
          eval_count: start + (i - 1) * 10,
          eval_duration: 1_000_000_000,
        };
      },
    };

    const result = await compareDraftPerformance(fake, {
      model: 'm',
      prompt: 'p',
      samples: 4,
      warmup: false,
    });

    // baseline [80,90,100,110] → (90+100)/2 = 95; spec [160,170,180,190] → (170+180)/2 = 175
    expect(result.baselineTokensPerSec).toBe(95);
    expect(result.speculativeTokensPerSec).toBe(175);
    expect(result.speedupMultiplier).toBe(1.84); // 175 / 95, 2dp
  });

  it('rounds reported rates to 1dp and the multiplier to 2dp', async () => {
    server.register('/api/generate', {
      responder: (record) => {
        const draft = wireOptions(record)?.draft_num_predict ?? -1;
        // baseline: 100 tok/s (100 tokens / 1s); spec: 100 tokens / 0.7s = 142.857…
        return draft > 0
          ? { chunks: [generateFrame({ evalCount: 100, evalDurationNs: 700_000_000 })] }
          : { chunks: [generateFrame({ evalCount: 100, evalDurationNs: 1_000_000_000 })] };
      },
    });
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    const result = await compareDraftPerformance(client, {
      model: 'bench-model',
      prompt: 'p',
      samples: 1,
      warmup: false,
    });

    expect(result.speculativeTokensPerSec).toBe(142.9); // formatTelemetry's 1dp
    expect(result.speedupMultiplier).toBe(1.43); // 142.9 / 100, 2dp
  });

  it('a gain below the threshold reports effectiveGain: false', async () => {
    registerDraftAwareRoute(100, 106);
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    const defaultResult = await compareDraftPerformance(client, { model: 'm', prompt: 'p' });
    expect(defaultResult.speedupMultiplier).toBe(1.06);
    expect(defaultResult.effectiveGain).toBe(true); // 1.06 > default 1.05

    const strictResult = await compareDraftPerformance(client, {
      model: 'm',
      prompt: 'p',
      gainThreshold: 1.1,
    });
    expect(strictResult.effectiveGain).toBe(false);
    expect(strictResult.gainThreshold).toBe(1.1);
  });
});

describe('compareDraftPerformance — wire protocol', () => {
  it('runs the deterministic protocol on the wire: temp 0, fixed seed, warm-up, per-side draft', async () => {
    registerDraftAwareRoute(100, 200);
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    await compareDraftPerformance(client, { model: 'bench-model', prompt: 'the prompt' });

    const generateCalls = server.requests.filter((r) => r.path === '/api/generate');
    expect(generateCalls).toHaveLength(12); // (1 warm-up + 5 samples) × 2 sides

    const warmups = generateCalls.filter((r) => wireOptions(r)?.num_predict === 1);
    const measured = generateCalls.filter((r) => wireOptions(r)?.num_predict === 256);
    expect(warmups).toHaveLength(2);
    expect(measured).toHaveLength(10);

    for (const call of measured) {
      expect(wireOptions(call)).toMatchObject({ temperature: 0, seed: 42, num_predict: 256 });
    }

    const baseline = measured.filter((r) => wireOptions(r)?.draft_num_predict === 0);
    const speculative = measured.filter((r) => wireOptions(r)?.draft_num_predict === 4);
    expect(baseline).toHaveLength(5);
    expect(speculative).toHaveLength(5);

    // Fixed order: every baseline request precedes every speculative request.
    const firstSpec = generateCalls.findIndex((r) => (wireOptions(r)?.draft_num_predict ?? 0) > 0);
    const lastBase = generateCalls
      .map((r) => wireOptions(r)?.draft_num_predict ?? 0)
      .lastIndexOf(0);
    expect(firstSpec).toBeGreaterThan(lastBase);

    for (const call of generateCalls) {
      expect(call.body).toMatchObject({ model: 'bench-model', prompt: 'the prompt' });
    }
  });

  it('warmup: false skips the throwaway runs', async () => {
    registerDraftAwareRoute(100, 200);
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    await compareDraftPerformance(client, { model: 'm', prompt: 'p', warmup: false });

    const generateCalls = server.requests.filter((r) => r.path === '/api/generate');
    expect(generateCalls).toHaveLength(10);
    expect(generateCalls.filter((r) => wireOptions(r)?.num_predict === 1)).toHaveLength(0);
  });

  it('forwards the abort signal to every generate call', async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    const fake: DraftBenchmarkClient = {
      generate: async (req) => {
        seenSignals.push(req.signal);
        return {
          model: req.model,
          created_at: '2026-10-13T00:00:00.000Z',
          response: 'ok',
          done: true,
          eval_count: 100,
          eval_duration: 1_000_000_000,
        };
      },
    };

    const controller = new AbortController();
    await compareDraftPerformance(fake, {
      model: 'm',
      prompt: 'p',
      samples: 2,
      warmup: false,
      signal: controller.signal,
    });
    expect(seenSignals).toHaveLength(4);
    expect(seenSignals.every((s) => s === controller.signal)).toBe(true);
  });
});

describe('compareDraftPerformance — guards', () => {
  it('rejects invalid option values with RangeError', async () => {
    const fake: DraftBenchmarkClient = {
      generate: async () => ({
        model: 'm',
        created_at: '2026-10-13T00:00:00.000Z',
        response: 'ok',
        done: true,
        eval_count: 1,
        eval_duration: 1_000_000,
      }),
    };

    await expect(
      compareDraftPerformance(fake, { model: 'm', prompt: 'p', draftNumPredict: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      compareDraftPerformance(fake, { model: 'm', prompt: 'p', samples: 0 }),
    ).rejects.toThrow(/samples/);
    await expect(
      compareDraftPerformance(fake, { model: 'm', prompt: 'p', numPredict: 0 }),
    ).rejects.toThrow(/numPredict/);
    await expect(
      compareDraftPerformance(fake, { model: 'm', prompt: 'p', seed: 1.5 }),
    ).rejects.toThrow(/seed/);
    await expect(
      compareDraftPerformance(fake, { model: 'm', prompt: 'p', gainThreshold: 0 }),
    ).rejects.toThrow(/gainThreshold/);
  });

  it('rejects immediately on a pre-aborted signal', async () => {
    const fake: DraftBenchmarkClient = {
      generate: async () => {
        throw new Error('generate must not be called');
      },
    };
    const controller = new AbortController();
    controller.abort();

    await expect(
      compareDraftPerformance(fake, { model: 'm', prompt: 'p', signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('raises OllamaClientError when every sample is unusable (no fabricated zeros)', async () => {
    server.register('/api/generate', {
      responder: () => ({
        chunks: [generateFrame({ evalCount: 0, evalDurationNs: 1_000_000_000 })],
      }),
    });
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    const promise = compareDraftPerformance(client, { model: 'm', prompt: 'p', warmup: false });
    await expect(promise).rejects.toBeInstanceOf(OllamaClientError);
    await expect(promise).rejects.toThrow(/draft_num_predict=0/);
    try {
      await promise;
    } catch (err) {
      expect((err as OllamaClientError).code).toBe('draft_benchmark_no_valid_samples');
    }
  });

  it('works with any structural DraftBenchmarkClient — OllamaClient is not required', async () => {
    const calls: GenerateRequestOptions[] = [];
    const fake: DraftBenchmarkClient = {
      generate: async (req) => {
        calls.push(req);
        return {
          model: req.model,
          created_at: '2026-10-13T00:00:00.000Z',
          response: 'ok',
          done: true,
          eval_count: 100,
          eval_duration: 1_000_000_000,
        };
      },
    };

    const result = await compareDraftPerformance(fake, {
      model: 'fake-model',
      prompt: 'p',
      samples: 3,
      warmup: false,
    });

    // Identical throughput on both sides: speedup 1.0 → no effective gain
    // (exactly what a model WITHOUT a draft network measures).
    expect(calls).toHaveLength(6);
    expect(result.baselineTokensPerSec).toBe(100);
    expect(result.speculativeTokensPerSec).toBe(100);
    expect(result.speedupMultiplier).toBe(1);
    expect(result.effectiveGain).toBe(false);
    for (const call of calls) {
      expect(call.options).toMatchObject({ temperature: 0, seed: 42, num_predict: 256 });
    }
  });
});
