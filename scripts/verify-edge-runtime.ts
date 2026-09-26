/**
 * Verifies the built ESM bundle (dist/index.js) is Edge Runtime-safe.
 *
 * Two checks, run against the actual shipped artifact rather than source:
 *
 * 1. Bundling: esbuild, targeting `platform: 'browser'`, bundles a small entry point
 *    that imports from dist/index.js. Browser-platform bundling refuses to resolve
 *    `node:*` imports (the same rejection Cloudflare Workers' and Vercel Edge
 *    Runtime's own build pipelines apply), so any Node-only code that leaked into the
 *    main entry fails this step with a clear "could not resolve" error.
 * 2. Execution: the resulting bundle is evaluated inside @edge-runtime/vm's EdgeVM — a
 *    real V8 context (via Node's `vm` module, the same mechanism Vercel's own Edge
 *    Runtime uses) that exposes only Web Standard globals (fetch, Request, Response,
 *    streams, crypto) and nothing Node-specific (no `process`, `Buffer`, `require`, or
 *    filesystem access). A full `OllamaClient` + `Agent` + `ToolRegistry` tool-calling
 *    round trip runs inside that sandbox against a mocked `fetch`, proving the SDK
 *    actually works with nothing but Web Standard APIs, not just that it fails to
 *    reference Node APIs.
 *
 * Run via `npm run verify:edge-runtime` after `npm run build`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { EdgeVM } from '@edge-runtime/vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = join(__dirname, '..', 'dist', 'index.js');

const SMOKE_TEST_ENTRY = `
import { z } from 'zod';
import { OllamaClient, Agent, ToolRegistry, defineTool } from ${JSON.stringify(distEntry)};

globalThis.__EDGE_SMOKE_TEST__ = async function runEdgeSmokeTest() {
  let callCount = 0;
  const mockFetch = async (url) => {
    if (url.endsWith('/api/show')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          details: {
            format: 'gguf',
            family: 'llama',
            parameter_size: '8B',
            quantization_level: 'Q4_K_M',
          },
          capabilities: ['completion', 'tools'],
          model_info: { 'llama.context_length': 32768 },
        }),
      };
    }
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'llama3.2',
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'echo', arguments: { text: 'hi' } } }],
          },
          done: true,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama3.2',
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'pong: hi' },
        done: true,
        prompt_eval_count: 4,
        eval_count: 2,
      }),
    };
  };

  const client = new OllamaClient({ fetch: mockFetch });

  const echoTool = defineTool({
    name: 'echo',
    description: 'Echoes input text',
    schema: z.object({ text: z.string() }),
    execute: ({ text }) => 'echo:' + text,
  });
  const registry = new ToolRegistry({ tools: [echoTool] });
  const agent = new Agent(client, { tools: registry, maxIterations: 3 });

  const result = await agent.run({
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'say hi via the echo tool' }],
  });

  if (result.finalMessage.content !== 'pong: hi') {
    throw new Error('unexpected final message: ' + result.finalMessage.content);
  }
  if (result.totalIterations !== 2) {
    throw new Error('expected 2 agent iterations, got ' + result.totalIterations);
  }
  const toolResult = result.turns[0]?.toolResults?.[0];
  if (!toolResult || toolResult.outputString !== 'echo:hi') {
    throw new Error('tool execution result mismatch: ' + JSON.stringify(toolResult));
  }

  return 'ok';
};
`;

async function main(): Promise<void> {
  if (!existsSync(distEntry)) {
    console.error('dist/index.js not found — run "npm run build" first.');
    process.exitCode = 1;
    return;
  }

  console.log('[1/2] Bundling dist/index.js for a browser/edge target with esbuild...');
  const result = await build({
    stdin: {
      contents: SMOKE_TEST_ENTRY,
      resolveDir: dirname(distEntry),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });

  const bundle = result.outputFiles[0]?.text;
  if (!bundle) {
    throw new Error('esbuild produced no output.');
  }
  console.log(
    `      Bundled OK: ${(bundle.length / 1024).toFixed(1)} KB, no Node.js built-ins resolved.`,
  );

  console.log('[2/2] Executing bundle inside a sandboxed Edge Runtime VM (@edge-runtime/vm)...');
  const vm = new EdgeVM();
  vm.evaluate(bundle);
  const outcome = await vm.evaluate<Promise<string>>('globalThis.__EDGE_SMOKE_TEST__()');

  if (outcome !== 'ok') {
    throw new Error(`Unexpected result from edge VM smoke test: ${String(outcome)}`);
  }

  console.log('      OllamaClient + Agent + ToolRegistry ran correctly with zero Node.js APIs.');
  console.log('\nEdge runtime verification passed.');
}

main().catch((err: unknown) => {
  console.error('\nEdge runtime verification FAILED:');
  console.error(err);
  process.exitCode = 1;
});
