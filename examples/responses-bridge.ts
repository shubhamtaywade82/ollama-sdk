/**
 * Dual-mode OpenAI Responses API bridge (see src/responses.ts).
 *
 * Works against Ollama >= v0.13.3 (native /v1/responses) AND older servers
 * (transparent /api/chat fallback).
 *
 *   npm run example examples/responses-bridge.ts
 */
import { OllamaClient } from '../src/index.js';

async function main() {
  const client = new OllamaClient();

  const res = await client.responses.create({
    model: 'qwen3:8b',
    input: 'Explain KV-cache prefix reuse in exactly two sentences.',
    instructions: 'You are a precise systems engineer.',
    max_output_tokens: 200,
  });

  console.log('[create]  transport:', res.transport); // 'native' | 'chat-adapter'
  console.log('[create]  output_text:', res.output_text);
  console.log('[create]  usage:', res.usage);

  console.log('\n[stream] deltas:');
  for await (const event of client.responses.stream({
    model: 'qwen3:8b',
    input: 'Now say the same thing as a haiku.',
    think: false,
  })) {
    if (event.type === 'text_delta') process.stdout.write(event.delta);
    else if (event.type === 'done') {
      console.log(
        `\n[stream] done — transport: ${event.response.transport}, usage:`,
        event.response.usage,
      );
    }
  }
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
