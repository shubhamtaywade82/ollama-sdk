import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, canonicalToolCallSignature } from '../src/agent/agent.js';
import { defineTool } from '../src/tools/define-tool.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { OllamaClient } from '../src/client.js';
import { OllamaAgentToolLoopError, OllamaClientError } from '../src/errors.js';
import { OllamaMockServer } from './mocks/ollama-mock-server.js';
import type { Message, ToolCall } from '../src/types.js';

/**
 * AGN-01: cycle detection for the bounded agent loop. `Agent` has been a
 * boundary-checked runner since its introduction (maxIterations default 10,
 * maxToolCalls cap, registry-side error encapsulation); this suite pins the
 * NEW guardrail — `maxRepeatedToolCalls` — which fails fast when the model
 * re-emits one identical call instead of burning the whole iteration budget.
 */

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { function: { name, arguments: args } };
}

function assistantMessage(content: string, toolCalls?: ToolCall[]): Message {
  return {
    role: 'assistant',
    content,
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
  } as Message;
}

/** Stubbed AgentChatClient that replays scripted assistant messages in order. */
function scriptedClient(script: readonly Message[]): {
  client: { chat: ReturnType<typeof vi.fn> };
  requests: Array<{ messages: readonly Message[] }>;
} {
  const requests: Array<{ messages: readonly Message[] }> = [];
  let index = 0;
  const client = {
    chat: vi.fn().mockImplementation(async (request: { messages: readonly Message[] }) => {
      requests.push(request);
      const message = script[Math.min(index, script.length - 1)]!;
      index += 1;
      return { message: JSON.parse(JSON.stringify(message)) as Message };
    }),
  };
  return { client, requests };
}

describe('canonicalToolCallSignature', () => {
  it('includes the tool name and canonical JSON arguments', () => {
    expect(canonicalToolCallSignature(toolCall('search', { q: 'x' }))).toBe('search({"q":"x"})');
  });

  it('is invariant to argument key order (recursively)', () => {
    const a = toolCall('search', { q: 'x', opts: { limit: 5, offset: 0 } });
    const b = toolCall('search', { opts: { offset: 0, limit: 5 }, q: 'x' });
    expect(canonicalToolCallSignature(a)).toBe(canonicalToolCallSignature(b));
  });

  it('treats array order as significant (page 1 ≠ page 2)', () => {
    const a = toolCall('fetch', { ids: [1, 2] });
    const b = toolCall('fetch', { ids: [2, 1] });
    expect(canonicalToolCallSignature(a)).not.toBe(canonicalToolCallSignature(b));
  });

  it('separates signatures by tool name', () => {
    const a = toolCall('get_weather', { city: 'Tokyo' });
    const b = toolCall('get_time', { city: 'Tokyo' });
    expect(canonicalToolCallSignature(a)).not.toBe(canonicalToolCallSignature(b));
  });
});

describe('Agent cycle detection (maxRepeatedToolCalls)', () => {
  const weatherTool = defineTool({
    name: 'get_weather',
    description: 'Get weather for city',
    schema: z.object({ city: z.string() }),
    execute: ({ city }) => `Sunny in ${city}`,
  });

  it('is off by default: repeated identical calls only stop at maxIterations', async () => {
    // Turn 1..N: the model re-emits the same call forever.
    const { client } = scriptedClient([
      assistantMessage('', [toolCall('get_weather', { city: 'Tokyo' })]),
    ]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 4,
      validateToolCapability: false,
    });
    await expect(
      agent.run({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'agent_max_iterations_exceeded' });
  });

  it('fails fast with OllamaAgentToolLoopError when one signature exceeds the budget', async () => {
    const { client } = scriptedClient([
      assistantMessage('', [toolCall('get_weather', { city: 'Tokyo' })]),
    ]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 2,
      validateToolCapability: false,
    });
    const promise = agent.run({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await expect(promise).rejects.toBeInstanceOf(OllamaAgentToolLoopError);
    await expect(promise).rejects.toMatchObject({
      code: 'agent_tool_loop_detected',
      retryable: false,
      toolName: 'get_weather',
      repeatedExecutions: 3,
      maxRepeatedToolCalls: 2,
      signature: 'get_weather({"city":"Tokyo"})',
    });
  });

  it('stops before the iteration budget would have (fail-fast economics)', async () => {
    const { client, requests } = scriptedClient([
      assistantMessage('', [toolCall('get_weather', { city: 'Tokyo' })]),
    ]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 2,
      validateToolCapability: false,
    });
    await expect(
      agent.run({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(OllamaAgentToolLoopError);
    // Budget 2: turns 1-2 executed the call, turn 3's re-emission was
    // rejected before execution → 3 model turns total, not 10.
    expect(client.chat).toHaveBeenCalledTimes(3);
    expect(requests).toHaveLength(3);
  });

  it('does not trip on distinct arguments (progressing calls are not cycles)', async () => {
    const { client } = scriptedClient([
      assistantMessage('', [toolCall('get_weather', { city: 'Tokyo' })]),
      assistantMessage('', [toolCall('get_weather', { city: 'Osaka' })]),
      assistantMessage('', [toolCall('get_weather', { city: 'Kyoto' })]),
      assistantMessage('Checked three cities.'),
    ]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 1,
      validateToolCapability: false,
    });
    const result = await agent.run({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'Compare weather' }],
    });
    expect(result.finalMessage.content).toBe('Checked three cities.');
    expect(result.totalIterations).toBe(4);
  });

  it('allows the same call up to the budget across separate turns and converges', async () => {
    const { client } = scriptedClient([
      assistantMessage('', [toolCall('get_weather', { city: 'Tokyo' })]),
      assistantMessage('', [toolCall('get_weather', { city: 'Tokyo' })]),
      assistantMessage('Done after a retry.'),
    ]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 2,
      validateToolCapability: false,
    });
    const result = await agent.run({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.finalMessage.content).toBe('Done after a retry.');
  });

  it('counts duplicate calls within a single batch against each other', async () => {
    // One model turn emitting the identical call three times with budget 2.
    const { client } = scriptedClient([
      assistantMessage('', [
        toolCall('get_weather', { city: 'Tokyo' }),
        toolCall('get_weather', { city: 'Tokyo' }),
        toolCall('get_weather', { city: 'Tokyo' }),
      ]),
    ]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 2,
      validateToolCapability: false,
    });
    await expect(
      agent.run({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      code: 'agent_tool_loop_detected',
      repeatedExecutions: 3,
    });
  });

  it('counts failed executions: re-calling a failing tool with unchanged args is the loop', async () => {
    const failingTool = defineTool({
      name: 'flaky_api',
      description: 'Always fails',
      schema: z.object({ path: z.string() }),
      execute: () => {
        throw new Error('upstream 500');
      },
    });
    const { client } = scriptedClient([
      assistantMessage('', [toolCall('flaky_api', { path: '/x' })]),
    ]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([failingTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 1,
      validateToolCapability: false,
    });
    await expect(
      agent.run({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      code: 'agent_tool_loop_detected',
      toolName: 'flaky_api',
    });
  });

  it('counts unregistered tool calls (hallucinated names loop too)', async () => {
    const { client } = scriptedClient([
      assistantMessage('', [toolCall('hallucinated_tool', { q: 1 })]),
    ]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 1,
      validateToolCapability: false,
    });
    await expect(
      agent.run({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      code: 'agent_tool_loop_detected',
      toolName: 'hallucinated_tool',
    });
  });

  it('never fires onToolCallStart for a rejected batch (hook pairing stays consistent)', async () => {
    const { client } = scriptedClient([
      assistantMessage('', [toolCall('get_weather', { city: 'Tokyo' })]),
    ]);
    const started: string[] = [];
    const ended: string[] = [];
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 1,
      validateToolCapability: false,
      hooks: {
        onToolCallStart: (tc) => started.push(tc.function.name),
        onToolCallEnd: (res) => ended.push(res.toolName),
      },
    });
    await expect(
      agent.run({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(OllamaAgentToolLoopError);
    // Budget 1: the first call executed (start+end), the rejected second
    // never started — no orphan onToolCallStart.
    expect(started).toEqual(['get_weather']);
    expect(ended).toEqual(['get_weather']);
  });

  it('is an OllamaClientError and never retryable', async () => {
    const { client } = scriptedClient([
      assistantMessage('', [toolCall('get_weather', { city: 'Tokyo' })]),
    ]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 1,
      validateToolCapability: false,
    });
    const error = await agent
      .run({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OllamaAgentToolLoopError);
    expect(error).toBeInstanceOf(OllamaClientError);
    expect((error as OllamaAgentToolLoopError).retryable).toBe(false);
  });

  it('truncates very large signatures in the error payload', async () => {
    const hugeArgs = { blob: 'x'.repeat(5_000) };
    const { client } = scriptedClient([assistantMessage('', [toolCall('get_weather', hugeArgs)])]);
    const agent = new Agent(client, {
      tools: new ToolRegistry([weatherTool]),
      maxIterations: 10,
      maxRepeatedToolCalls: 1,
      validateToolCapability: false,
    });
    const error = (await agent
      .run({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] })
      .catch((err: unknown) => err)) as OllamaAgentToolLoopError;
    expect(error.signature.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(error.signature.endsWith('…')).toBe(true);
  });

  it.each([0, -1, 1.5])('rejects invalid maxRepeatedToolCalls (%p)', (value) => {
    expect(() => new Agent({ chat: vi.fn() }, { maxRepeatedToolCalls: value })).toThrow(RangeError);
  });
});

describe('Agent loop against OllamaMockServer: tool error encapsulation', () => {
  it('encapsulates an unregistered tool name as a failed tool result and feeds it back without crashing the loop', async () => {
    // Audit checklist item: mock-server proof that when the model emits a
    // tool call for a function that is not registered, the loop neither
    // crashes nor spins — the registry encapsulates the failure as a tool
    // result, the model sees it, and the run converges.
    const server = new OllamaMockServer(0);
    await server.start();

    const secondRequestBodies: unknown[] = [];
    const finalResponse = JSON.stringify({
      model: 'llama3.2',
      created_at: '2026-10-09T00:00:00Z',
      message: { role: 'assistant', content: 'That tool does not exist here.' },
      done: true,
    });
    const toolCallResponse = JSON.stringify({
      model: 'llama3.2',
      created_at: '2026-10-09T00:00:00Z',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'nonexistent_tool', arguments: { q: 'x' } } }],
      },
      done: true,
    });

    // First request → tool call for an unregistered name; re-register so the
    // second request (after the encapsulated error round-trips) converges.
    server.register('/api/chat', {
      status: 200,
      chunks: [toolCallResponse],
      onRequest: () => {
        server.register('/api/chat', {
          status: 200,
          chunks: [finalResponse],
          onRequest: (body) => {
            secondRequestBodies.push(body);
          },
        });
      },
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const realTool = defineTool({
      name: 'get_weather',
      description: 'Get weather for city',
      schema: z.object({ city: z.string() }),
      execute: ({ city }) => `Sunny in ${city}`,
    });
    const agent = new Agent(client, {
      tools: new ToolRegistry([realTool]),
      maxIterations: 5,
      validateToolCapability: false,
    });

    const result = await agent.run({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'Use your tools' }],
    });

    // The run converged — no throw, no iteration burnout.
    expect(result.finalMessage.content).toBe('That tool does not exist here.');
    expect(result.totalIterations).toBe(2);

    // The registry encapsulated the unregistered name as a failed result.
    const failedResult = result.turns[0]?.toolResults?.[0];
    expect(failedResult?.success).toBe(false);
    expect(failedResult?.outputString).toContain('not registered');

    // And the model received the encapsulated error as an ordinary tool
    // message in the follow-up request — the loop fed it back instead of
    // crashing on the rejection.
    const secondBody = secondRequestBodies[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const toolMessages = secondBody.messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain('not registered');

    await server.stop();
  });
});
