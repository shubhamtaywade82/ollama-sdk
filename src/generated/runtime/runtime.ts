/**
 * OllamaRuntime — the runtime seam generated API classes delegate to.
 *
 * This is the only hand-written file in `src/generated/runtime/`. Every
 * generated method in `src/generated/api/*-api.ts` ends with:
 *
 * ```ts
 * return this.runtime.invoke({ operation: chatOp, body: request });
 * ```
 *
 * The runtime is responsible for:
 *   - Method/path resolution (from {@link OperationDefinition})
 *   - Streaming default application (when the request doesn't set `stream`)
 *   - Environment guard (rejecting cloud calls for local-only operations)
 *   - Version constraint guard (failing fast when the server is too old)
 *   - Delegating to the existing {@link HttpClient} for transport, retry,
 *     telemetry, NDJSON/SSE parsing
 *
 * It is intentionally a thin adapter — the existing transport, streaming,
 * middleware, and error-mapping layers are preserved verbatim. This file
 * only adds the contract-aware glue between generated API classes and the
 * existing HttpClient.
 */
import { HttpClient, type HttpRequestOptions } from '../../transport/http.js';
import { parseNdjsonStream } from '../../streaming/ndjson.js';
import { OllamaGenericClientError, OllamaRequestValidationError } from '../../errors.js';
import type { OperationDefinition, InvokeRequest } from './operation-definition.js';
import { getRequestSchema } from './schema-registry.js';

/** Constructor options for {@link OllamaRuntime}. */
export interface OllamaRuntimeOptions {
  readonly http: HttpClient;
  /**
   * Whether this runtime is targeting a local Ollama instance. Defaults to
   * `true`. When `false`, operations marked `environment.cloud === false`
   * (i.e. local-only like `/v1/systemone`) are rejected at request time.
   */
  readonly localMode?: boolean;
  /**
   * Server version, if known (typically from a prior `/api/version` call).
   * When set, operations with `constraints.minOllamaVersion` are checked
   * against this value at request time.
   */
  readonly serverVersion?: string;
  /**
   * When `true`, the runtime validates every request body against the
   * generated Zod schema before sending it. Defaults to `false` — opt-in.
   *
   * Validation behavior:
   *   - If the operation has a registered request schema (see
   *     {@link schema-registry.ts}), the body is parsed via `safeParse`.
   *   - On parse failure, throws `OllamaRequestValidationError` with the
   *     Zod issues attached. No HTTP request is made.
   *   - On parse success, the parsed (and stripped of unknown fields) body
   *     is sent — this means callers can't accidentally send extra fields
   *     that the contract doesn't allow.
   *   - If the operation has NO registered schema (e.g. GET endpoints,
   *     `/v1/systemone`, OpenAI/Anthropic compat surfaces), validation is
   *     skipped silently.
   *
   * Response validation is intentionally NOT enabled — see ADR 0020 for
   * the rationale (forward-compat with wire-format extensions).
   */
  readonly validateRequests?: boolean;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) ?? 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) ?? 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Apply environment + version guards before delegating to HttpClient.
 *
 * Throws {@link OllamaGenericClientError} when:
 *   - The operation is local-only and the runtime is in cloud mode.
 *   - The operation has `constraints.minOllamaVersion` and the server is older.
 */
function assertOperationAllowed(
  operation: OperationDefinition,
  options: OllamaRuntimeOptions,
): void {
  const localMode = options.localMode ?? true;
  if (!localMode && !operation.environment.cloud) {
    throw new OllamaGenericClientError(
      `Operation ${operation.operationId} (${operation.method} ${operation.path}) ` +
        `is local-only and not supported in cloud mode.`,
    );
  }
  if (
    operation.constraints?.minOllamaVersion &&
    options.serverVersion &&
    compareVersions(options.serverVersion, operation.constraints.minOllamaVersion) < 0
  ) {
    throw new OllamaGenericClientError(
      `Operation ${operation.operationId} (${operation.method} ${operation.path}) ` +
        `requires Ollama >= ${operation.constraints.minOllamaVersion} ` +
        `(server reports ${options.serverVersion}).`,
    );
  }
}

/**
 * Decide whether the request should stream. If the request body explicitly
 * sets `stream`, that wins. Otherwise the operation's `streamingDefault`
 * from the contract is used.
 */
function shouldStream(req: InvokeRequest): boolean {
  if (req.body && typeof req.body === 'object' && 'stream' in req.body) {
    const explicit = (req.body as { stream?: unknown }).stream;
    if (typeof explicit === 'boolean') return explicit;
  }
  return Boolean(req.streamingDefault ?? req.operation.transport.streamingDefault);
}

/**
 * Apply the streaming default to the request body if needed.
 *
 * If the operation streams by default and the body doesn't set `stream`,
 * add `stream: true`. The user can always override by setting `stream`
 * explicitly on the request.
 */
function buildBody(req: InvokeRequest): unknown {
  if (req.body === undefined) return undefined;
  if (typeof req.body !== 'object' || req.body === null) return req.body;
  const body = req.body as Record<string, unknown>;
  if (
    req.operation.transport.streaming &&
    req.operation.transport.streamingDefault &&
    body.stream === undefined
  ) {
    return { ...body, stream: true };
  }
  return body;
}

/** The runtime seam. */
export class OllamaRuntime {
  constructor(private readonly options: OllamaRuntimeOptions) {}

  /**
   * Invoke an operation. Called by every generated API method.
   *
   * Returns a `Promise<T>` for non-streaming operations, or an
   * `AsyncGenerator<T>` for streaming operations. The generated API
   * class's overloads pick the right return type at compile time.
   */
  async invoke<T = unknown>(req: InvokeRequest): Promise<T> {
    assertOperationAllowed(req.operation, this.options);
    let body = buildBody(req);

    // Wave 10 (ADR 0020): runtime Zod validation. Opt-in via
    // `validateRequests: true` on the runtime constructor. Throws
    // `OllamaRequestValidationError` BEFORE any HTTP request is made
    // when the body fails validation. The validated (and stripped)
    // body replaces the original so unknown fields can't leak through.
    if (this.options.validateRequests === true && body !== undefined) {
      const schema = getRequestSchema(req.operation.operationId);
      if (schema) {
        const result = schema.safeParse(body);
        if (!result.success) {
          throw new OllamaRequestValidationError(
            `Request validation failed for operation "${req.operation.operationId}" ` +
              `(${req.operation.method} ${req.operation.path}): ` +
              result.error.issues
                .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                .join('; '),
            {
              operationId: req.operation.operationId,
              issues: result.error.issues,
              request: { method: req.operation.method, url: req.operation.path },
            },
          );
        }
        body = result.data;
      }
    }

    const streaming = shouldStream(req);

    // The HttpClient expects the narrow method union 'GET' | 'POST' |
    // 'DELETE' | 'HEAD' | undefined — cast through `as` because our
    // OperationDefinition.method is the wider HttpMethod type.
    const httpReq: HttpRequestOptions = {
      path: req.operation.path,
      method: req.operation.method as 'GET' | 'POST' | 'DELETE' | 'HEAD',
      ...(body !== undefined ? { body } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      // For streaming calls, request the raw Response so we can pipe it
      // through parseNdjsonStream directly. This inherits middleware,
      // retry, telemetry, and error-mapping from HttpClient — the
      // previous Wave 3 implementation bypassed them with a direct
      // `fetch()` call.
      ...(streaming ? { raw: true } : {}),
    };

    if (!streaming) {
      return (await this.options.http.request<T>(httpReq)) as T;
    }

    // Streaming: HttpClient returns the raw Response (via the `raw: true`
    // option) so we can read its body as an NDJSON stream.
    const response = await this.options.http.request<Response>(httpReq);
    if (!response.body) {
      throw new OllamaGenericClientError(
        `Operation ${req.operation.operationId}: streaming response had no body.`,
      );
    }
    return parseNdjsonStream<T>(response.body) as unknown as T;
  }
}
