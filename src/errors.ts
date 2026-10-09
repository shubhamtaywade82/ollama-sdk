/**
 * Structured, typed error hierarchy for OllamaClient.
 */

import type { z } from 'zod';

export interface OllamaErrorRequestContext {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly model?: string | undefined;
}

export interface OllamaErrorResponseContext {
  readonly status?: number | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: unknown;
}

export interface OllamaClientErrorOptions extends ErrorOptions {
  readonly code: string;
  readonly status?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly request?: OllamaErrorRequestContext | undefined;
  readonly response?: OllamaErrorResponseContext | undefined;
}

export class OllamaClientError extends Error {
  readonly code: string;
  readonly status?: number | undefined;
  readonly retryable: boolean;
  readonly request?: OllamaErrorRequestContext | undefined;
  readonly response?: OllamaErrorResponseContext | undefined;

  constructor(message: string, options: OllamaClientErrorOptions) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.request = options.request;
    this.response = options.response;
  }
}

export class OllamaNetworkError extends OllamaClientError {
  constructor(
    message: string,
    options?: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> | undefined,
  ) {
    super(message, { ...options, code: 'network_error', retryable: true });
  }
}

export class OllamaTimeoutError extends OllamaClientError {
  readonly timeoutMs?: number | undefined;
  constructor(
    message: string,
    options?:
      | (Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & { timeoutMs?: number | undefined })
      | undefined,
  ) {
    super(message, { ...options, code: 'timeout', retryable: true });
    this.timeoutMs = options?.timeoutMs;
  }
}

export class OllamaAuthError extends OllamaClientError {
  constructor(
    message: string,
    options?: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> | undefined,
  ) {
    super(message, { ...options, code: 'auth_error', retryable: false });
  }
}

export class OllamaNotFoundError extends OllamaClientError {
  constructor(
    message: string,
    options?: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> | undefined,
  ) {
    super(message, { ...options, code: 'not_found', retryable: false });
  }
}

export class OllamaRateLimitError extends OllamaClientError {
  readonly retryAfterMs?: number | undefined;
  constructor(
    message: string,
    options?:
      | (Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & {
          retryAfterMs?: number | undefined;
        })
      | undefined,
  ) {
    super(message, { ...options, code: 'rate_limited', retryable: true });
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * Thrown client-side, before a network request is made, by `QuotaManager.assertCanProceed`
 * (see `src/quota.ts`) when issuing the request would exceed a configured usage budget for
 * one of its rolling windows. This is distinct from `OllamaRateLimitError`, which reflects
 * the server's own 429 response — Ollama Cloud does not expose account-level quota via the
 * API, so `QuotaManager` tracks usage against budgets the caller configures locally and
 * fails fast rather than waiting for the server to reject the request.
 */
export class OllamaQuotaExceededError extends OllamaClientError {
  readonly windowId: string;
  readonly resetAt: number;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & {
      windowId: string;
      resetAt: number;
    },
  ) {
    super(message, { ...options, code: 'quota_exceeded', retryable: false });
    this.windowId = options.windowId;
    this.resetAt = options.resetAt;
  }
}

export class OllamaServerError extends OllamaClientError {
  constructor(
    message: string,
    options?: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> | undefined,
  ) {
    super(message, { ...options, code: 'server_error', retryable: true });
  }
}

/**
 * Thrown when the Ollama server returns HTTP **503 Service Unavailable**,
 * indicating that the request queue is saturated (`OLLAMA_MAX_QUEUE`
 * exceeded, default 512 — see the FAQ).
 *
 * Semantically a specialization of {@link OllamaServerError} (503 is a
 * kind of 5xx server error), but extends {@link OllamaClientError}
 * directly to preserve the subclass-specific `code: 'overloaded'` —
 * `OllamaServerError`'s constructor unconditionally forces
 * `code: 'server_error'`. Callers wanting to catch any 5xx should
 * use `error.status >= 500 && error.status < 600` OR explicitly
 * list both `OllamaServerError` and `OllamaOverloadedError`/
 * `OllamaBadGatewayError` in their `instanceof` checks.
 *
 * `retryable` is `true` because the queue will eventually drain;
 * callers using {@link withRetry} will get automatic backoff.
 */
export class OllamaOverloadedError extends OllamaClientError {
  constructor(
    message: string,
    options?: Omit<OllamaClientErrorOptions, 'code' | 'retryable' | 'status'> | undefined,
  ) {
    super(message, { ...options, code: 'overloaded', status: 503, retryable: true });
  }
}

/**
 * Thrown when the Ollama server returns HTTP **502 Bad Gateway**,
 * indicating that a cloud model could not be reached by the
 * Ollama Cloud proxy. The model may be temporarily down, the
 * cloud provider may be experiencing an outage, or the model
 * may have been deprovisioned.
 *
 * Semantically a specialization of {@link OllamaServerError} (502 is a
 * kind of 5xx server error), but extends {@link OllamaClientError}
 * directly to preserve the subclass-specific `code: 'bad_gateway'` —
 * see {@link OllamaOverloadedError} for the rationale. Callers wanting
 * to catch any 5xx should use `error.status >= 500 && error.status < 600`
 * OR explicitly list both classes in their `instanceof` checks.
 *
 * `retryable` is `true` for transient cloud-provider outages.
 */
export class OllamaBadGatewayError extends OllamaClientError {
  constructor(
    message: string,
    options?: Omit<OllamaClientErrorOptions, 'code' | 'retryable' | 'status'> | undefined,
  ) {
    super(message, { ...options, code: 'bad_gateway', status: 502, retryable: true });
  }
}

/**
 * Thrown when the Ollama server emits an in-band error frame inside
 * an NDJSON stream (chat / generate / pull / push / create).
 *
 * Ollama streams start with HTTP 200 OK and chunked transfer encoding.
 * If an error occurs mid-generation (GPU OOM, driver crash, context
 * window overflow, model unload race, etc.), the server emits a final
 * JSON chunk of the form `{"error": "..."}` and closes the stream.
 * The HTTP status code never changes from 200, so HTTP-status-based
 * error detection misses these errors entirely — they would silently
 * bleed into the assistant's content stream as garbage tokens or
 * undefined-field accesses.
 *
 * `partialContent` carries whatever was accumulated before the error
 * frame, so callers can log/diagnose what the model produced before
 * failing. For chat streams this is the concatenated `message.content`;
 * for generate streams it's the concatenated `response`; for pull/push
 * streams it's empty (progress events don't accumulate content).
 *
 * See: https://github.com/ollama/ollama/blob/main/docs/api.md
 */
export class OllamaStreamError extends OllamaClientError {
  /** Content accumulated before the in-band error frame, or '' if none. */
  readonly partialContent: string;
  constructor(
    message: string,
    options?: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & {
      partialContent?: string | undefined;
    },
  ) {
    super(message, { ...options, code: 'stream_error', retryable: false });
    this.partialContent = options?.partialContent ?? '';
  }
}

export class OllamaAbortError extends OllamaClientError {
  constructor(
    message: string,
    options?: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> | undefined,
  ) {
    super(message, { ...options, code: 'aborted', retryable: false });
  }
}

export class OllamaToolValidationError extends OllamaClientError {
  readonly toolName: string;
  readonly issues?: unknown;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code'> & { toolName: string; issues?: unknown },
  ) {
    super(message, { ...options, code: 'tool_validation_error', retryable: false });
    this.toolName = options.toolName;
    this.issues = options.issues;
  }
}

/**
 * Thrown by `OllamaRuntime.invoke` when `validateRequests: true` is set and
 * the request body fails Zod validation against the operation's registered
 * schema. See ADR 0020 (runtime Zod validation).
 *
 * The error carries the original Zod issues so callers can inspect which
 * fields failed. No HTTP request is made when this error is thrown.
 */
export class OllamaRequestValidationError extends OllamaClientError {
  readonly operationId: string;
  readonly issues: readonly z.ZodIssue[];
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code'> & {
      operationId: string;
      issues: readonly z.ZodIssue[];
    },
  ) {
    super(message, { ...options, code: 'request_validation_error', retryable: false });
    this.operationId = options.operationId;
    this.issues = options.issues;
  }
}

/**
 * Thrown by `OllamaRuntime.invoke` BEFORE any HTTP request is made when the
 * serialized request body exceeds the operation's declared
 * `constraints.maxRequestBytes`. The Ollama server returns 413 for such
 * payloads; this client-side check fails fast so the round-trip is avoided.
 *
 * Wave 12 (P0 #5): the IR has carried `maxRequestBytes` for System One
 * (64 KiB) since v1.7.0, but the runtime never enforced it. This closes
 * that contract/runtime gap.
 */
export class OllamaRequestTooLargeError extends OllamaClientError {
  readonly operationId: string;
  readonly actualBytes: number;
  readonly maxBytes: number;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code' | 'retryable' | 'status'> & {
      operationId: string;
      actualBytes: number;
      maxBytes: number;
    },
  ) {
    super(message, { ...options, code: 'request_too_large', retryable: false, status: 413 });
    this.operationId = options.operationId;
    this.actualBytes = options.actualBytes;
    this.maxBytes = options.maxBytes;
  }
}

/**
 * Thrown by `OllamaRuntime.invoke` AFTER the HTTP response is received
 * when `validateResponses: true` is set and the response body fails Zod
 * validation against the operation's registered response schema.
 *
 * Wave 13: the runtime previously never validated responses (see ADR
 * 0020). This opt-in error gives callers a way to detect wire-format
 * mismatches for operations where typed response semantics are critical
 * (e.g. System One). The error carries the original Zod issues so
 * callers can inspect which fields failed.
 */
export class OllamaResponseValidationError extends OllamaClientError {
  readonly operationId: string;
  readonly issues: readonly z.ZodIssue[];
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & {
      operationId: string;
      issues: readonly z.ZodIssue[];
    },
  ) {
    super(message, { ...options, code: 'response_validation_error', retryable: false });
    this.operationId = options.operationId;
    this.issues = options.issues;
  }
}

/**
 * Thrown by `OllamaRuntime.invoke` BEFORE any HTTP request is made when the
 * operation declares `constraints.minOllamaVersion` and the runtime could
 * not obtain a server version to compare against (e.g. `enforceVersion:
 * 'strict'` was set and `/api/version` was unreachable). Distinct from
 * {@link OllamaGenericClientError} so callers can branch on the failure
 * mode rather than parsing the message.
 */
export class OllamaServerVersionUnknownError extends OllamaClientError {
  readonly operationId: string;
  readonly minRequiredVersion: string;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & {
      operationId: string;
      minRequiredVersion: string;
    },
  ) {
    super(message, { ...options, code: 'server_version_unknown', retryable: false });
    this.operationId = options.operationId;
    this.minRequiredVersion = options.minRequiredVersion;
  }
}

export class OllamaToolTimeoutError extends OllamaClientError {
  readonly toolName: string;
  readonly timeoutMs: number;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & {
      toolName: string;
      timeoutMs: number;
    },
  ) {
    super(message, { ...options, code: 'tool_timeout', retryable: false });
    this.toolName = options.toolName;
    this.timeoutMs = options.timeoutMs;
  }
}

/**
 * Thrown client-side, before a network request is made, when a request asks for a
 * capability an endpoint is known not to support (e.g. structured output `format` against
 * an Ollama Cloud endpoint — see `ModelCapabilities.supportsStructuredOutputRequest` in
 * `src/capabilities/capabilities.ts`). Its `code` is included in `DEFAULT_FAILOVER_CODES`
 * by default, so in a multi-endpoint setup it causes failover to the next candidate rather
 * than failing outright — it only surfaces to the caller if every candidate is rejected.
 */
export class OllamaUnsupportedCapabilityError extends OllamaClientError {
  readonly capability: string;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & { capability: string },
  ) {
    super(message, { ...options, code: 'unsupported_capability', retryable: false });
    this.capability = options.capability;
  }
}

/**
 * Thrown client-side, before any network call, when `config.endpoints` uses
 * `OllamaEndpoint.models` to scope endpoints/credentials to specific models and the
 * requested `model` isn't in any configured endpoint's allow-list. This is a routing
 * misconfiguration, not a connectivity problem — the SDK deliberately does not "probe"
 * unauthorized endpoints to find one that happens to work (that would burn quota on keys
 * that were never entitled to the model and produce non-deterministic startup behavior).
 */
export class OllamaModelRoutingError extends OllamaClientError {
  readonly model: string;
  readonly availableModels: readonly string[];
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & {
      model: string;
      availableModels: readonly string[];
    },
  ) {
    super(message, { ...options, code: 'model_routing_error', retryable: false });
    this.model = options.model;
    this.availableModels = options.availableModels;
  }
}

/**
 * Thrown before an agent tool loop starts when the selected model's /api/show metadata
 * does not advertise a capability required by the loop.
 */
export class OllamaIncompatibleModelError extends OllamaClientError {
  readonly model: string;
  readonly capability: string;
  readonly reportedCapabilities: readonly string[];

  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code' | 'retryable'> & {
      model: string;
      capability: string;
      reportedCapabilities: readonly string[];
    },
  ) {
    super(message, { ...options, code: 'incompatible_model', retryable: false });
    this.model = options.model;
    this.capability = options.capability;
    this.reportedCapabilities = options.reportedCapabilities;
  }
}
export class OllamaAgentMaxToolCallsError extends OllamaClientError {
  readonly maxToolCalls: number;
  readonly toolCallsExecuted: number;

  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code'> & {
      maxToolCalls: number;
      toolCallsExecuted: number;
    },
  ) {
    super(message, { ...options, code: 'agent_max_tool_calls_exceeded', retryable: false });
    this.maxToolCalls = options.maxToolCalls;
    this.toolCallsExecuted = options.toolCallsExecuted;
  }
}

export class OllamaAgentMaxIterationsError extends OllamaClientError {
  readonly maxIterations: number;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code'> & { maxIterations: number },
  ) {
    super(message, { ...options, code: 'agent_max_iterations_exceeded', retryable: false });
    this.maxIterations = options.maxIterations;
  }
}

/**
 * Thrown when the agent's cycle detection fires: the same tool call —
 * identical name **and** identical arguments — would execute more times than
 * `maxRepeatedToolCalls` allows during one run.
 *
 * This is the fail-fast diagnosis for a model stuck in a tool loop (repeatedly
 * calling the same function with the same arguments, never reacting to the
 * results); without it, a looping model only surfaces as a generic
 * {@link OllamaAgentMaxIterationsError} after burning the full iteration
 * budget on wasted calls.
 */
export class OllamaAgentToolLoopError extends OllamaClientError {
  /** Name of the tool whose identical call would exceed the repeat budget. */
  readonly toolName: string;
  /** How many times this exact call would have executed including the rejected one. */
  readonly repeatedExecutions: number;
  /** The configured per-signature execution budget. */
  readonly maxRepeatedToolCalls: number;
  /** Canonical `name(args)` signature of the repeated call (very large payloads truncated). */
  readonly signature: string;

  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code'> & {
      toolName: string;
      repeatedExecutions: number;
      maxRepeatedToolCalls: number;
      signature: string;
    },
  ) {
    super(message, { ...options, code: 'agent_tool_loop_detected', retryable: false });
    this.toolName = options.toolName;
    this.repeatedExecutions = options.repeatedExecutions;
    this.maxRepeatedToolCalls = options.maxRepeatedToolCalls;
    this.signature = options.signature;
  }
}

export class OllamaMcpError extends OllamaClientError {
  readonly mcpMethod:
    'listTools' | 'callTool' | 'tools/call' | 'tasks/get' | 'tasks/result' | 'tasks/cancel';
  readonly toolName?: string | undefined;
  readonly issues?: unknown;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code'> & {
      mcpMethod:
        'listTools' | 'callTool' | 'tools/call' | 'tasks/get' | 'tasks/result' | 'tasks/cancel';
      toolName?: string | undefined;
      issues?: unknown;
    },
  ) {
    super(message, { ...options, code: 'mcp_error', retryable: options.retryable ?? false });
    this.mcpMethod = options.mcpMethod;
    this.toolName = options.toolName;
    this.issues = options.issues;
  }
}

export class OllamaSkillNotFoundError extends OllamaClientError {
  readonly skillName: string;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code'> & { skillName: string },
  ) {
    super(message, { ...options, code: 'skill_not_found', retryable: false });
    this.skillName = options.skillName;
  }
}

export class OllamaSkillInvalidError extends OllamaClientError {
  readonly skillName: string;
  readonly path?: string | undefined;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code'> & {
      skillName: string;
      path?: string | undefined;
    },
  ) {
    super(message, { ...options, code: 'skill_invalid', retryable: false });
    this.skillName = options.skillName;
    this.path = options.path;
  }
}

export class OllamaGenericClientError extends OllamaClientError {
  constructor(message: string, options?: Omit<OllamaClientErrorOptions, 'code'> | undefined) {
    super(message, { ...options, code: 'client_error' });
  }
}

function isDomAbortError(error: unknown): error is DOMException {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  );
}

function statusToError(
  status: number,
  message: string,
  options: Omit<OllamaClientErrorOptions, 'code' | 'status'>,
): OllamaClientError {
  if (status === 401 || status === 403) {
    return new OllamaAuthError(message, { ...options, status });
  }
  if (status === 404) {
    return new OllamaNotFoundError(message, { ...options, status });
  }
  if (status === 429) {
    return new OllamaRateLimitError(message, { ...options, status });
  }
  if (status === 502) {
    // Cloud model could not be reached. Distinct from generic 5xx so
    // callers running multi-model agents can branch on cloud-provider
    // failures specifically (fail over to a different model/endpoint
    // rather than blindly retrying the same one).
    return new OllamaBadGatewayError(message, { ...options });
  }
  if (status === 503) {
    // Queue saturation (OLLAMA_MAX_QUEUE exceeded). Retryable — the
    // queue will eventually drain. Distinct from generic 5xx so
    // callers running parallel swarms can branch on saturation.
    return new OllamaOverloadedError(message, { ...options });
  }
  if (status >= 500) {
    return new OllamaServerError(message, { ...options, status });
  }
  return new OllamaGenericClientError(message, { ...options, status });
}

/**
 * Maps arbitrary thrown exceptions into structured OllamaClientError instances.
 */
export function mapError(
  error: unknown,
  context: {
    request?: OllamaErrorRequestContext | undefined;
    response?: OllamaErrorResponseContext | undefined;
  } = {},
): OllamaClientError {
  if (error instanceof OllamaClientError) {
    return error;
  }
  if (isDomAbortError(error)) {
    return new OllamaAbortError(error.message || 'Request was aborted', {
      cause: error,
      request: context.request,
    });
  }
  if (error instanceof TypeError) {
    return new OllamaNetworkError(error.message || 'Network request failed', {
      cause: error,
      request: context.request,
    });
  }
  if (context.response?.status !== undefined) {
    const message = error instanceof Error ? error.message : String(error);
    return statusToError(context.response.status, message, {
      cause: error,
      request: context.request,
      response: context.response,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new OllamaGenericClientError(message, {
    cause: error,
    request: context.request,
    response: context.response,
  });
}
