/**
 * Speculative-decoding speedup measurement (Oct-12 digest "tomorrow's focus").
 *
 * Measures generation throughput with the runtime `draft_num_predict` option
 * at several settings (0 = drafting disabled, then 4/8/16) against a live
 * daemon, using `formatTelemetry` for the official tokens/second math.
 * Multiple samples per setting, median reported — noisy small-model runs
 * make single samples misleading.
 *
 * Requires a local Ollama serving a model whose distribution ships an
 * accompanying draft network (or embeds MTP tensors); otherwise the server
 * silently ignores the option and every setting measures the same. The
 * per-setting tok/s table makes that obvious at a glance.
 *
 *   OLLAMA_LOCAL_MODEL=gpt-oss:20b npx tsx lab/run.ts 15-speculative
 */

import { OllamaClient, formatTelemetry } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const PROMPT = 'Write a vivid one-paragraph description of a lighthouse in a storm. Be concrete.';

interface Sample {
  readonly tokensPerSecond: number;
  readonly totalLatencyMs: number;
}

interface SettingResult {
  readonly draftNumPredict: number;
  readonly medianTokensPerSecond: number;
  readonly medianLatencyMs: number;
  readonly samples: readonly number[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

async function sample(
  client: OllamaClient,
  model: string,
  draftNumPredict: number,
): Promise<Sample> {
  const response = await client.chat({
    model,
    messages: [{ role: 'user', content: PROMPT }],
    options: { draft_num_predict: draftNumPredict },
  });
  const t = formatTelemetry(response);
  return { tokensPerSecond: t.tokensPerSecond, totalLatencyMs: t.totalLatencyMs };
}

async function main(): Promise<void> {
  const env = getLabEnv();
  const model = env.localModel;
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const settings = [0, 4, 8, 16];
  const samplesPerSetting = 5;
  const start = Date.now();

  try {
    const results: SettingResult[] = [];
    for (const draft of settings) {
      // One warm-up request per setting (the first request pays model load).
      await sample(client, model, draft);
      const runs: Sample[] = [];
      for (let i = 0; i < samplesPerSetting; i++) {
        runs.push(await sample(client, model, draft));
      }
      results.push({
        draftNumPredict: draft,
        medianTokensPerSecond: median(runs.map((r) => r.tokensPerSecond)),
        medianLatencyMs: median(runs.map((r) => r.totalLatencyMs)),
        samples: runs.map((r) => r.tokensPerSecond),
      });
      const r = results.at(-1);
      console.log(
        `draft_num_predict=${String(draft).padStart(2)}: median ${r?.medianTokensPerSecond} tok/s | ${r?.medianLatencyMs}ms (samples: ${r?.samples.join(', ')})`,
      );
    }

    const baseline = results.find((r) => r.draftNumPredict === 0);
    console.log('\nThroughput vs drafting disabled:');
    for (const r of results) {
      const base = baseline?.medianTokensPerSecond ?? 0;
      const delta =
        base > 0 ? `${(((r.medianTokensPerSecond - base) / base) * 100).toFixed(1)}%` : 'n/a';
      console.log(
        `  draft_num_predict=${String(r.draftNumPredict).padStart(2)}: ${r.medianTokensPerSecond} tok/s (${delta})`,
      );
    }

    await labLogger.log({
      experimentId: '15-speculative-draft-speedup',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model,
      operation: 'chat+draft_num_predict',
      durationMs: Date.now() - start,
      response: { results },
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '15-speculative-draft-speedup',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model,
      operation: 'chat+draft_num_predict',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
    throw err;
  }
}

void main();
