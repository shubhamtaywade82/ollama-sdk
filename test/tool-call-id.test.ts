import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OllamaClient } from '../src/client.js';
import { Agent } from '../src/agent/agent.js';
import { defineTool, ToolRegistry } from '../src/tools/index.js';
import { ensureToolCallIds, generateToolCallId } from '../src/tools/tool-call-id.js';

describe('generateToolCallId / ensureToolCallIds', () => {
  it('generates unique, non-empty ids', () => {
    const a = generateToolCallId();
    const b = generateToolCallId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('leaves an already-present id untouched', () => {
    const [tc] = ensureToolCallIds([{ id: 'existing', function: { name: 'x', arguments: {} } }])!;
    expect(tc!.id).toBe('existing');
  });

  it('assigns an id only to entries missing one', () => {
    const result = ensureToolCallIds([
      { id: 'existing', function: { name: 'a', arguments: {} } },
      { function: { name: 'b', arguments: {} } },
    ])!;
    expect(result[0]!.id).toBe('existing');
    expect(result[1]!.id).toBeDefined();
    expect(result[1]!.id).not.toBe('existing');
  });

  it('passes through undefined/empty input unchanged', () => {
    expect(ensureToolCallIds(undefined)).toBeUndefined();
    expect(ensureToolCallIds([])).toEqual([]);
  });
});

describe('ToolRegistry result.toolCallId', () => {
  const echoTool = defineTool({
    name: 'echo',
    description: 'Echoes input',
    schema: z.object({ text: z.string() }),
    execute: ({ text }) => text,
  });

  it('echoes the originating call id on success', async () => {
    const registry = new ToolRegistry({ tools: [echoTool] });
    const result = await registry.executeToolCall({
      id: 'call_abc',
      function: { name: 'echo', arguments: { text: 'hi' } },
    });
    expect(result.success).toBe(true);
    expect(result.toolCallId).toBe('call_abc');
  });

  it('echoes the originating call id on failure', async () => {
    const registry = new ToolRegistry({ tools: [echoTool] });
    const result = await registry.executeToolCall({
      id: 'call_def',
      function: { name: 'nonexistent', arguments: {} },
    });
    expect(result.success).toBe(false);
    expect(result.toolCallId).toBe('call_def');
  });

  it('leaves toolCallId undefined when the call had no id', async () => {
    const registry = new ToolRegistry({ tools: [echoTool] });
    const result = await registry.executeToolCall({
      function: { name: 'echo', arguments: { text: 'hi' } },
    });
    expect(result.toolCallId).toBeUndefined();
  });
});

describe('OllamaClient.chat assigns tool call ids', () => {
  it('assigns ids to tool calls in a non-streaming response that has none', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama3.2',
        created_at: '2026-08-17T00:00:00Z',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'a', arguments: {} } },
            { function: { name: 'b', arguments: {} } },
          ],
        },
        done: true,
      }),
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const res = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    const ids = res.message.tool_calls!.map((tc) => tc.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('OllamaClient.chatStream assigns stable tool call ids', () => {
  it('gives the streamed tool_call event and the final aggregated message the same id', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      { model: 'llama3.2', message: { role: 'assistant', content: '' }, done: false },
      {
        model: 'llama3.2',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'echo', arguments: { text: 'hi' } } }],
        },
        done: false,
      },
      { model: 'llama3.2', message: { role: 'assistant', content: '' }, done: true },
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(JSON.stringify(chunk) + '\n'));
        }
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const stream = await client.chatStream({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
    });

    let streamedId: string | undefined;
    for await (const event of stream) {
      if (event.type === 'tool_call') {
        streamedId = event.data.toolCall.id;
      }
    }
    const final = await stream.finalResult;
    const finalId = final.message.tool_calls?.[0]?.id;

    expect(streamedId).toBeDefined();
    expect(finalId).toBe(streamedId);
  });
});

describe('Agent tool_call_id correlation', () => {
  it('tags the role:"tool" history entry with the originating call id', async () => {
    const echoTool = defineTool({
      name: 'echo',
      description: 'Echoes input',
      schema: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    });
    const registry = new ToolRegistry({ tools: [echoTool] });

    let call = 0;
    // Deliberately returns tool_calls WITHOUT an id, like a custom (non-OllamaClient)
    // AgentChatClient would if it didn't know about this SDK's id convention.
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
    const result = await agent.run({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'go' }],
    });

    const assignedId = result.turns[0]?.toolCalls?.[0]?.id;
    expect(assignedId).toBeDefined();

    const toolMessage = result.turns[0]?.toolResults?.[0];
    expect(toolMessage?.toolCallId).toBe(assignedId);
  });
});


describe('Native Ollama tool-result protocol', () => {
  it('uses tool_name and does not send SDK-only tool_call_id in an Agent turn', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2026-09-24T00:00:00Z',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'echo', arguments: { text: 'hi' } } },
            ],
          },
          done: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          model: 'llama3.2',
          created_at: '2026-09-24T00:00:01Z',
          message: {
            role: 'assistant',
            content: 'done',
          },
          done: true,
        }),
      });

    const registry = new ToolRegistry([
      defineTool({
        name: 'echo',
        description: 'Echoes input',
        schema: z.object({ text: z.string() }),
        execute: ({ text }) => text,
      }),
    ]);
    const client = new OllamaClient({ fetch: fetchMock as never });
    const agent = new Agent(client, { tools: registry });

    await agent.run({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'go' }],
    });

    const secondRequestBody = JSON.parse(
      String(fetchMock.mock.calls[1]![1]!.body),
    ) as {
      messages: Array<Record<string, unknown>>;
    };
    const toolMessage = secondRequestBody.messages.at(-1);

    expect(toolMessage).toMatchObject({
      role: 'tool',
      tool_name: 'echo',
      content: 'hi',
    });
    expect(toolMessage).not.toHaveProperty('tool_call_id');
  });

  it('strips a legacy SDK-only tool_call_id if supplied manually', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama3.2',
        created_at: '2026-09-24T00:00:00Z',
        message: {
          role: 'assistant',
          content: 'done',
        },
        done: true,
      }),
    });

    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.chat({
      model: 'llama3.2',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'tool',
          tool_name: 'echo',
          tool_call_id: 'call_legacy',
          content: 'hi',
        },
      ],
      stream: false,
    });

    const requestBody = JSON.parse(
      String(fetchMock.mock.calls[0]![1]!.body),
    ) as {
      messages: Array<Record<string, unknown>>;
    };

    expect(requestBody.messages[1]).toEqual({
      role: 'tool',
      tool_name: 'echo',
      content: 'hi',
    });
  });
});
