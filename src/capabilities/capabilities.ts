/**
 * Model capability detection and runtime environment inference.
 */

import { HttpClient } from '../transport/http.js';
import type { ListResponse, ModelResponse, ShowResponse, ThinkingMetadata } from '../types.js';

export type RuntimeMode = 'local' | 'cloud' | 'unknown';

/**
 * Best-effort classification of a model's parallel tool-call emission
 * behavior. Used by agent loops that need to know whether the model
 * is likely to emit multiple `tool_calls` in a single assistant
 * message (parallel) or one-at-a-time (sequential).
 *
 * This is a **heuristic** derived from runtime mode + model family
 * pattern matching against `/api/show`'s reported model_info. The
 * SDK does NOT normalize between cloud and local — it reports the
 * best assessment it can and lets the caller decide how to act.
 *
 * See ADR 0023 for the rationale and the recommended caller pattern.
 */
export type ParallelToolCallBehavior = 'yes' | 'no' | 'unknown';

export interface ModelCapabilities {
  readonly model: string;
  readonly reported: readonly string[];
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
  readonly supportsEmbedding: boolean;
  readonly supportsCompletion: boolean;
  readonly supportsThinking: boolean;
  /** Model-defined thinking values and default, when /api/show reports them. */
  readonly thinking?: ThinkingMetadata | undefined;
  readonly supportsStreaming: true;
  /** Maximum model context length reported by /api/show model_info, when available. */
  readonly contextLength?: number | undefined;
  /**
   * Best-effort inference, not a guarantee: Ollama's `/api/show` does not report structured
   * output support as a queryable capability, so this is inferred from {@link inferRuntimeMode}
   * — `false` for `cloud`, since Ollama Cloud does not currently support structured outputs;
   * `true` for `local`/`unknown`. A locally-hosted model that genuinely can't follow a JSON
   * schema will still report `true` here; the request itself is the only reliable way to find
   * out. `OllamaClient.chat`/`generate` apply this same inference as a fail-fast pre-flight
   * guard whenever `format` is set, throwing `OllamaUnsupportedCapabilityError` rather than
   * making a network call that Ollama Cloud is known to reject.
   */
  readonly supportsStructuredOutputRequest: boolean;
  /**
   * Best-effort inference of whether the model is likely to emit
   * **multiple `tool_calls` in a single assistant message** (parallel)
   * vs **one tool call per assistant turn** (sequential).
   *
   * The SDK does NOT normalize between cloud and local — it reports
   * the best assessment it can and lets the caller decide. Agent
   * authors who need hard sequential execution should set
   * `ToolRegistry`'s `maxConcurrency: 1` regardless of this field's
   * value, since the model's behavior is not deterministic across
   * prompts.
   *
   * Inference matrix (see ADR 0023):
   *
   *   - **`'yes'`** — the model is known to emit parallel tool calls:
   *     - Cloud-mode endpoints (the OpenAI/Anthropic compat bridges
   *       proxy to proprietary models like GPT-4o, Claude, which
   *       freely emit parallel tool calls).
   *     - Local models from families that ship with parallel-tool-call
   *       training (Qwen 2.5+, Llama 3.1+ tool-use variants, Mistral
   *       function-calling fine-tunes, Hermes 2/3, Command R+).
   *
   *   - **`'no'`** — the model is known to emit at most one tool call
   *     per assistant turn. Currently no model family is classified
   *     as `'no'` by default; the field is reserved for future
   *     narrowing as more is learned about specific models.
   *
   *   - **`'unknown'`** — the model family is not in the known-yes or
   *     known-no list, OR `/api/show` didn't return enough
   *     information to make an assessment. Callers should treat
   *     `'unknown'` as "ask the model and see what it does" — the
   *     `ToolRegistry` will execute whatever calls the model emits,
   *     in parallel via `Promise.all` by default.
   *
   * See: `src/tools/registry.ts` for `maxConcurrency` enforcement,
   * and ADR 0023 for the full design rationale.
   */
  readonly parallelToolCalls: ParallelToolCallBehavior;
}

export function inferRuntimeMode(baseUrl: string): RuntimeMode {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.startsWith('192.168.') ||
      host.startsWith('10.')
    ) {
      return 'local';
    }
    return 'cloud';
  } catch {
    return 'unknown';
  }
}

function extractContextLength(modelInfo?: Record<string, unknown>): number | undefined {
  if (!modelInfo) return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (
      key.endsWith('.context_length') &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * Best-effort extraction of the model's architectural family from
 * `/api/show`'s `model_info` record.
 *
 * Ollama's `model_info` keys are dotted strings like
 * `llama.architecture`, `qwen2.architecture`, `mistral.architecture`,
 * etc. We look for any key ending in `.architecture` and return its
 * value (e.g. `"llama"`, `"qwen2"`, `"mistral"`). When absent, fall
 * back to scanning the `details.family` / `details.families` fields
 * from `/api/show`'s top-level response.
 *
 * Returns `undefined` when no family signal is available — the
 * caller treats this as `'unknown'` for parallel-tool-call purposes.
 */
function extractModelFamily(showRes: ShowResponse): string | undefined {
  // 1. Scan model_info for any `*.architecture` key.
  if (showRes.model_info) {
    for (const [key, value] of Object.entries(showRes.model_info)) {
      if (key.endsWith('.architecture') && typeof value === 'string' && value.length > 0) {
        return value.toLowerCase();
      }
    }
  }
  // 2. Fall back to details.family.
  if (showRes.details?.family && showRes.details.family.length > 0) {
    return showRes.details.family.toLowerCase();
  }
  // 3. Fall back to the first entry in details.families (when present).
  const families = showRes.details?.families;
  if (families && families.length > 0) {
    const first = families[0];
    if (typeof first === 'string' && first.length > 0) return first.toLowerCase();
  }
  return undefined;
}

/**
 * Local-mode model families known to support parallel tool calls.
 *
 * This is intentionally a conservative list — only families with a
 * documented track record of training parallel tool calls. When in
 * doubt, the heuristic returns `'unknown'` rather than `'yes'`,
 * because over-promising parallel tool calls causes agent loops to
 * over-allocate concurrency (which the SDK's `ToolRegistry` would
 * then have to serialize back down anyway).
 *
 * Sources:
 *   - Qwen 2.5 / Qwen 2.5 Coder tool-use: parallel tool calls supported
 *   - Llama 3.1+ tool-use variants: parallel tool calls supported
 *   - Mistral / Mixtral function-calling fine-tunes: parallel supported
 *   - Hermes 2/3 (NousResearch): parallel supported
 *   - Command R / Command R+ (Cohere): parallel supported
 */
const PARALLEL_TOOL_CALL_LOCAL_FAMILIES: ReadonlySet<string> = new Set([
  'qwen2',
  'qwen2.5',
  'qwen3',
  'llama3.1',
  'llama3.2',
  'llama3.3',
  'llama4',
  'mistral',
  'mixtral',
  'hermes',
  'command-r',
  'command-r-plus',
]);

/**
 * Local-mode model name substrings that, when present, indicate
 * the model is a tool-use / function-calling variant likely to
 * support parallel tool calls. This catches fine-tunes whose
 * `model_info.architecture` reports the base family (e.g. `llama`)
 * but whose model name reveals the tool-use variant (e.g.
 * `llama3.1-tool-use:8b`).
 */
const PARALLEL_TOOL_CALL_NAME_HINTS: ReadonlySet<string> = new Set([
  'tool-use',
  'tooluse',
  'function-call',
  'functioncall',
  'instruct', // Most "instruct" variants of tool-capable families ship with parallel tool calls
  'hermes',
  'command-r',
]);

/**
 * Heuristic for determining whether a local-mode model is known to
 * emit parallel tool calls. Returns `'yes'` when the model family
 * is in the known-parallel list OR the model name contains a tool-use
 * variant hint, `'no'` for families explicitly known to emit single
 * calls (currently none — the field is reserved for future use), and
 * `'unknown'` otherwise.
 *
 * The name-hint check scans the FULL model name (including tags like
 * `:7b-instruct`), not just the base name, because tool-use variants
 * often carry the hint in the tag (e.g. `phi3:14b-instruct`,
 * `llama3.1:8b-tool-use`).
 *
 * See ADR 0023 for the rationale.
 */
function inferLocalParallelToolCalls(
  model: string,
  family: string | undefined,
): ParallelToolCallBehavior {
  const modelLower = model.toLowerCase();
  // 1. Family-based assessment.
  if (family !== undefined && PARALLEL_TOOL_CALL_LOCAL_FAMILIES.has(family)) {
    return 'yes';
  }
  // 2. Name-substring assessment for tool-use variants. We scan the
  //    FULL model name (including the tag) because tool-use variants
  //    often carry the hint in the tag (e.g. `phi3:14b-instruct`,
  //    `llama3.1:8b-tool-use`).
  for (const hint of PARALLEL_TOOL_CALL_NAME_HINTS) {
    if (modelLower.includes(hint)) {
      return 'yes';
    }
  }
  // 3. Default: unknown. The caller should treat this as "ask the
  //    model and see what it does."
  return 'unknown';
}

/**
 * Heuristic for determining cloud-mode parallel tool call behavior.
 *
 * Cloud endpoints go through the OpenAI / Anthropic compatibility
 * bridges, which proxy to proprietary models (GPT-4o, Claude, etc.).
 * Both OpenAI and Anthropic models freely emit parallel tool calls
 * when they judge it appropriate, so cloud-mode is `'yes'` whenever
 * the model is tool-capable (`supportsTools === true`), and
 * `'unknown'` otherwise (an embedding-only model on a cloud endpoint
 * is an edge case that shouldn't claim parallel tool calls).
 */
function inferCloudParallelToolCalls(supportsTools: boolean): ParallelToolCallBehavior {
  return supportsTools ? 'yes' : 'unknown';
}

export async function detectModelCapabilities(
  http: HttpClient,
  model: string,
  signal?: AbortSignal,
): Promise<ModelCapabilities> {
  const showRes = await http.request<ShowResponse>({
    path: '/api/show',
    body: { model },
    ...(signal !== undefined ? { signal } : {}),
  });

  const reported = showRes.capabilities ?? [];
  const reportedSet = new Set(reported.map((c) => c.toLowerCase()));

  const contextLength = extractContextLength(showRes.model_info);
  const supportsTools = reportedSet.has('tools');
  const runtimeMode = inferRuntimeMode(http.baseUrl);

  // Parallel-tool-call inference: see ADR 0023.
  const parallelToolCalls: ParallelToolCallBehavior =
    runtimeMode === 'cloud'
      ? inferCloudParallelToolCalls(supportsTools)
      : runtimeMode === 'local'
        ? inferLocalParallelToolCalls(model, extractModelFamily(showRes))
        : // unknown runtime mode — can't even tell if we're cloud or local
          'unknown';

  return {
    model,
    reported,
    supportsTools,
    supportsVision: reportedSet.has('vision'),
    supportsEmbedding: reportedSet.has('embedding'),
    supportsCompletion: reportedSet.has('completion') || !reportedSet.has('embedding'),
    supportsThinking: reportedSet.has('thinking'),
    ...(showRes.thinking !== undefined ? { thinking: showRes.thinking } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    supportsStreaming: true,
    supportsStructuredOutputRequest: runtimeMode !== 'cloud',
    parallelToolCalls,
  };
}

export async function listAvailableModels(http: HttpClient): Promise<ModelResponse[]> {
  const res = await http.request<ListResponse>({
    path: '/api/tags',
    method: 'GET',
  });
  return [...res.models];
}
