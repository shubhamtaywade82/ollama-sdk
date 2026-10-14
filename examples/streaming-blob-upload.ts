/**
 * Streaming blob uploads — multi-gigabyte GGUFs without heap exhaustion
 * (createBlobFromStream + streaming createBlobFromFile; see ADR 0032).
 *
 * Two uploads, zero bulk buffering:
 *   1. `createBlobFromFile` — the SDK streams BOTH passes (the SHA-256 hash,
 *      then the POST body) in 256 KiB chunks; peak heap is O(chunk), never
 *      O(file), so multi-GB weights never enter the Node heap.
 *   2. `createBlobFromStream` — you own the bytes (a chunk generator here; a
 *      WASM/SharedArrayBuffer producer in real pipelines): pass the digest
 *      you computed and the stream goes straight into `fetch` (the transport
 *      sets `duplex: 'half'`, which Node's undici requires for stream bodies).
 *
 * Daemonless: the SDK's own mock server (`/testing`, ADR 0029) plays the
 * Ollama node, so this runs end-to-end with no GPU, no daemon, no network:
 *
 *   npm run example examples/streaming-blob-upload.ts
 */
import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaClient } from '../src/index.js';
import { createMockOllamaServer } from '../src/testing/index.js';

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function main() {
  const server = createMockOllamaServer();
  // A stand-in "weights file" — deterministic bytes so the digest is stable.
  // 1 MiB forces multiple 256 KiB chunks through both streaming passes.
  const weights = new Uint8Array(1024 * 1024);
  for (let i = 0; i < weights.length; i += 1) {
    weights[i] = (i * 31 + 7) & 0xff;
  }
  const digest = sha256(weights);
  const blobRoute = `/api/blobs/${encodeURIComponent(digest)}`;

  // Request-aware route: HEAD answers "do you already have this blob?",
  // POST receives the streamed bytes (the server verifies content against
  // the digest in the URL — that's the content-addressed protocol).
  let uploaded = false;
  server.register(blobRoute, {
    responder: (record) => {
      if (record.method === 'HEAD') {
        return { status: uploaded ? 200 : 404 };
      }
      uploaded = true;
      return { status: 200 };
    },
  });
  await server.start();

  const weightsPath = join(tmpdir(), 'streaming-blob-example.gguf');
  try {
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    // 1. File-based: streaming hash pass + streaming upload pass.
    await writeFile(weightsPath, weights);
    const fromFile = await client.models.createBlobFromFile(weightsPath);
    console.log(
      `createBlobFromFile:  digest=${fromFile.digest.slice(0, 22)}… alreadyExisted=${fromFile.alreadyExisted} fileName=${fromFile.fileName}`,
    );
    console.log(
      '  (both passes streamed in 256 KiB chunks — the file never sat in the heap whole)',
    );

    // 2. Stream-based: caller-built ReadableStream, digest known up front.
    const CHUNK = 256 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < weights.length; offset += CHUNK) {
          controller.enqueue(weights.subarray(offset, Math.min(offset + CHUNK, weights.length)));
        }
        controller.close();
      },
    });
    const fromStream = await client.models.createBlobFromStream(digest, stream);
    console.log(
      `createBlobFromStream: alreadyExisted=${fromStream.alreadyExisted} (content-addressed dedupe — the server kept the first upload)`,
    );

    // 3. What actually went over the wire.
    const wire = server.requests.filter((r) => r.path === blobRoute).map((r) => `${r.method}`);
    console.log(`wire log: ${wire.join(' -> ')}`);
  } finally {
    await rm(weightsPath, { force: true }).catch(() => undefined);
    await server.stop();
  }
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
