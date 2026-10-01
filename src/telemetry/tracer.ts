/**
 * Optional OpenTelemetry tracing.
 *
 * `@opentelemetry/api` is an optional peer dependency. When it isn't installed, or when
 * the host process hasn't registered a global TracerProvider, `withSpan` degrades to
 * invoking its callback directly — no spans, no exporters, nothing beyond one cached
 * dynamic `import()` attempt. Once a consumer wires up an OpenTelemetry SDK, spans for
 * HTTP requests, endpoint failover attempts, agent turns, and tool calls appear
 * automatically without any configuration on this SDK's side.
 */

import type * as Otel from '@opentelemetry/api';
import { disposableSpan } from '../utils.js';

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue | undefined>;

const INSTRUMENTATION_NAME = '@nemesis-oss/ollama-sdk';
const INSTRUMENTATION_VERSION = '1.0.0';

let apiPromise: Promise<typeof Otel | undefined> | undefined;

function loadApi(): Promise<typeof Otel | undefined> {
  apiPromise ??= import('@opentelemetry/api').catch(() => undefined);
  return apiPromise;
}

function cleanAttributes(attributes: SpanAttributes): Record<string, SpanAttributeValue> {
  const clean: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Runs `fn` inside an active OpenTelemetry span named `name`, when OpenTelemetry is
 * available. `fn` receives the live span (to add events/attributes as work proceeds) or
 * `undefined` when tracing is a no-op. Exceptions from `fn` are recorded on the span,
 * marked as an error status, and re-thrown unchanged; the span always ends.
 *
 * On success the span status is left `Unset` rather than forced to `Ok` — per the
 * OpenTelemetry spec, `Ok` is final and silently suppresses any later `Error` status.
 * Some call sites (e.g. tool execution, which reports failure via a return value rather
 * than a throw) need to mark a successfully-*returned* span as an error after the fact,
 * via `setSpanError`; leaving success as `Unset` keeps that possible. Backends treat
 * `Unset` the same as `Ok` for filtering purposes.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Otel.Span | undefined) => Promise<T>,
): Promise<T> {
  const api = await loadApi();
  if (!api) {
    return fn(undefined);
  }

  const tracer = api.trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(cleanAttributes(attributes));
    using _span = disposableSpan(span);
    try {
      return await fn(span);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: error.message });
      throw error;
    }
    // span.end() called automatically via `using _span` at scope exit
  });
}

/** Adds an attribute/event to `span` if tracing is active; a cheap no-op otherwise. */
export function addSpanEvent(
  span: Otel.Span | undefined,
  name: string,
  attributes?: SpanAttributes,
): void {
  span?.addEvent(name, attributes ? cleanAttributes(attributes) : undefined);
}

/**
 * Marks a span as failed without throwing — for operations (like tool execution) that
 * report failure through a return value rather than an exception. No-ops when tracing
 * is inactive.
 */
export async function setSpanError(span: Otel.Span | undefined, error: Error): Promise<void> {
  if (!span) {
    return;
  }
  const api = await loadApi();
  span.recordException(error);
  span.setStatus({ code: api?.SpanStatusCode.ERROR ?? 2, message: error.message });
}

// --- Semantic convention attribute keys used by this SDK's instrumentation ---
// https://opentelemetry.io/docs/specs/semconv/http/http-spans/
export const ATTR_HTTP_REQUEST_METHOD = 'http.request.method';
export const ATTR_URL_FULL = 'url.full';
export const ATTR_SERVER_ADDRESS = 'server.address';
export const ATTR_SERVER_PORT = 'server.port';
export const ATTR_HTTP_RESPONSE_STATUS_CODE = 'http.response.status_code';

// https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
export const ATTR_GEN_AI_SYSTEM = 'gen_ai.system';
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const ATTR_GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id';

// Attributes specific to this SDK's failover/agent model (no matching semconv entry).
export const ATTR_OLLAMA_ENDPOINT_NAME = 'ollama.endpoint.name';
export const ATTR_OLLAMA_ENDPOINT_ATTEMPT = 'ollama.endpoint.attempt';
export const ATTR_OLLAMA_AGENT_MAX_ITERATIONS = 'ollama.agent.max_iterations';
export const ATTR_OLLAMA_AGENT_ITERATION = 'ollama.agent.iteration';
export const GEN_AI_SYSTEM_OLLAMA = 'ollama';
