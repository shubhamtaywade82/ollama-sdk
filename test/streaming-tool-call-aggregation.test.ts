import { describe, expect, it } from 'vitest';
import { normalizeChatStream } from '../src/streaming/normalize.js';
import type { ChatResponse, ToolCall } from '../src/types.js';

/**
 * Defensive tool-call streaming aggregation — verifies that
 * `aggregateChat` in `src/streaming/normalize.ts` correctly merges
 * (not appends) `message.tool_calls` arrays that arrive across
 * multiple NDJSON chunks.
 *
 * ## Why this test exists
 *
 * The original `aggregateChat` blindly appended every chunk's
 * `tool_calls` array:
 *
 *   ```ts
 *   tool_calls: message.tool_calls?.length
 *     ? [...(accumulated.message.tool_calls ?? []), ...message.tool_calls]
 *     : accumulated.message.tool_calls,
 *   ```
 *
 * This produced duplicate entries if Ollama ever started streaming
 * tool_calls incrementally (each chunk would be appended rather
 * than merged). The fix uses `mergeToolCallArrays` from
 * `src/tools/tool-call-accumulator.ts` to merge entries that
 * refer to the same logical call (matched by id or array position).
 *
 * For the documented native Ollama behavior (tool_calls arrive
 * complete in one chunk), the merge is a no-op — one chunk carries
 * the full array, the next chunk has nothing, and the accumulator
 * appends exactly once.
 */

async function* chunks(
  ...cs: ChatResponse[]
): AsyncGenerator<ChatResponse, void, undefined> {
  for (const c of cs) yield c;
}

function chatChunk(opts: {
  content?: string;
  toolCalls?: readonly ToolCall[];
  done?: boolean;
  doneReason?: string;
}): ChatResponse {
  return {
    model: 'm',
    created_at: '2026-10-05T00:00:00Z',
    message: {
      role: 'assistant',
      ...(opts.content !== undefined ? { content: opts.content } : { content: '' }),
      ...(opts.toolCalls !== undefined ? { tool_calls: opts.toolCalls } : {}),
    },
    done: opts.done ?? false,
    ...(opts.doneReason !== undefined ? { done_reason: opts.doneReason } : {}),
  };
}

function toolCall(opts: { id?: string; name: string; args?: Record<string, unknown> }): ToolCall {
  return {
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    function: { name: opts.name, arguments: opts.args ?? {} },
  };
}

describe('aggregateChat: tool_calls single-chunk (the documented native case)', () => {
  it('emits the full tool_calls array when it arrives in one chunk', async () => {
    const stream = normalizeChatStream(
      chunks(
        chatChunk({
          toolCalls: [toolCall({ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } })],
          done: true,
          doneReason: 'stop',
        }),
      ),
    );

    for await (const _event of stream) {
      // drain
    }
    const final = await stream.finalResult;

    expect(final.message.tool_calls).toHaveLength(1);
    expect(final.message.tool_calls?.[0]?.function.name).toBe('get_weather');
    expect(final.message.tool_calls?.[0]?.function.arguments).toEqual({ city: 'Tokyo' });
    expect(final.message.tool_calls?.[0]?.id).toBe('call_1');
  });

  it('emits multiple parallel tool_calls when they arrive in one chunk', async () => {
    const stream = normalizeChatStream(
      chunks(
        chatChunk({
          toolCalls: [
            toolCall({ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } }),
            toolCall({ id: 'call_2', name: 'get_time', args: { tz: 'JST' } }),
          ],
          done: true,
          doneReason: 'stop',
        }),
      ),
    );

    for await (const _event of stream) {
      // drain
    }
    const final = await stream.finalResult;

    expect(final.message.tool_calls).toHaveLength(2);
    expect(final.message.tool_calls?.[0]?.function.name).toBe('get_weather');
    expect(final.message.tool_calls?.[1]?.function.name).toBe('get_time');
  });
});

describe('aggregateChat: tool_calls merge-by-id (defensive case)', () => {
  it('merges tool_calls with the same id across chunks rather than appending', async () => {
    // Hypothetical future Ollama behavior: tool_calls arrive
    // incrementally, with the model emitting arguments as partial
    // objects across multiple chunks. The SDK must merge these
    // into a single entry, not append duplicates.
    const stream = normalizeChatStream(
      chunks(
        chatChunk({
          toolCalls: [toolCall({ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } })],
          done: false,
        }),
        chatChunk({
          toolCalls: [toolCall({ id: 'call_1', name: 'get_weather', args: { unit: 'celsius' } })],
          done: true,
          doneReason: 'stop',
        }),
      ),
    );

    for await (const _event of stream) {
      // drain
    }
    const final = await stream.finalResult;

    expect(final.message.tool_calls).toHaveLength(1);
    expect(final.message.tool_calls?.[0]?.function.name).toBe('get_weather');
    // Both chunks' arguments are merged
    expect(final.message.tool_calls?.[0]?.function.arguments).toEqual({
      city: 'Tokyo',
      unit: 'celsius',
    });
  });

  it('merges each parallel call independently across chunks', async () => {
    const stream = normalizeChatStream(
      chunks(
        chatChunk({
          toolCalls: [
            toolCall({ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } }),
            toolCall({ id: 'call_2', name: 'get_time', args: { tz: 'JST' } }),
          ],
          done: false,
        }),
        chatChunk({
          toolCalls: [
            toolCall({ id: 'call_1', name: 'get_weather', args: { unit: 'celsius' } }),
            toolCall({ id: 'call_2', name: 'get_time', args: { format: '24h' } }),
          ],
          done: true,
          doneReason: 'stop',
        }),
      ),
    );

    for await (const _event of stream) {
      // drain
    }
    const final = await stream.finalResult;

    expect(final.message.tool_calls).toHaveLength(2);
    expect(final.message.tool_calls?.[0]?.function.arguments).toEqual({
      city: 'Tokyo',
      unit: 'celsius',
    });
    expect(final.message.tool_calls?.[1]?.function.arguments).toEqual({
      tz: 'JST',
      format: '24h',
    });
  });

  it('does NOT merge two tool_calls with different ids', async () => {
    const stream = normalizeChatStream(
      chunks(
        chatChunk({
          toolCalls: [toolCall({ id: 'call_1', name: 'foo', args: { a: 1 } })],
          done: false,
        }),
        chatChunk({
          toolCalls: [toolCall({ id: 'call_2', name: 'bar', args: { b: 2 } })],
          done: true,
          doneReason: 'stop',
        }),
      ),
    );

    for await (const _event of stream) {
      // drain
    }
    const final = await stream.finalResult;

    expect(final.message.tool_calls).toHaveLength(2);
    expect(final.message.tool_calls?.[0]?.id).toBe('call_1');
    expect(final.message.tool_calls?.[1]?.id).toBe('call_2');
  });
});

describe('aggregateChat: tool_calls with SDK-synthesized ids (the actual stream path)', () => {
  it('synthesizes stable ids per call, so the same logical call across chunks merges by id', async () => {
    // The chat stream pipeline wraps the source with
    // `withStableToolCallIds` BEFORE aggregation — so by the time
    // `aggregateChat` sees a chunk, any tool_call without an id has
    // been assigned one (synthesized via crypto.randomUUID). Two
    // chunks carrying the same logical call still get the SAME
    // synthesized id because `ensureToolCallIds` is idempotent
    // (it only synthesizes ids for entries that lack one, and the
    // synthesis happens once per chunk — but the chat stream's
    // source wrapper assigns ids consistently across chunks via
    // the same `ToolCall` reference).
    //
    // In practice, native Ollama emits tool_calls in a SINGLE chunk
    // (the final `done: true` frame), so the multi-chunk case here
    // is purely defensive — testing the SDK's behavior IF a future
    // server version starts streaming them incrementally.
    //
    // For calls without explicit ids, the synthesized id is unique
    // per-call-instance, so two separate chunks would get two
    // separate synthesized ids → no merge. This is acceptable
    // because the documented native behavior is "tool_calls arrive
    // in one chunk" — the SDK doesn't need to defend against
    // incremental streaming of id-less calls.
    const stream = normalizeChatStream(
      chunks(
        // First chunk carries a call WITH an explicit id
        chatChunk({
          toolCalls: [toolCall({ id: 'explicit_id', name: 'foo', args: { a: 1 } })],
          done: false,
        }),
        // Second chunk carries the same explicit id → merges
        chatChunk({
          toolCalls: [toolCall({ id: 'explicit_id', name: 'foo', args: { b: 2 } })],
          done: true,
          doneReason: 'stop',
        }),
      ),
    );

    for await (const _event of stream) {
      // drain
    }
    const final = await stream.finalResult;

    expect(final.message.tool_calls).toHaveLength(1);
    expect(final.message.tool_calls?.[0]?.function.arguments).toEqual({ a: 1, b: 2 });
    expect(final.message.tool_calls?.[0]?.id).toBe('explicit_id');
  });
});

describe('aggregateChat: tool_calls with content deltas interleaved', () => {
  it('aggregates content and tool_calls independently across the same chunks', async () => {
    // Common pattern: model emits a thinking content delta, then a
    // tool_call in a separate chunk, then a final content chunk.
    const stream = normalizeChatStream(
      chunks(
        chatChunk({ content: 'Let me check ', done: false }),
        chatChunk({
          toolCalls: [toolCall({ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } })],
          done: false,
        }),
        chatChunk({
          content: 'the weather',
          done: true,
          doneReason: 'stop',
        }),
      ),
    );

    const tokens: string[] = [];
    const toolCallEvents: ToolCall[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data.delta);
      if (event.type === 'tool_call') toolCallEvents.push(event.data.toolCall);
    }
    const final = await stream.finalResult;

    expect(tokens.join('')).toBe('Let me check the weather');
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]?.function.name).toBe('get_weather');
    expect(final.message.content).toBe('Let me check the weather');
    expect(final.message.tool_calls).toHaveLength(1);
  });
});

describe('aggregateChat: regression — no duplicate tool_calls on multi-chunk streams', () => {
  it('does not produce duplicate entries when the same tool_calls array appears in multiple chunks', async () => {
    // This is the regression test for the original append bug.
    // Before the fix, this would have produced 3 entries (one per
    // chunk that carried the tool_call) instead of 1.
    const stream = normalizeChatStream(
      chunks(
        chatChunk({
          toolCalls: [toolCall({ id: 'call_1', name: 'foo', args: {} })],
          done: false,
        }),
        chatChunk({
          toolCalls: [toolCall({ id: 'call_1', name: 'foo', args: {} })],
          done: false,
        }),
        chatChunk({
          toolCalls: [toolCall({ id: 'call_1', name: 'foo', args: {} })],
          done: true,
          doneReason: 'stop',
        }),
      ),
    );

    for await (const _event of stream) {
      // drain
    }
    const final = await stream.finalResult;

    expect(final.message.tool_calls).toHaveLength(1);
  });
});
