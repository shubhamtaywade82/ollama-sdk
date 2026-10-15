/**
 * Model pull progress with speed & ETA — `onProgress()` plus the raw-stream
 * `createProgressSpeedTracker()` (see ADR 0033).
 *
 * Two consumption styles, one mock pull:
 *   1. `onProgress(stream, cb)` — the callback path for progress bars: every
 *      event carries `percent` plus per-layer `bytesPerSecond` / `etaSeconds`.
 *   2. The raw stream + your own tracker — for structured logging or custom
 *      dashboards that iterate the typed `OllamaStream` themselves.
 *
 * Daemonless: the SDK's own mock server (`/testing`, ADR 0029) plays the
 * Ollama registry, emitting realistic NDJSON progress frames (two layers,
 * manifest, verification, success) — no daemon, no network:
 *
 *   npm run example examples/model-pull-progress.ts
 */
import { OllamaClient, onProgress, createProgressSpeedTracker } from '../src/index.js';
import { createMockOllamaServer } from '../src/testing/index.js';

/** Render one progress line, the way a CLI pull bar would. */
function progressBar(completed: number, total: number, width = 24): string {
  const filled = Math.round((completed / total) * width);
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

function mib(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MiB/s`;
}

async function main() {
  const server = createMockOllamaServer();

  // A realistic pull timeline: manifest, two layers (with a small delay so
  // the speed readings are non-trivial), verification, success.
  const frames = [
    JSON.stringify({ status: 'pulling manifest' }),
    JSON.stringify({
      status: 'downloading',
      digest: 'sha256:layer1',
      total: 4_000_000,
      completed: 0,
    }),
    JSON.stringify({
      status: 'downloading',
      digest: 'sha256:layer1',
      total: 4_000_000,
      completed: 1_200_000,
    }),
    JSON.stringify({
      status: 'downloading',
      digest: 'sha256:layer1',
      total: 4_000_000,
      completed: 2_600_000,
    }),
    JSON.stringify({
      status: 'downloading',
      digest: 'sha256:layer1',
      total: 4_000_000,
      completed: 4_000_000,
    }),
    JSON.stringify({ status: 'verifying sha256 digest', digest: 'sha256:layer1' }),
    JSON.stringify({
      status: 'downloading',
      digest: 'sha256:layer2',
      total: 1_500_000,
      completed: 300_000,
    }),
    JSON.stringify({
      status: 'downloading',
      digest: 'sha256:layer2',
      total: 1_500_000,
      completed: 1_500_000,
    }),
    JSON.stringify({
      status: 'writing manifest',
      digest: 'sha256:manifest',
      total: 348,
      completed: 348,
    }),
    JSON.stringify({ status: 'success' }),
  ];
  server.register('/api/pull', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
    chunks: frames,
    chunkDelayMs: 120, // let each layer's speed reading stabilize
  });
  await server.start();

  const client = new OllamaClient({ baseUrl: server.baseUrl });

  try {
    // ── Style 1: onProgress callback — the progress-bar path ────────────
    console.log('— onProgress() —');
    const stream = await client.models.pull({ model: 'llama3.2', stream: true });
    const result = await onProgress(stream, (event) => {
      if (event.percent === undefined) {
        console.log(`  ${event.status}`);
        return;
      }
      const speed = event.bytesPerSecond ? ` ${mib(event.bytesPerSecond)}` : '';
      const eta = event.etaSeconds ? `, ETA ${Math.ceil(event.etaSeconds)}s` : '';
      console.log(
        `  ${progressBar(event.completed ?? 0, event.total ?? 1)} ${event.percent
          .toFixed(2)
          .padStart(6)}%${speed}${eta}  (${event.digest?.slice(0, 19) ?? '-'})`,
      );
    });
    console.log(`  done: ${result.status}\n`);

    // ── Style 2: raw stream + your own tracker — the logger path ────────
    console.log('— raw stream + createProgressSpeedTracker() —');
    const speed = createProgressSpeedTracker();
    const stream2 = await client.models.pull({ model: 'llama3.2', stream: true });
    for await (const event of stream2) {
      if (event.type === 'message') {
        const chunk = event.data.chunk;
        const { bytesPerSecond, etaSeconds } = speed(chunk);
        if (chunk.completed !== undefined && bytesPerSecond !== undefined) {
          // structured-log shape — every field, one line
          console.log(
            `  {"layer":"${chunk.digest?.slice(7, 19) ?? '-'}","completed":${chunk.completed},"speed":${Math.round(
              bytesPerSecond,
            )},"etaMs":${etaSeconds === undefined ? 'null' : Math.round(etaSeconds * 1000)}}`,
          );
        }
      }
    }
  } finally {
    await client.destroy();
    await server.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
