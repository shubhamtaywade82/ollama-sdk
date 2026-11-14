import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
// context-async-hooks 3.x removed AsyncHooksContextManager; AsyncLocalStorageContextManager
// is its replacement and provides the same enable/disable/with/bind surface.
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OllamaClient } from '../src/client.js';
import { Agent } from '../src/agent/index.js';
import { defineTool, ToolRegistry } from '../src/tools/index.js';
import { withSpan } from '../src/telemetry/index.js';
import { z } from 'zod';

describe('OpenTelemetry instrumentation', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    // sdk-trace-base 2.x removed `addSpanProcessor`; span processors are passed through the provider config.
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    // Registers real async-boundary context propagation, matching what a Node OTel SDK
    // (e.g. `@opentelemetry/sdk-node`'s `NodeSDK`) sets up automatically in production —
    // without it, spans created after an `await` lose their parent.
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });

  afterEach(async () => {
    trace.disable();
    context.disable();
    contextManager.disable();
    await provider.shutdown();
  });

  it('withSpan records a span with attributes and leaves success status unset', async () => {
    const result = await withSpan('custom.op', { foo: 'bar', n: 1 }, async () => 'done');

    expect(result).toBe('done');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('custom.op');
    expect(spans[0]?.attributes['foo']).toBe('bar');
    expect(spans[0]?.attributes['n']).toBe(1);
    expect(spans[0]?.status.code).toBe(0); // Unset
  });

  it('withSpan records the exception and marks the span as an error on throw', async () => {
    await expect(
      withSpan('custom.failing-op', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(2); // Error
    expect(spans[0]?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('produces nested HTTP + endpoint-attempt + gen_ai spans for a non-streaming chat call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama3.2',
        created_at: '2026-08-16T00:00:00Z',
        message: { role: 'assistant', content: 'hi' },
        done: true,
        prompt_eval_count: 5,
        eval_count: 2,
      }),
    });

    const client = new OllamaClient({ fetch: fetchMock as never });
    await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'Ping' }],
      stream: false,
    });

    const spans = exporter.getFinishedSpans();
    const genAiSpan = spans.find((s) => s.name === 'chat llama3.2');
    const endpointSpan = spans.find((s) => s.name === 'ollama.endpoint.attempt');
    const httpSpan = spans.find((s) => s.name === 'POST /api/chat');

    expect(genAiSpan).toBeDefined();
    expect(genAiSpan?.attributes['gen_ai.system']).toBe('ollama');
    expect(genAiSpan?.attributes['gen_ai.request.model']).toBe('llama3.2');
    expect(genAiSpan?.attributes['gen_ai.response.model']).toBe('llama3.2');
    expect(genAiSpan?.attributes['gen_ai.usage.input_tokens']).toBe(5);
    expect(genAiSpan?.attributes['gen_ai.usage.output_tokens']).toBe(2);

    expect(endpointSpan).toBeDefined();
    expect(endpointSpan?.attributes['ollama.endpoint.name']).toBe('default');
    expect(endpointSpan?.parentSpanId).toBe(genAiSpan?.spanContext().spanId);

    expect(httpSpan).toBeDefined();
    expect(httpSpan?.attributes['http.request.method']).toBe('POST');
    expect(httpSpan?.attributes['http.response.status_code']).toBe(200);
    expect(httpSpan?.parentSpanId).toBe(endpointSpan?.spanContext().spanId);
  });

  it('templates high-cardinality blob digests out of the HTTP span name', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } });
    const client = new OllamaClient({ fetch: fetchMock as never });
    await client.checkBlob('sha256:abc123');

    const spans = exporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name.includes('/api/blobs/'));
    expect(httpSpan?.name).toBe('HEAD /api/blobs/{digest}');
    expect(httpSpan?.attributes['url.full']).toContain('sha256');
  });

  it('marks a failing HTTP request span as an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found' }),
    });
    const client = new OllamaClient({ fetch: fetchMock as never, retries: 0 });

    await expect(
      client.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name === 'POST /api/chat');
    expect(httpSpan?.status.code).toBe(2); // Error
  });

  it('produces an execute_tool span and marks it as an error when the tool fails', async () => {
    const failingTool = defineTool({
      name: 'always_fails',
      description: 'Always throws',
      schema: z.object({}),
      execute: () => {
        throw new Error('tool exploded');
      },
    });
    const registry = new ToolRegistry({ tools: [failingTool] });

    const result = await registry.executeToolCall({
      function: { name: 'always_fails', arguments: {} },
    });

    expect(result.success).toBe(false);
    const spans = exporter.getFinishedSpans();
    const toolSpan = spans.find((s) => s.name === 'execute_tool always_fails');
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.attributes['gen_ai.tool.name']).toBe('always_fails');
    expect(toolSpan?.status.code).toBe(2); // Error
    expect(toolSpan?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('produces invoke_agent -> ollama.agent.turn -> execute_tool span hierarchy', async () => {
    const echoTool = defineTool({
      name: 'echo',
      description: 'Echoes input',
      schema: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    });
    const registry = new ToolRegistry({ tools: [echoTool] });

    let call = 0;
    const chatClient = {
      chat: vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return {
            message: {
              role: 'assistant' as const,
              content: '',
              tool_calls: [{ function: { name: 'echo', arguments: { text: 'hi' } } }],
            },
          };
        }
        return { message: { role: 'assistant' as const, content: 'done' } };
      }),
    };

    const agent = new Agent(chatClient, { tools: registry });
    await agent.run({ model: 'llama3.2', messages: [{ role: 'user', content: 'go' }] });

    const spans = exporter.getFinishedSpans();
    const agentSpan = spans.find((s) => s.name === 'invoke_agent llama3.2');
    const turnSpans = spans.filter((s) => s.name === 'ollama.agent.turn');
    const toolSpan = spans.find((s) => s.name === 'execute_tool echo');

    expect(agentSpan).toBeDefined();
    expect(agentSpan?.attributes['ollama.agent.max_iterations']).toBe(10);
    expect(turnSpans).toHaveLength(2);
    expect(turnSpans[0]?.parentSpanId).toBe(agentSpan?.spanContext().spanId);
    expect(toolSpan?.parentSpanId).toBe(turnSpans[0]?.spanContext().spanId);
  });

  describe('context propagation across async boundaries', () => {
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));
    const finished = (name: string) => exporter.getFinishedSpans().find((s) => s.name === name);

    it('keeps the parent across awaits and timers', async () => {
      await withSpan('parent.op', {}, async () => {
        await tick();
        await Promise.resolve();
        await withSpan('child.op', {}, async () => 'ok');
      });

      expect(finished('child.op')?.parentSpanId).toBe(finished('parent.op')?.spanContext().spanId);
    });

    it('isolates parents between concurrent operations', async () => {
      await Promise.all([
        withSpan('a.parent', {}, async () => {
          await tick();
          await withSpan('a.child', {}, async () => 1);
        }),
        withSpan('b.parent', {}, async () => {
          await tick();
          await withSpan('b.child', {}, async () => 2);
        }),
      ]);

      expect(finished('a.child')?.parentSpanId).toBe(finished('a.parent')?.spanContext().spanId);
      expect(finished('b.child')?.parentSpanId).toBe(finished('b.parent')?.spanContext().spanId);
    });

    it('does not leak the span context out of withSpan', async () => {
      await withSpan('scoped.op', {}, async () => 'done');

      expect(trace.getActiveSpan()).toBeUndefined();
    });
  });
});
