/**
 * Testing your integration with the in-memory mock server
 * (`@nemesis-oss/ollama-sdk/testing`, ADR 0029) — the SDK's own engine,
 * promoted public. Zero network, zero daemon, deterministic in CI.
 *
 * Default routes already answer the official liveness probe and
 * `/api/version`; register scriptable NDJSON routes for the rest, inject
 * in-band mid-stream errors, and assert on the recorded wire traffic.
 *
 * This file runs the demo end-to-end without any server running:
 *
 *   npm run example examples/testing-mock-server.ts
 */
import { OllamaClient } from '../src/index.js';
import {
  createMockOllamaServer,
  mockTextChunks,
  mockToolCallChunks,
} from '../src/testing/index.js';

async function main() {
  const server = createMockOllamaServer();
  await server.start();

  try {
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    // 1. Defaults answer out of the box: the official liveness probe.
    const ping = await client.ping();
    console.log(`ping: healthy=${ping.healthy} latency=${ping.latencyMs}ms`);

    // 2. A plain-text streaming reply, chunked.
    server.register('/api/chat', {
      chunks: mockTextChunks('Mock replies need no GPU.', { chunkSize: 8 }),
    });
    const stream = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data.delta);
    }
    console.log(`streamed reply: "${tokens.join('')}"`);

    // 3. Parallel tool calls in one frame — the documented native shape.
    server.register('/api/chat', {
      chunks: mockToolCallChunks([
        { name: 'get_weather', arguments: { city: 'Tokyo' } },
        { name: 'get_time', arguments: { tz: 'Asia/Tokyo' } },
      ]),
    });
    const toolStream = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'weather and time?' }],
      stream: true,
    });
    const toolNames: string[] = [];
    for await (const event of toolStream) {
      if (event.type === 'tool_call') toolNames.push(event.data.toolCall.function.name);
    }
    console.log(`tool calls: ${toolNames.join(', ')} (parallel)`);

    // 4. Mid-stream failure — GPU OOM style: HTTP 200, an {"error": "..."}
    //    frame where the done frame would be, no clean termination.
    server.register('/api/chat', {
      chunks: mockTextChunks('partial answer that never finishes'),
      injectErrorFrame: { message: 'CUDA out of memory' },
    });
    const failing = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const partial: string[] = [];
    for await (const event of failing) {
      if (event.type === 'token') partial.push(event.data.delta);
      if (event.type === 'error') break;
    }
    console.log(`in-band error recovered after "${partial.join('')}"`);

    // 5. Wire-level assertions: every request was recorded.
    console.log(`recorded ${server.requests.length} requests:`);
    for (const record of server.requests) {
      console.log(`  ${record.method} ${record.path}`);
    }
  } finally {
    await server.stop();
  }
}

void main();
