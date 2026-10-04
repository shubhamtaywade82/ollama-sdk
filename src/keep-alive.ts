/**
 * VRAM lifecycle helpers — ergonomic `keep_alive` primitives.
 *
 * Ollama's `keep_alive` parameter (accepted by `/api/generate`,
 * `/api/chat`, `/api/embed`, `/api/embeddings`, and `/v1/systemone`)
 * controls how long a model remains resident in VRAM after a request
 * completes. The upstream spec defines four operational semantics:
 *
 *   - **Duration string** (`"5m"`, `"10s"`, `"24h"`) — explicit window.
 *   - **Integer seconds** (`3600`, `300`) — explicit window in seconds.
 *   - **Indefinite pinning** (`-1` or `"-1m"`) — keep the model
 *     permanently resident in VRAM until the server is restarted or
 *     an explicit `0` request is made. Useful for hot-loop inference
 *     where load latency dominates.
 *   - **Immediate eviction** (`0` or `"0s"`) — unload the model from
 *     VRAM as soon as the response is finalized. Frees GPU memory
 *     for the next pipeline (e.g. swap a vision model out before
 *     loading an LLM).
 *
 * These primitives let callers express VRAM-lifecycle intent with
 * readable names instead of magic integers, while preserving full
 * backward compatibility with raw `string | number` values.
 *
 * See: https://github.com/ollama/ollama/blob/main/docs/faq.md
 *      #how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately
 */

/**
 * Sentinel value that, when passed as `keep_alive`, instructs the
 * server to evict the model from VRAM as soon as the in-flight
 * request finalizes its response. Equivalent to passing `0` or
 * `"0s"`.
 */
export const KEEP_ALIVE_UNLOAD = 0 as const;

/**
 * Sentinel value that, when passed as `keep_alive`, instructs the
 * server to keep the model resident in VRAM indefinitely (until
 * the server is restarted or an explicit `0` request arrives).
 * Equivalent to passing `-1` or `"-1m"`.
 */
export const KEEP_ALIVE_INDEFINITE = -1 as const;

/**
 * Ergonomic union for the `keep_alive` field on chat/generate/embed/
 * embeddings/System One requests.
 *
 * Accepts every upstream-supported shape plus two SDK-level sugar
 * literals:
 *
 *   - `'unload'` — same as `0`; frees GPU VRAM after this request.
 *   - `'indefinite'` — same as `-1`; pins the model in VRAM until
 *     an explicit unload.
 *
 * Use {@link normalizeKeepAlive} to convert this into the raw
 * `string | number` shape the wire expects.
 */
export type KeepAlive =
  | string // duration strings like '5m', '24h', '0s', '-1m'
  | number // seconds (300, 0, -1, …)
  | 'unload'
  | 'indefinite';

/**
 * Convert a {@link KeepAlive} value into the raw `string | number`
 * shape Ollama's REST API expects.
 *
 *   - `'unload'`     → `0`    (immediate eviction)
 *   - `'indefinite'` → `-1`   (perpetual pinning)
 *   - everything else is passed through unchanged
 *
 * Returns `undefined` for `undefined` input so callers can pipe
 * optional fields straight through without conditional spreads.
 *
 * @example
 *   normalizeKeepAlive('unload')      // → 0
 *   normalizeKeepAlive('indefinite')   // → -1
 *   normalizeKeepAlive('5m')          // → '5m'
 *   normalizeKeepAlive(3600)          // → 3600
 *   normalizeKeepAlive(undefined)     // → undefined
 */
export function normalizeKeepAlive(
  keepAlive: KeepAlive | undefined,
): string | number | undefined {
  if (keepAlive === undefined) return undefined;
  if (keepAlive === 'unload') return KEEP_ALIVE_UNLOAD;
  if (keepAlive === 'indefinite') return KEEP_ALIVE_INDEFINITE;
  return keepAlive;
}

/**
 * Type guard: `true` when the value is one of the SDK-level sugar
 * literals (`'unload'` or `'indefinite'`). Useful for callers that
 * want to branch on intent rather than magic integers.
 */
export function isKeepAliveSugar(
  value: KeepAlive | unknown,
): value is 'unload' | 'indefinite' {
  return value === 'unload' || value === 'indefinite';
}
