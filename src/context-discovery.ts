/**
 * Dynamic context-window discovery.
 *
 * Guessing context windows ("it's probably 2048… or 4096?") is how silent
 * truncation happens. Ollama advertises the real numbers in two places, and
 * they answer *different questions*:
 *
 *   - **`GET /api/ps`** reports `context_length` for every currently-running
 *     model — the window the runner has **actually allocated**. This is the
 *     exact, server-enforced number: it already reflects the model's Modelfile
 *     `num_ctx` default (if any) and the memory the runner was able to claim.
 *     Only meaningful while the model is loaded.
 *   - **`POST /api/show`** exposes two deeper signals in its response:
 *     - `model_info["<architecture>.context_length"]` — the model's **native**
 *       maximum from its GGUF metadata (e.g. `gemma4.context_length: 131072`).
 *       This is the ceiling you could raise `num_ctx` to, not the window you
 *       have. The official API examples show a model whose native max is
 *       131072 while its running instance allocated 4096 — a 32× gap.
 *     - `parameters` — the Modelfile's serialized option list; a
 *       `num_ctx <n>` line (when the model's author set one) is the default
 *       window the runner will allocate for this model.
 *
 * `OllamaClient.models.getContextLength()` consults them in precedence order
 * (see {@link resolveContextLength}) and returns every signal it found, so
 * callers can both act on the effective window *now* and know how much
 * headroom exists for raising it.
 */

import { extractContextLength } from './capabilities/capabilities.js';
import { OLLAMA_FALLBACK_CONTEXT_LENGTH } from './context-safety.js';
import type { ModelResponse, RequestCancellationOptions } from './types.js';

/** Request shape for {@link ModelsClient.getContextLength}. */
export interface ContextDiscoveryRequestOptions extends RequestCancellationOptions {
  /** Model to introspect (tag optional — `"llama3.1"` matches `"llama3.1:latest"`). */
  readonly model: string;
  /**
   * Skip the `GET /api/ps` lookup — e.g. on cloud endpoints where the local
   * running-models listing isn't meaningful, or when the extra round-trip
   * isn't wanted. Discovery then falls back to `/api/show` signals only.
   */
  readonly skipRunningCheck?: boolean | undefined;
}

/** Where a discovered context window came from, in precedence order. */
export type ContextLengthSource =
  /** `GET /api/ps` — window actually allocated by the running instance (exact). */
  | 'running'
  /** `POST /api/show` `parameters` — Modelfile-authored `num_ctx` default. */
  | 'parameters'
  /** `POST /api/show` `model_info["*.context_length"]` — native GGUF maximum. */
  | 'model-info'
  /** Nothing discoverable — Ollama's conservative unset-`num_ctx` default (2048). */
  | 'fallback';

/** Result of {@link ModelsClient.getContextLength}. */
export interface DiscoveredContextLength {
  /**
   * The effective context window to program against, resolved by precedence:
   * `running` (exact, when loaded) → `parameters` (Modelfile default) →
   * `model-info` (native max) → `2048` fallback.
   */
  readonly contextLength: number;
  /** Which source produced {@link contextLength}. */
  readonly source: ContextLengthSource;
  /** Window allocated by the running instance, when the model is loaded and reports it. */
  readonly runningContextLength?: number | undefined;
  /** Modelfile `num_ctx` default from `/api/show`'s `parameters` string, when set. */
  readonly parameterContextLength?: number | undefined;
  /** Native GGUF maximum from `model_info["*.context_length"]`, when reported. */
  readonly nativeContextLength?: number | undefined;
}

/**
 * Parses `num_ctx <n>` out of `/api/show`'s `parameters` string.
 *
 * The string is the Modelfile's serialized option list — one `name value`
 * pair per line, value separated by whitespace padding, e.g.
 * `"num_stop 8192\nnum_ctx 4096"`. Returns `undefined` when no positive
 * integer `num_ctx` line is present.
 */
export function extractParameterNumCtx(parameters?: string | undefined): number | undefined {
  if (!parameters) return undefined;
  const match = /^[ \t]*num_ctx[ \t]+(\d+)\s*$/m.exec(parameters);
  if (match === null) return undefined;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Finds the context window Ollama actually allocated for `model`, from a
 * `GET /api/ps` response. Matching mirrors Ollama's own model resolution:
 * exact match on the entry's `name`/`model`, or — when `model` carries no
 * tag — any entry whose name starts with `<model>:`.
 *
 * Returns `undefined` when the model isn't loaded or the running entry
 * doesn't report `context_length` (older server versions).
 */
export function findRunningModelContextLength(
  psModels: readonly ModelResponse[],
  model: string,
): number | undefined {
  for (const entry of psModels) {
    const exact = entry.name === model || entry.model === model;
    const taglessPrefix =
      !model.includes(':') &&
      (entry.name.startsWith(`${model}:`) || entry.model.startsWith(`${model}:`));
    if (exact || taglessPrefix) {
      return typeof entry.context_length === 'number' &&
        Number.isFinite(entry.context_length) &&
        entry.context_length > 0
        ? entry.context_length
        : undefined;
    }
  }
  return undefined;
}

/** Internal inputs to {@link resolveContextLength}; each signal independently optional. */
export interface ContextLengthSignals {
  readonly running?: number | undefined;
  readonly parameter?: number | undefined;
  readonly native?: number | undefined;
}

function positiveInt(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Resolves the effective context window from whatever signals were
 * discovered, by precedence:
 *
 *   1. **`running`** — the allocated window of the loaded instance. When the
 *      model is in memory this is the ground truth; it already incorporates
 *      any Modelfile `num_ctx` default.
 *   2. **`parameter`** — the Modelfile's `num_ctx`, i.e. the window the
 *      runner *will* allocate for this model on the next cold load.
 *   3. **`native`** — the GGUF maximum. Only used when nothing tighter is
 *      known: a fresh `num_ctx`-less load may allocate far less than native
 *      (Ollama's conservative default), so native is a *ceiling*, not an
 *      expectation.
 *   4. **Fallback** — {@link OLLAMA_FALLBACK_CONTEXT_LENGTH} (2048), the
 *      conservative server-side default, so the result is always actionable.
 *
 * Pure — used by `ModelsClient.getContextLength()` and exported for callers
 * that already hold `/api/ps` / `/api/show` responses.
 */
export function resolveContextLength(signals: ContextLengthSignals): DiscoveredContextLength {
  const running = positiveInt(signals.running);
  const parameter = positiveInt(signals.parameter);
  const native = positiveInt(signals.native);
  if (running !== undefined) {
    return {
      contextLength: running,
      source: 'running',
      ...(parameter !== undefined ? { parameterContextLength: parameter } : {}),
      ...(native !== undefined ? { nativeContextLength: native } : {}),
      runningContextLength: running,
    };
  }
  if (parameter !== undefined) {
    return {
      contextLength: parameter,
      source: 'parameters',
      parameterContextLength: parameter,
      ...(native !== undefined ? { nativeContextLength: native } : {}),
    };
  }
  if (native !== undefined) {
    return { contextLength: native, source: 'model-info', nativeContextLength: native };
  }
  return { contextLength: OLLAMA_FALLBACK_CONTEXT_LENGTH, source: 'fallback' };
}

/** Re-exported for `getContextLength` consumers that also want the raw model_info scanner. */
export { extractContextLength as extractNativeContextLength };
