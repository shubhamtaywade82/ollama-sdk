import { describe, expect, it } from 'vitest';
import { OpenAIApi } from '../../src/generated/api/openai-api.js';
import { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import { HttpClient } from '../../src/transport/http.js';
import { openaiChatCompletionsOp } from '../../src/generated/api/operations.js';

/**
 * Wave 12 (P0 #2): the generated runtime must dispatch on
 * `operation.transport.mode`. OpenAI/Anthropic operations declare
 * `transport.mode === 'sse'`; before this fix, the runtime unconditionally
 * parsed every streaming response as NDJSON, which silently broke generated
 * compat streaming. These tests pin the contract → runtime behavior.
 */
describe('Wave 12: runtime honors transport.mode', () => {
  it('openaiChatCompletions uses SSE (not NDJSON) for streaming', async () => {
    // Sanity: the IR declares SSE for this operation.
    expect(openaiChatCompletionsOp.transport.mode).toBe('sse');
    expect(openaiChatCompletionsOp.transport.streaming).toBe(true);

    // An SSE body: two `data:` events carrying JSON payloads, terminated
    // by the `[DONE]` sentinel (the OpenAI compat stream terminator).
    const sseBody = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hel"}}]}',
      '',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"lo"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');

    const fetchImpl = (async () =>
      new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http });
    const api = new OpenAIApi(runtime);

    const stream = (await api.openaiChatCompletions({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    } as unknown as Record<string, unknown> & { stream: true })) as AsyncGenerator<
      { choices: { delta: { content: string } }[] },
      void,
      undefined
    >;

    const chunks: { content: string }[] = [];
    for await (const chunk of stream) {
      chunks.push({ content: chunk.choices[0]?.delta.content ?? '' });
    }
    expect(chunks.map((c) => c.content).join('')).toBe('hello');
  });

  it('an operation that mis-declares transport.mode=json cannot stream', async () => {
    // systemOne is declared json + streaming:false in the IR. The runtime
    // should never reach the streaming branch for it; if it did (e.g. via
    // a future bug that flipped streamingDefault), the json-mode parser
    // dispatch should throw defensively rather than silently parse NDJSON.
    const fetchImpl = (async () =>
      new Response('{"hello":"world"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http });

    // Force the streaming branch with a json-mode operation to verify the
    // defensive throw fires.
    await expect(
      runtime.invoke({
        operation: {
          ...openaiChatCompletionsOp,
          transport: { mode: 'json', streaming: true, streamingDefault: true },
        } as typeof openaiChatCompletionsOp,
        body: { model: 'x', messages: [], stream: true },
        streamingDefault: true,
      }),
    ).rejects.toThrow(/not a streaming mode/);
  });
});
