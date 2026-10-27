import { test } from 'vitest';
import { OllamaClient } from '../src/client.js';

const chatResponseBody = JSON.stringify({
  model: 'qwen3.5:2b',
  created_at: new Date().toISOString(),
  message: { role: 'assistant', content: 'Hello there!' },
  done: true,
  prompt_eval_count: 8,
  eval_count: 4,
});

async function instantFetch(): Promise<Response> {
  return new Response(chatResponseBody, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('OllamaClient.chat (mocked network, single endpoint)', async ({ bench }) => {
  const client = new OllamaClient({ fetch: instantFetch as typeof fetch });

  bench('non-streaming chat call', async () => {
    await client.chat({
      model: 'qwen3.5:2b',
      messages: [{ role: 'user', content: 'Say hi' }],
      stream: false,
    });
  });
});

test('OllamaClient.chat (mocked network, 3-endpoint failover registry)', async ({ bench }) => {
  const client = new OllamaClient({
    endpoints: [
      { name: 'a', baseUrl: 'http://a.local:11434', priority: 3 },
      { name: 'b', baseUrl: 'http://b.local:11434', priority: 2 },
      { name: 'c', baseUrl: 'http://c.local:11434', priority: 1 },
    ],
    fetch: instantFetch as typeof fetch,
  });

  bench('non-streaming chat call, no failures', async () => {
    await client.chat({
      model: 'qwen3.5:2b',
      messages: [{ role: 'user', content: 'Say hi' }],
      stream: false,
    });
  });
});
