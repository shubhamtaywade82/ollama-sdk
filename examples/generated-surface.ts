/**
 * Generated-surface smoke example.
 *
 * Demonstrates the contract-first architecture from ADRs 0013-0019:
 *   - `OllamaRuntime` (the hand-written seam)
 *   - `NativeApi` (generated from the canonical IR)
 *   - Generated Zod schemas (paired with the TypeScript interfaces)
 *   - `OllamaClient.runtime` (the Wave 8 non-breaking bridge)
 *
 * Run with `npx tsx examples/generated-surface.ts` against a local
 * Ollama server (`ollama serve` in another terminal).
 *
 * NOTE: this example imports from `../src/...` because it runs from
 * the repo. Published consumers should import from
 *   '@nemesis-oss/ollama-sdk'
 *   '@nemesis-oss/ollama-sdk/generated/api'
 *   '@nemesis-oss/ollama-sdk/generated/models/schemas'
 * (see README.md "Contract-First Architecture" section).
 */
import { OllamaClient } from '../src/index.js';
import { NativeApi } from '../src/generated/api/index.js';
import { ChatRequestSchema } from '../src/generated/models/schemas.js';

async function main() {
  // 1. Existing OllamaClient surface — unchanged from before.
  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });

  // 2. Wave 8 bridge: `client.runtime` returns an OllamaRuntime sharing
  //    the client's HttpClient, middleware, retry, and telemetry.
  const runtime = client.runtime;

  // 3. Wave 3 generated API class — every method delegates to runtime.invoke.
  const api = new NativeApi(runtime);

  // 4. Validate user input with the generated Zod schema before sending.
  const userInput = {
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'Explain contract-first architecture in one sentence.' }],
    stream: false,
  };
  const parseResult = ChatRequestSchema.safeParse(userInput);
  if (!parseResult.success) {
    console.error('Input validation failed:', parseResult.error.issues);
    process.exit(1);
  }

  // 5. Make the call — the runtime enforces environment + version guards
  //    (local-only operations reject in cloud mode, version-gated operations
  //    fail fast when the server is too old) before any HTTP request is made.
  try {
    const response = await api.chat(parseResult.data);
    console.log('Response:', response.message?.content);
    console.log('Eval tokens:', response.eval_count);
    console.log(
      'Tokens/sec:',
      response.eval_duration
        ? (response.eval_count ?? 0) / (response.eval_duration / 1e9)
        : 'unknown',
    );
  } catch (err) {
    console.error('Call failed:', (err as Error).message);
    console.error('\nIs `ollama serve` running on http://localhost:11434?');
  }

  // 6. Streaming example — explicitly request `stream: true`.
  console.log('\n--- Streaming ---');
  try {
    const stream = await api.chat({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
      stream: true,
    });
    for await (const chunk of stream) {
      if (chunk.message?.content) {
        process.stdout.write(chunk.message.content);
      }
    }
    console.log();
  } catch (err) {
    console.error('Stream failed:', (err as Error).message);
  }

  // 7. The same runtime works for GET endpoints too.
  try {
    const version = await api.version();
    console.log('\nOllama version:', version.version);
  } catch (err) {
    console.error('Version check failed:', (err as Error).message);
  }
}

void main();
