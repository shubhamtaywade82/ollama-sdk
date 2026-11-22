import { OllamaClient, parseStructuredOutput } from '../../../src/index.js';
import { z } from 'zod';

const ProbeResultSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  latency_ms: z.number().nonnegative(),
});

async function main() {
  const host = process.env.OLLAMA_HOST || 'https://ollama.com';
  const apiKey = process.env.OLLAMA_API_KEY;
  const targetModel = process.env.OLLAMA_MODEL || 'glm-5.3-flash:cloud';

  console.log(`Connecting to Ollama Cloud at ${host}...`);
  if (!apiKey) {
    console.error('Error: OLLAMA_API_KEY environment variable is missing.');
    process.exit(1);
  }

  const client = new OllamaClient({
    baseUrl: host,
    apiKey,
    timeoutMs: 30_000,
  });

  try {
    const modelList = await client.models.list();
    console.log(`Discovered ${modelList.length} models on your Ollama Cloud subscription:`);
    for (const m of modelList) {
      console.log(`  • ${m.name}`);
    }
  } catch (err) {
    console.warn(`Note: Could not list models via /api/tags (${(err as Error).message}).`);
  }

  console.log(`Testing chat inference with model: ${targetModel}...`);
  const t0 = Date.now();
  const res = await client.chat({
    model: targetModel,
    stream: false,
    options: { temperature: 0, seed: 42 },
    messages: [
      {
        role: 'system',
        content:
          'Output ONLY valid JSON matching: {"status":"ok","service":"string","latency_ms":number}. Do not add commentary.',
      },
      { role: 'user', content: 'CI probe check.' },
    ],
  });

  const latency = Date.now() - t0;
  console.log(`Received response in ${latency}ms.`);
  console.log(`Raw output: ${res.message.content.trim()}`);

  const parsed = parseStructuredOutput(res.message.content, ProbeResultSchema);
  console.log('Successfully validated schema payload:', parsed);
  console.log('Ollama Cloud integration probe check PASSED.');
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
