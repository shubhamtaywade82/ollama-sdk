/**
 * Web search agent (https://docs.ollama.com/capabilities/web-search#building-a-search-agent).
 *
 * `createWebTools` exposes Ollama Cloud's hosted /api/web_search and /api/web_fetch as
 * model-callable tools; the Agent runs the tool loop. Web calls always go to
 * https://ollama.com and need an API key; inference uses the local server here.
 *
 *   ollama pull qwen3:4b
 *   OLLAMA_API_KEY=... npm run example examples/web-search-agent.ts
 */
import { Agent, OllamaClient, ToolRegistry, createWebTools } from '../src/index.js';

async function main() {
  if (!process.env.OLLAMA_API_KEY) {
    console.error('Set OLLAMA_API_KEY (https://ollama.com/settings/keys) to use web search.');
    process.exitCode = 1;
    return;
  }

  const client = new OllamaClient({
    baseUrl: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    apiKey: process.env.OLLAMA_API_KEY,
  });

  const agent = new Agent(client, {
    tools: new ToolRegistry(createWebTools(client, { maxOutputChars: 8000, defaultMaxResults: 3 })),
    maxIterations: 8,
    maxRepeatedToolCalls: 2,
    hooks: {
      onToolCallStart: (call) => console.log(`→ ${call.function.name}`, call.function.arguments),
    },
  });

  try {
    const result = await agent.run({
      model: process.env.MODEL ?? 'qwen3:4b',
      messages: [{ role: 'user', content: "what is ollama's new engine" }],
      think: true,
    });
    console.log('\n' + result.finalMessage.content);
    console.log(`\n(${result.totalIterations} iterations)`);
  } finally {
    client.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
