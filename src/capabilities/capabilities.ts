/**
 * Model capability detection and runtime environment inference.
 */

import { HttpClient } from '../transport/http.js';
import type { ListResponse, ModelResponse, ShowResponse, ThinkingMetadata } from '../types.js';

export type RuntimeMode = 'local' | 'cloud' | 'unknown';

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

  return {
    model,
    reported,
    supportsTools: reportedSet.has('tools'),
    supportsVision: reportedSet.has('vision'),
    supportsEmbedding: reportedSet.has('embedding'),
    supportsCompletion: reportedSet.has('completion') || !reportedSet.has('embedding'),
    supportsThinking: reportedSet.has('thinking'),
    ...(showRes.thinking !== undefined ? { thinking: showRes.thinking } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    supportsStreaming: true,
    supportsStructuredOutputRequest: inferRuntimeMode(http.baseUrl) !== 'cloud',
  };
}

export async function listAvailableModels(http: HttpClient): Promise<ModelResponse[]> {
  const res = await http.request<ListResponse>({
    path: '/api/tags',
    method: 'GET',
  });
  return [...res.models];
}
