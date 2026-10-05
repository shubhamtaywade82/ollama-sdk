import { describe, expect, it } from 'vitest';
import {
  ToolCallAccumulator,
  isSameToolCall,
  mergeToolCall,
  mergeToolCallArrays,
  mergeToolCallArgumentsString,
} from '../src/tools/tool-call-accumulator.js';
import type { ToolCall } from '../src/types.js';

/**
 * ToolCallAccumulator — see `src/tools/tool-call-accumulator.ts`.
 *
 * Defensive merge logic for `message.tool_calls` arrays that arrive
 * across multiple NDJSON chunks. The accumulator matches entries by
 * `id` (the SDK-synthesized stable identifier) or by array position,
 * and merges them rather than appending duplicates.
 *
 * Used internally by `aggregateChat` in `src/streaming/normalize.ts`
 * so the SDK doesn't produce duplicate tool_call entries if a future
 * server version starts streaming them incrementally.
 */

function makeToolCall(opts: {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}): ToolCall {
  return {
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    function: { name: opts.name, arguments: opts.args ?? {} },
  };
}

describe('ToolCallAccumulator: append-when-new behavior', () => {
  it('appends tool calls with no existing match (the common native Ollama case)', () => {
    const acc = new ToolCallAccumulator();
    const call = makeToolCall({ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } });
    const result = acc.process([call]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(call);
  });

  it('appends multiple distinct tool calls in order', () => {
    const acc = new ToolCallAccumulator();
    acc.process([makeToolCall({ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } })]);
    const result = acc.process([
      makeToolCall({ id: 'call_2', name: 'get_time', args: { tz: 'JST' } }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.function.name).toBe('get_weather');
    expect(result[1]?.function.name).toBe('get_time');
  });

  it('returns an empty array when given undefined or empty input', () => {
    const acc = new ToolCallAccumulator();
    expect(acc.process(undefined)).toEqual([]);
    expect(acc.process([])).toEqual([]);
  });

  it('returns a shallow copy (array mutations do not affect the accumulator)', () => {
    const acc = new ToolCallAccumulator();
    acc.process([makeToolCall({ id: 'call_1', name: 'foo', args: { a: 1 } })]);
    const snapshot = acc.snapshot();
    // Mutating the array (push/pop/splice) does not affect the
    // accumulator — the returned array is a fresh copy.
    (snapshot as ToolCall[]).push(makeToolCall({ id: 'call_2', name: 'bar', args: {} }));
    expect(acc.length).toBe(1);
    // The original entry is still there
    expect(acc.snapshot()[0]?.function.name).toBe('foo');
  });

  it('documented caveat: entry object references are shared (callers needing isolation must deep-clone)', () => {
    // This test documents the documented shallow-copy semantics:
    // entries themselves are NOT deep-cloned, so mutating an
    // entry's `function.arguments` on a returned snapshot WILL
    // affect the accumulator's internal state. Callers needing
    // full isolation must deep-clone the result themselves.
    const acc = new ToolCallAccumulator();
    acc.process([makeToolCall({ id: 'call_1', name: 'foo', args: { a: 1 } })]);
    const snapshot = acc.snapshot();
    // This mutation propagates — by design, to avoid the cost of
    // deep-cloning every tool_call on every snapshot.
    (snapshot[0] as ToolCall).function.name = 'mutated';
    expect(acc.snapshot()[0]?.function.name).toBe('mutated');
  });
});

describe('ToolCallAccumulator: merge-by-id behavior', () => {
  it('merges two tool calls with the same id rather than appending', () => {
    const acc = new ToolCallAccumulator();
    acc.process([makeToolCall({ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } })]);
    const result = acc.process([
      makeToolCall({ id: 'call_1', name: 'get_weather', args: { unit: 'celsius' } }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.function.name).toBe('get_weather');
    // Arguments are merged with spread semantics
    expect(result[0]?.function.arguments).toEqual({ city: 'Tokyo', unit: 'celsius' });
  });

  it('later name wins when merging (handles the "name arrives in a later chunk" case)', () => {
    const acc = new ToolCallAccumulator();
    acc.process([makeToolCall({ id: 'call_1', name: '', args: {} })]);
    const result = acc.process([makeToolCall({ id: 'call_1', name: 'get_weather', args: {} })]);
    expect(result).toHaveLength(1);
    expect(result[0]?.function.name).toBe('get_weather');
  });

  it('merges three chunks for the same call into one entry', () => {
    const acc = new ToolCallAccumulator();
    acc.process([makeToolCall({ id: 'call_1', name: 'foo', args: { a: 1 } })]);
    acc.process([makeToolCall({ id: 'call_1', name: 'foo', args: { b: 2 } })]);
    const result = acc.process([makeToolCall({ id: 'call_1', name: 'foo', args: { c: 3 } })]);
    expect(result).toHaveLength(1);
    expect(result[0]?.function.arguments).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe('ToolCallAccumulator: merge-by-array-position (no id)', () => {
  it('merges entries at the same array position when neither has an id', () => {
    const acc = new ToolCallAccumulator();
    acc.process([makeToolCall({ name: 'foo', args: { a: 1 } })]);
    const result = acc.process([makeToolCall({ name: 'foo', args: { b: 2 } })]);
    expect(result).toHaveLength(1);
    expect(result[0]?.function.arguments).toEqual({ a: 1, b: 2 });
  });

  it('does NOT merge entries at different array positions when neither has an id', () => {
    const acc = new ToolCallAccumulator();
    acc.process([
      makeToolCall({ name: 'foo', args: { a: 1 } }),
      makeToolCall({ name: 'bar', args: { x: 1 } }),
    ]);
    // Position 0 gets a new chunk, position 1 has no update
    const result = acc.process([makeToolCall({ name: 'foo', args: { b: 2 } })]);
    expect(result).toHaveLength(2);
    expect(result[0]?.function.arguments).toEqual({ a: 1, b: 2 });
    expect(result[1]?.function.name).toBe('bar');
  });
});

describe('ToolCallAccumulator: parallel tool calls', () => {
  it('merges each parallel call independently by id', () => {
    const acc = new ToolCallAccumulator();
    acc.process([
      makeToolCall({ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } }),
      makeToolCall({ id: 'call_2', name: 'get_time', args: { tz: 'JST' } }),
    ]);
    const result = acc.process([
      makeToolCall({ id: 'call_1', name: 'get_weather', args: { unit: 'celsius' } }),
      makeToolCall({ id: 'call_2', name: 'get_time', args: { format: '24h' } }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.function.arguments).toEqual({ city: 'Tokyo', unit: 'celsius' });
    expect(result[1]?.function.arguments).toEqual({ tz: 'JST', format: '24h' });
  });

  it('handles a new call arriving mid-stream alongside updates to existing calls', () => {
    const acc = new ToolCallAccumulator();
    acc.process([
      makeToolCall({ id: 'call_1', name: 'foo', args: { a: 1 } }),
    ]);
    const result = acc.process([
      makeToolCall({ id: 'call_1', name: 'foo', args: { b: 2 } }),
      makeToolCall({ id: 'call_2', name: 'bar', args: { x: 1 } }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.function.arguments).toEqual({ a: 1, b: 2 });
    expect(result[1]?.function.name).toBe('bar');
  });
});

describe('ToolCallAccumulator: finalize + snapshot + length', () => {
  it('finalize returns the same state as the last process call', () => {
    const acc = new ToolCallAccumulator();
    acc.process([makeToolCall({ id: 'call_1', name: 'foo', args: { a: 1 } })]);
    expect(acc.finalize()).toEqual(acc.snapshot());
  });

  it('length reflects the number of accumulated entries', () => {
    const acc = new ToolCallAccumulator();
    expect(acc.length).toBe(0);
    acc.process([makeToolCall({ id: 'call_1', name: 'foo', args: {} })]);
    expect(acc.length).toBe(1);
    acc.process([makeToolCall({ id: 'call_2', name: 'bar', args: {} })]);
    expect(acc.length).toBe(2);
    // Merging doesn't increase length
    acc.process([makeToolCall({ id: 'call_1', name: 'foo', args: { extra: true } })]);
    expect(acc.length).toBe(2);
  });
});

describe('mergeToolCallArrays: stateless convenience helper', () => {
  it('merges two arrays with default accumulator semantics', () => {
    const earlier = [makeToolCall({ id: 'call_1', name: 'foo', args: { a: 1 } })];
    const later = [makeToolCall({ id: 'call_1', name: 'foo', args: { b: 2 } })];
    const result = mergeToolCallArrays(earlier, later);
    expect(result).toHaveLength(1);
    expect(result[0]?.function.arguments).toEqual({ a: 1, b: 2 });
  });

  it('handles undefined earlier or later arrays', () => {
    expect(mergeToolCallArrays(undefined, [makeToolCall({ id: 'call_1', name: 'foo', args: {} })])).toHaveLength(1);
    expect(mergeToolCallArrays([makeToolCall({ id: 'call_1', name: 'foo', args: {} })], undefined)).toHaveLength(1);
    expect(mergeToolCallArrays(undefined, undefined)).toEqual([]);
  });
});

describe('isSameToolCall + mergeToolCall: standalone helpers', () => {
  it('isSameToolCall matches by id when both have one', () => {
    const a = makeToolCall({ id: 'call_1', name: 'foo', args: {} });
    const b = makeToolCall({ id: 'call_1', name: 'foo', args: {} });
    const c = makeToolCall({ id: 'call_2', name: 'foo', args: {} });
    expect(isSameToolCall(a, b)).toBe(true);
    expect(isSameToolCall(a, c)).toBe(false);
  });

  it('isSameToolCall falls back to array position when no id', () => {
    const a = makeToolCall({ name: 'foo', args: {} });
    const b = makeToolCall({ name: 'foo', args: {} });
    expect(isSameToolCall(a, b, 0, 0)).toBe(true);
    expect(isSameToolCall(a, b, 0, 1)).toBe(false);
    // No indices supplied — defaults to "different"
    expect(isSameToolCall(a, b)).toBe(false);
  });

  it('mergeToolCall produces a merged entry with later name + spread arguments', () => {
    const earlier = makeToolCall({ id: 'call_1', name: 'foo', args: { a: 1, b: 2 } });
    const later = makeToolCall({ id: 'call_1', name: 'bar', args: { b: 3, c: 4 } });
    const merged = mergeToolCall(earlier, later);
    expect(merged.id).toBe('call_1');
    expect(merged.function.name).toBe('bar');
    // Earlier args are preserved; later args override same-named keys
    expect(merged.function.arguments).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('mergeToolCall preserves the earlier id when the later entry has none', () => {
    const earlier = makeToolCall({ id: 'call_1', name: 'foo', args: {} });
    const later = makeToolCall({ name: 'foo', args: {} });
    const merged = mergeToolCall(earlier, later);
    expect(merged.id).toBe('call_1');
  });
});

describe('mergeToolCallArgumentsString: OpenAI-compat string delta merge', () => {
  it('concatenates the two arguments strings (for OpenAI-compat streaming)', () => {
    // OpenAI-compat streams arguments as string deltas:
    //   chunk 1: '{"city":'
    //   chunk 2: ' "Bengaluru"}'
    // The accumulator should concatenate these, NOT spread-merge them.
    const earlier = {
      id: 'call_1',
      function: { name: 'get_weather', arguments: '{"city":' as unknown as Record<string, unknown> },
    } as ToolCall;
    const later = {
      id: 'call_1',
      function: { name: 'get_weather', arguments: ' "Bengaluru"}' as unknown as Record<string, unknown> },
    } as ToolCall;
    const merged = mergeToolCallArgumentsString(earlier, later);
    expect(merged.id).toBe('call_1');
    expect(merged.function.name).toBe('get_weather');
    // The two string deltas are concatenated
    expect(merged.function.arguments as unknown as string).toBe('{"city": "Bengaluru"}');
  });

  it('handles undefined arguments on either side gracefully', () => {
    const earlier = {
      id: 'call_1',
      function: { name: 'foo', arguments: undefined as unknown as Record<string, unknown> },
    } as ToolCall;
    const later = {
      id: 'call_1',
      function: { name: 'foo', arguments: '{"a":1}' as unknown as Record<string, unknown> },
    } as ToolCall;
    const merged = mergeToolCallArgumentsString(earlier, later);
    expect(merged.function.arguments as unknown as string).toBe('{"a":1}');
  });
});
