import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OllamaClient } from '../src/client.js';
import { Agent } from '../src/agent/agent.js';
import { defineTool } from '../src/tools/define-tool.js';
import { ToolRegistry } from '../src/tools/registry.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('Concurrency slot lifecycle: streaming', () => {
  it('holds the endpoint slot until the stream is fully consumed, not just until it starts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ndjsonResponse([
        JSON.stringify({
          model: 'llama3',
          created_at: 't',
          message: { role: 'assistant', content: 'hi' },
          done: false,
        }),
        JSON.stringify({
          model: 'llama3',
          created_at: 't',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
        }),
      ]),
    );

    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      endpointHealth: { strategy: 'least-connections' },
      fetch: fetchMock as never,
    });

    const stream = await client.chatStream({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });

    // The HTTP response has arrived and the OllamaStream wrapper exists, but nothing has
    // consumed it yet — the slot must still be held (mirroring the real HTTP connection
    // still being open).
    expect(client.endpointStatus()[0]?.activeRequests).toBe(1);

    const events = [];
    for await (const event of stream) events.push(event);

    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(client.endpointStatus()[0]?.activeRequests).toBe(0);
  });

  it('releases the slot if stream consumption errors partway through', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ model: 'llama3', created_at: 't', message: { role: 'assistant', content: 'hi' }, done: false })}\n`,
          ),
        );
        controller.enqueue(encoder.encode('not valid json\n'));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
      );

    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      endpointHealth: { strategy: 'least-connections' },
      fetch: fetchMock as never,
    });

    const stream = await client.chatStream({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    expect(client.endpointStatus()[0]?.activeRequests).toBe(1);

    // OllamaStream surfaces a mid-stream failure as an `error`-type event within the
    // iteration (it does not throw out of `for await` itself) but still rejects
    // `finalResult` — which is exactly what the concurrency slot release is keyed off.
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    await expect(stream.finalResult).rejects.toThrow();

    expect(client.endpointStatus()[0]?.activeRequests).toBe(0);
  });
});

describe('Concurrency slot lifecycle: maxConcurrentPerEndpoint queueing', () => {
  it('runs N requests immediately across N one-slot accounts and queues the (N+1)th', async () => {
    const deferreds: Array<{ account: string; resolve: () => void }> = [];
    let fetchCallCount = 0;

    const fetchMock = vi
      .fn()
      .mockImplementation((_url: string, init: { headers?: Record<string, string> }) => {
        fetchCallCount++;
        const account = init.headers?.['Authorization'] ?? 'none';
        return new Promise((resolve) => {
          deferreds.push({
            account,
            resolve: () =>
              resolve({
                ok: true,
                status: 200,
                json: async () => ({
                  model: 'x',
                  created_at: 't',
                  message: { role: 'assistant', content: `ok:${account}` },
                  done: true,
                }),
              }),
          });
        });
      });

    const client = new OllamaClient({
      baseUrl: 'https://ollama.com',
      credentials: { a: { apiKey: 'KEY_A' }, b: { apiKey: 'KEY_B' } },
      endpointHealth: { strategy: 'least-connections', maxConcurrentPerEndpoint: 1 },
      fetch: fetchMock as never,
    });

    const p1 = client.chat({ model: 'm1', messages: [{ role: 'user', content: 'a' }] });
    const p2 = client.chat({ model: 'm2', messages: [{ role: 'user', content: 'b' }] });
    await flush();
    expect(fetchCallCount).toBe(2); // both accounts (1-slot each) now occupied

    const p3 = client.chat({ model: 'm3', messages: [{ role: 'user', content: 'c' }] });
    await flush();
    expect(fetchCallCount).toBe(2); // p3 queued — no account has spare capacity yet

    deferreds[0]?.resolve(); // free up whichever account served p1
    const r1 = await p1;
    await flush();
    expect(fetchCallCount).toBe(3); // p3 dequeued the moment a slot freed

    deferreds[1]?.resolve();
    deferreds[2]?.resolve();
    const [r2, r3] = await Promise.all([p2, p3]);

    // p1 and p3 land on the same account (whichever served p1, since it freed first) —
    // that's correct reuse, not a violation: the invariant is that fetchCallCount never
    // exceeded one in-flight call per account, which the assertions above already prove.
    expect(r1.message.content).toBe(`ok:${deferreds[0]?.account}`);
    expect(r3.message.content).toBe(r1.message.content);
    expect(r2.message.content).not.toBe(r1.message.content);
  });

  it('cancels a queued request via AbortSignal without ever calling fetch for it', async () => {
    const deferreds: Array<() => void> = [];
    let fetchCallCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      return new Promise((resolve) => {
        deferreds.push(() =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({
              model: 'x',
              created_at: 't',
              message: { role: 'assistant', content: 'ok' },
              done: true,
            }),
          }),
        );
      });
    });

    const client = new OllamaClient({
      endpoints: [{ name: 'only', baseUrl: 'http://only.local' }],
      endpointHealth: { strategy: 'least-connections', maxConcurrentPerEndpoint: 1 },
      fetch: fetchMock as never,
    });

    const p1 = client.chat({ model: 'm1', messages: [{ role: 'user', content: 'a' }] });
    await flush();
    expect(fetchCallCount).toBe(1);

    const controller = new AbortController();
    const p2 = client.chat({
      model: 'm2',
      messages: [{ role: 'user', content: 'b' }],
      signal: controller.signal,
    });
    await flush();
    expect(fetchCallCount).toBe(1); // p2 is queued, never reached fetch

    controller.abort();
    await expect(p2).rejects.toThrow();
    expect(fetchCallCount).toBe(1); // still never called for the cancelled request

    deferreds[0]?.();
    await p1;
  });
});

describe('Concurrency slot lifecycle: Agent tool execution', () => {
  it('does not hold an endpoint slot while a tool is executing between LLM turns', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'agent-model',
            created_at: 't',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'slow_tool', arguments: {} } }],
            },
            done: true,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'agent-model',
          created_at: 't',
          message: { role: 'assistant', content: 'done' },
          done: true,
        }),
      };
    });

    const client = new OllamaClient({
      endpoints: [{ name: 'only', baseUrl: 'http://only.local' }],
      endpointHealth: { strategy: 'least-connections' },
      fetch: fetchMock as never,
    });

    let sawActiveDuringTool: number | undefined;
    const slowTool = defineTool({
      name: 'slow_tool',
      description: 'A tool that takes a moment',
      schema: z.object({}),
      execute: async () => {
        sawActiveDuringTool = client.endpointStatus()[0]?.activeRequests;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true };
      },
    });

    const agent = new Agent(client, { tools: new ToolRegistry([slowTool]), maxIterations: 4 });
    const result = await agent.run({
      model: 'agent-model',
      messages: [{ role: 'user', content: 'do the thing' }],
    });

    expect(sawActiveDuringTool).toBe(0);
    expect(result.finalMessage.content).toBe('done');
    expect(client.endpointStatus()[0]?.activeRequests).toBe(0);
  });
});
