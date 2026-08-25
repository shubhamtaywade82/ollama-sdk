/**
 * Structured, typed error hierarchy for OllamaClient.
 */

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

export class OllamaMcpError extends OllamaClientError {
  readonly mcpMethod: 'listTools' | 'callTool';
  readonly toolName?: string | undefined;
  constructor(
    message: string,
    options: Omit<OllamaClientErrorOptions, 'code'> & {
      mcpMethod: 'listTools' | 'callTool';
      toolName?: string | undefined;
    },
  ) {
    super(message, { ...options, code: 'mcp_error', retryable: options.retryable ?? false });
    this.mcpMethod = options.mcpMethod;
    this.toolName = options.toolName;
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
