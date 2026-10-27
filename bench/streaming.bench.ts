import { test } from 'vitest';
import { parseNdjsonStream } from '../src/streaming/ndjson.js';

interface ChatChunk {
  readonly model: string;
  readonly message: { readonly role: string; readonly content: string };
  readonly done: boolean;
}

function ndjsonBody(chunkCount: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk: ChatChunk = {
      model: 'qwen3.5:2b',
      message: { role: 'assistant', content: `token-${i} ` },
      done: i === chunkCount - 1,
    };
    lines.push(JSON.stringify(chunk));
  }
  const bytes = encoder.encode(lines.join('\n') + '\n');

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split into ~1KB frames to mimic real TCP/HTTP chunking rather than one giant read.
      const frameSize = 1024;
      for (let offset = 0; offset < bytes.length; offset += frameSize) {
        controller.enqueue(bytes.slice(offset, offset + frameSize));
      }
      controller.close();
    },
  });
}

async function consume(stream: ReadableStream<Uint8Array>): Promise<number> {
  let count = 0;
  for await (const _chunk of parseNdjsonStream<ChatChunk>(stream)) {
    count++;
  }
  return count;
}

test('parseNdjsonStream', async ({ bench }) => {
  bench('100 chunks', async () => {
    await consume(ndjsonBody(100));
  });

  bench('1,000 chunks', async () => {
    await consume(ndjsonBody(1_000));
  });

  bench('10,000 chunks', async () => {
    await consume(ndjsonBody(10_000));
  });
});
