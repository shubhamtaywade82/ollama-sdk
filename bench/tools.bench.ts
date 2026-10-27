import { test } from 'vitest';
import { z } from 'zod';
import { defineTool, ToolRegistry } from '../src/tools/index.js';

const addTool = defineTool({
  name: 'add',
  description: 'Adds two numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }) => a + b,
});

const registry = new ToolRegistry({ tools: [addTool] });
const call = { function: { name: 'add', arguments: { a: 1, b: 2 } } };

test('ToolRegistry.executeToolCall', async ({ bench }) => {
  bench('single call (includes the withSpan/OTel wrapper on the hot path)', async () => {
    await registry.executeToolCall(call);
  });
});

test('ToolRegistry.executeToolCalls', async ({ bench }) => {
  const calls = Array.from({ length: 20 }, () => call);

  bench('20 calls, unbounded concurrency', async () => {
    await registry.executeToolCalls(calls);
  });

  const boundedRegistry = new ToolRegistry({ tools: [addTool], maxConcurrency: 4 });
  bench('20 calls, maxConcurrency 4', async () => {
    await boundedRegistry.executeToolCalls(calls);
  });
});
