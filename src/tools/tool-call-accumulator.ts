/**
 * Tool-call streaming accumulator — defensive merge logic for
 * `message.tool_calls` arrays that arrive across multiple NDJSON
 * chunks.
 *
 * ## When this matters
 *
 * Ollama's **native `/api/chat`** streaming protocol emits
 * `message.tool_calls` as a complete JSON array (with parsed-object
 * `arguments`, not stringified deltas) in a single `done: true` chunk.
 * For native streaming, the accumulator here is mostly a no-op —
 * one chunk carries the full array, the next chunk has nothing.
 *
 * The accumulator becomes load-bearing in three scenarios:
 *
 *   1. **OpenAI-compat streaming** (`/v1/chat/completions` with
 *      `stream: true`): tool call arguments come as string deltas
 *      spread across multiple chunks, identified by `index`. The
 *      compat layer at `src/integrations/openai.ts` already does
 *      its own per-index accumulation; this utility exists for
 *      callers who want the same logic on raw NDJSON chunks.
 *
 *   2. **Defensive native streaming**: although the documented
 *      Ollama behavior is "tool_calls arrive in the final chunk",
 *      a future server version could legitimately stream them
 *      incrementally. The SDK shouldn't crash or produce
 *      duplicates if that happens.
 *
 *   3. **Caller-side buffering**: agent loops that consume
 *      `OllamaStream` events directly may want to buffer tool-call
 *      deltas themselves rather than trust the SDK's aggregator —
 *      this utility gives them a typed, tested building block.
 *
 * ## Merge semantics
 *
 * Two `ToolCall` entries are considered "the same call" when they
 * share the same `id` (the SDK-synthesized stable identifier — see
 * `src/tools/tool-call-id.ts`), OR when they're at the same array
 * position and neither has an `id`. When two same-call entries are
 * merged:
 *
 *   - `function.name` — the later chunk's name wins (the model may
 *     emit the name in a later chunk after an initial empty one).
 *   - `function.arguments` — the two objects are merged with
 *     spread semantics: `{...earlier, ...later}`. This handles
 *     the case where the model emits arguments incrementally as
 *     partial JSON objects (which is non-standard but seen in some
 *     open-weights fine-tunes).
 *
 * For arguments-as-string deltas (the OpenAI-compat case), the
 * accumulator concatenates the strings rather than merging — see
 * {@link mergeToolCallArgumentsString}.
 */

import type { ToolCall, ToolCallFunction } from '../types.js';

/**
 * Determine whether two `ToolCall` entries refer to the same logical
 * call (and should therefore be merged rather than appended).
 *
 * Returns `true` when:
 *   - both have an `id` and the ids match, OR
 *   - neither has an `id` and they're at the same array index
 *     (caller is responsible for the index check — this helper
 *     only handles the id case).
 */
export function isSameToolCall(
  a: ToolCall,
  b: ToolCall,
  aIndex?: number,
  bIndex?: number,
): boolean {
  if (a.id !== undefined && b.id !== undefined) {
    return a.id === b.id;
  }
  // No id on either side — same call iff the caller says they're at
  // the same array index. Default to "different" if the caller didn't
  // supply indices (safer than incorrectly merging unrelated calls).
  if (aIndex !== undefined && bIndex !== undefined) {
    return aIndex === bIndex;
  }
  return false;
}

/**
 * Merge two `ToolCall` entries that refer to the same logical call.
 *
 * The later chunk's `function.name` wins when present; otherwise the
 * earlier one's name is preserved. The two `arguments` objects are
 * merged with spread semantics (`{...earlier, ...later}`), which
 * handles the (non-standard but observed) case where the model
 * emits arguments as partial JSON objects across chunks.
 *
 * For arguments-as-string deltas (OpenAI-compat streaming), use
 * {@link mergeToolCallArgumentsString} instead.
 */
export function mergeToolCall(earlier: ToolCall, later: ToolCall): ToolCall {
  const earlierFn = earlier.function;
  const laterFn = later.function;
  const earlierArgs = earlierFn.arguments as Record<string, unknown> | undefined;
  const laterArgs = laterFn.arguments as Record<string, unknown> | undefined;

  const mergedFn: ToolCallFunction = {
    name: laterFn.name || earlierFn.name,
    arguments:
      earlierArgs !== undefined && laterArgs !== undefined
        ? { ...earlierArgs, ...laterArgs }
        : laterArgs ?? earlierArgs ?? {},
  };

  return {
    // id: prefer the later one if present, else the earlier one
    ...(later.id !== undefined ? { id: later.id } : earlier.id !== undefined ? { id: earlier.id } : {}),
    function: mergedFn,
  };
}

/**
 * Merge two `ToolCall` entries where `function.arguments` is a JSON
 * string (the OpenAI-compat streaming format), concatenating the
 * string deltas rather than spreading objects.
 *
 * Returns a `ToolCall` whose `function.arguments` is the
 * concatenated string. The caller is responsible for JSON-parsing
 * the final string when the stream completes.
 */
export function mergeToolCallArgumentsString(earlier: ToolCall, later: ToolCall): ToolCall {
  const earlierArgs = earlier.function.arguments as unknown as string | undefined;
  const laterArgs = later.function.arguments as unknown as string | undefined;
  const concatenated = (typeof earlierArgs === 'string' ? earlierArgs : '') +
    (typeof laterArgs === 'string' ? laterArgs : '');

  return {
    ...(later.id !== undefined ? { id: later.id } : earlier.id !== undefined ? { id: earlier.id } : {}),
    function: {
      name: later.function.name || earlier.function.name,
      arguments: concatenated as unknown as Record<string, unknown>,
    },
  };
}

/**
 * Defensive accumulator for `message.tool_calls` arrays that arrive
 * across multiple NDJSON chunks. Used internally by
 * `aggregateChat` in `src/streaming/normalize.ts` so the SDK doesn't
 * produce duplicate tool_call entries if a future server version
 * starts streaming them incrementally.
 *
 * The merge strategy is:
 *
 *   - For each tool call in the new chunk, check whether an existing
 *     entry matches (by `id` if both have one, by array position
 *     otherwise).
 *   - If a match is found, merge the two entries via
 *     {@link mergeToolCall}.
 *   - If no match is found, append the new entry.
 *
 * This preserves the documented native Ollama behavior (tool_calls
 * arrive complete in one chunk → no merge happens, just one append)
 * while being defensive against incremental streaming.
 *
 * @example
 *   ```ts
 *   const acc = new ToolCallAccumulator();
 *   acc.process([
 *     { function: { name: 'get_weather', arguments: { city: 'Tokyo' } } },
 *   ]);
 *   acc.process([
 *     { function: { name: 'get_weather', arguments: { unit: 'celsius' } } },
 *   ]);
 *   const result = acc.finalize();
 *   // → [{ function: { name: 'get_weather', arguments: { city: 'Tokyo', unit: 'celsius' } } }]
 *   ```
 */
export class ToolCallAccumulator {
  private readonly entries: ToolCall[] = [];

  /**
   * Process a chunk's `tool_calls` array. Entries that match an
   * existing accumulated entry (by id or array position) are merged;
   * new entries are appended.
   *
   * Returns the current accumulated state (a shallow copy — entries
   * themselves are NOT deep-cloned, so callers that mutate
   * `function.arguments` on a returned entry will mutate the
   * accumulator's internal state. Use {@link snapshot} for an
   * explicitly read-only view, or deep-clone the result if you need
   * full isolation).
   */
  process(toolCalls: readonly ToolCall[] | undefined): readonly ToolCall[] {
    if (!toolCalls || toolCalls.length === 0) {
      return [...this.entries];
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const incoming = toolCalls[i];
      if (!incoming) continue;

      // Find a matching existing entry. We check by id first
      // (the SDK-synthesized stable identifier), then by array
      // position. If neither matches, this is a new call.
      let matchedIndex = -1;
      for (let j = 0; j < this.entries.length; j++) {
        const existing = this.entries[j];
        if (existing && isSameToolCall(existing, incoming, j, i)) {
          matchedIndex = j;
          break;
        }
      }

      if (matchedIndex >= 0) {
        // Merge into the existing entry.
        this.entries[matchedIndex] = mergeToolCall(this.entries[matchedIndex]!, incoming);
      } else {
        // New call — append at the end (or at index i if we're
        // preserving positions; we append because the SDK's
        // ToolCall type doesn't guarantee array-position stability
        // across chunks).
        this.entries.push(incoming);
      }
    }

    return [...this.entries];
  }

  /**
   * Returns the final accumulated tool calls. Identical to calling
   * `process(undefined)` — included for ergonomics so callers can
   * express "I'm done, give me the result" without a no-op call.
   *
   * The returned array is a shallow copy; entries themselves are
   * the same object references the accumulator holds internally.
   */
  finalize(): readonly ToolCall[] {
    return [...this.entries];
  }

  /**
   * Returns the current accumulated state without modifying the
   * accumulator. Useful for mid-stream inspection.
   *
   * The returned array is a shallow copy; mutating it (e.g.
   * `result.push(...)`) does not affect the accumulator, but
   * mutating an entry's `function.arguments` object DOES affect
   * the accumulator's internal state because the entry reference
   * is shared. Deep-clone the result if you need full isolation.
   */
  snapshot(): readonly ToolCall[] {
    return [...this.entries];
  }

  /**
   * Returns the number of accumulated tool calls so far.
   */
  get length(): number {
    return this.entries.length;
  }
}

/**
 * Convenience function: merge two `tool_calls` arrays using the
 * default accumulator semantics, returning the merged array.
 *
 * Stateless equivalent of:
 *
 *   ```ts
 *   const acc = new ToolCallAccumulator();
 *   acc.process(earlier);
 *   acc.process(later);
 *   return acc.finalize();
 *   ```
 *
 * Useful for one-off merges without instantiating an accumulator.
 */
export function mergeToolCallArrays(
  earlier: readonly ToolCall[] | undefined,
  later: readonly ToolCall[] | undefined,
): readonly ToolCall[] {
  const acc = new ToolCallAccumulator();
  acc.process(earlier);
  acc.process(later);
  return acc.finalize();
}
