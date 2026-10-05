/**
 * `done_reason` decoder helpers — graceful handling of upstream
 * variance in the `done_reason` field returned by `/api/chat` and
 * `/api/generate`.
 *
 * The Ollama OpenAPI documents `done_reason` as a free-form string,
 * but the values actually observed on the wire fall into a small,
 * stable set:
 *
 *   - `"stop"`      — natural stop token hit or end-of-text.
 *   - `"length"`    — `num_predict` ceiling reached mid-generation.
 *   - `"load"`      — model load event (seen in streaming chunks
 *                     before the first token is generated; the
 *                     server reports `done: true` with `done_reason:
 *                     'load'` to indicate the load phase completed).
 *   - `"unload"`    — model unloaded (seen after a `keep_alive: 0`
 *                     request finalizes the unload).
 *
 * The SDK accepts any string for `done_reason` (so unknown values
 * don't cause runtime errors — the conformance-test failure mode
 * the Wave 13 CI run flagged). These helpers give callers who want
 * to narrow on the known set a type-safe way to do so.
 *
 * See: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

/**
 * The set of `done_reason` values Ollama documents and emits in
 * practice. Unknown upstream additions pass through as plain
 * strings — use {@link isKnownDoneReason} to narrow.
 */
export type KnownDoneReason = 'stop' | 'length' | 'load' | 'unload';

/**
 * Set of known `done_reason` literals, exposed for callers building
 * exhaustive `switch` statements or runtime validation tables.
 */
export const KNOWN_DONE_REASONS: ReadonlySet<KnownDoneReason> = new Set([
  'stop',
  'length',
  'load',
  'unload',
]);

/**
 * Type guard: `true` when `value` is one of the documented
 * `done_reason` literals. Use this to safely narrow from
 * `string | undefined` to {@link KnownDoneReason} before a
 * `switch` block.
 *
 * @example
 *   ```ts
 *   if (isKnownDoneReason(res.done_reason)) {
 *     switch (res.done_reason) {
 *       case 'stop':   // …
 *       case 'length': // …
 *       case 'load':   // …
 *       case 'unload': // …
 *     }
 *   } else {
 *     // forward-compat: an unknown reason we didn't list
 *   }
 *   ```
 */
export function isKnownDoneReason(
  value: string | undefined | null,
): value is KnownDoneReason {
  return value !== undefined && value !== null && KNOWN_DONE_REASONS.has(value as KnownDoneReason);
}
