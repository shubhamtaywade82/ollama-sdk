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
import { parseSseStream } from '../../streaming/sse.js';
import {
  OllamaGenericClientError,
  OllamaRequestTooLargeError,
  OllamaRequestValidationError,
  OllamaResponseValidationError,
  OllamaServerVersionUnknownError,
} from '../../errors.js';
import type { OperationDefinition, InvokeRequest } from './operation-definition.js';
import type { TransportMode } from './operation-definition.js';
import { getRequestSchema, getResponseSchema } from './schema-registry.js';

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
   *
   * Wave 12 (P0 #5): when unset, the runtime will lazily fetch and cache
   * the server version the first time a version-gated operation is
   * invoked. The fetch policy is controlled by {@link enforceVersion}.
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
   * Response validation is intentionally NOT enabled by default — see
   * ADR 0020 for the rationale (forward-compat with wire-format
   * extensions).
   *
   * Wave 13: an opt-in `validateResponses` option is now available for
   * operations where typed response semantics are the entire point
   * (e.g. System One). When enabled, the runtime validates the HTTP
   * response body against the operation's registered response schema
   * before returning it to the caller. On failure, throws
   * {@link OllamaResponseValidationError}.
   */
  readonly validateRequests?: boolean;
  /**
   * Wave 13: when `true`, the runtime validates every response body
   * against the operation's registered response schema before returning
   * it. Defaults to `false` — opt-in. Only operations with a registered
   * response schema are validated; others pass through unchanged.
   *
   * On validation failure, throws {@link OllamaResponseValidationError}
   * with the Zod issues attached. The HTTP response is still consumed.
   *
   * Use this for operations where typed response semantics are critical
   * (System One, structured output). Don't enable globally — legitimate
   * forward-compat wire-format extensions would cause false rejections.
   */
  readonly validateResponses?: boolean;
  /**
   * Policy for enforcing `constraints.minOllamaVersion` when
   * {@link serverVersion} is not explicitly supplied.
   *
   *   - `'auto'` (default): lazily fetch `/api/version` once and cache the
   *     result; subsequent version-gated invocations reuse the cached
   *     value. If the fetch fails, the operation is allowed through
   *     (fail-open) — the server will reject it if it truly doesn't
   *     support it.
   *   - `'strict'`: same as `'auto'`, but if the version fetch fails the
   *     invocation throws {@link OllamaServerVersionUnknownError} rather
   *     than fail-open. Use this when the caller wants hard guarantees
   *     that a version-gated operation will not be sent to a server that
   *     can't handle it.
   *   - `'off'`: never fetch `/api/version` automatically. The runtime
   *     only enforces the version constraint when {@link serverVersion}
   *     was explicitly supplied. Useful in tests that mock fetch and want
   *     to avoid spurious version probes.
   */
  readonly enforceVersion?: 'auto' | 'strict' | 'off';
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
 * Best-effort one-shot fetch of the Ollama server version.
 *
 * Resolves to `undefined` if the server's response shape doesn't include a
 * `version` field. Network/parse errors propagate to the caller, where the
 * `enforceVersion` policy decides whether they become hard failures
 * ('strict') or silent fallthrough ('auto').
 *
 * The result is cached per-runtime in {@link OllamaRuntime}'s private
 * state — we don't re-probe `/api/version` for every version-gated call.
 */
async function fetchServerVersion(http: HttpClient): Promise<string | undefined> {
  const result = await http.request<{ version?: unknown }>({
    path: '/api/version',
    method: 'GET',
  });
  if (result && typeof result.version === 'string') return result.version;
  return undefined;
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
  /**
   * Cached promise of the Ollama server version, populated lazily the first
   * time a version-gated operation is invoked. `undefined` until then.
   *
   * Wave 12 (P0 #5): see {@link OllamaRuntimeOptions.enforceVersion}.
   */
  private serverVersionCache: Promise<string | undefined> | undefined;

  constructor(private readonly options: OllamaRuntimeOptions) {}

  /**
   * Invoke an operation. Called by every generated API method.
   *
   * Returns a `Promise<T>` for non-streaming operations, or an
   * `AsyncGenerator<T>` for streaming operations. The generated API
   * class's overloads pick the right return type at compile time.
   */
  async invoke<T = unknown>(req: InvokeRequest): Promise<T> {
    await this.assertOperationAllowed(req.operation);
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

    // Wave 12 (P0 #5) + Wave 13: enforce request size limits BEFORE
    // the request is sent. The Ollama server returns 413 for oversized
    // bodies; failing fast client-side avoids the round-trip.
    //
    // Wave 13 adds conditional limits: when the operation declares
    // `maxRequestBytesWithImages` AND the body contains a non-empty
    // `images` array, the higher limit applies (e.g. System One allows
    // 32 MiB with images vs 64 KiB without). When images are absent
    // or the operation doesn't declare a separate images limit, the
    // base `maxRequestBytes` applies.
    if (body !== undefined) {
      const serialized = serializeForByteCount(body);
      const hasImages = bodyHasImages(body);
      const maxBytesWithImages = req.operation.constraints?.maxRequestBytesWithImages;
      const maxBytesBase = req.operation.constraints?.maxRequestBytes;
      const applicableLimit =
        hasImages && maxBytesWithImages !== undefined ? maxBytesWithImages : maxBytesBase;
      if (applicableLimit !== undefined && serialized.byteLength > applicableLimit) {
        throw new OllamaRequestTooLargeError(
          `Operation ${req.operation.operationId} (${req.operation.method} ` +
            `${req.operation.path}) request body is ${serialized.byteLength} bytes, ` +
            `exceeding the contract limit of ${applicableLimit} bytes` +
            (hasImages ? ' (images limit).' : '.'),
          {
            operationId: req.operation.operationId,
            actualBytes: serialized.byteLength,
            maxBytes: applicableLimit,
            request: { method: req.operation.method, url: req.operation.path },
          },
        );
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
      // through the parser the contract specifies for this operation.
      // This inherits middleware, retry, telemetry, and error-mapping
      // from HttpClient — the previous Wave 3 implementation bypassed
      // them with a direct `fetch()` call.
      ...(streaming ? { raw: true } : {}),
    };

    if (!streaming) {
      const result = (await this.options.http.request<T>(httpReq)) as T;
      // Wave 13: opt-in response validation. When `validateResponses: true`
      // is set and the operation has a registered response schema, validate
      // the response body before returning it. Throws
      // OllamaResponseValidationError on failure. Only use this for
      // operations where typed response semantics are critical (System One,
      // structured output) — don't enable globally.
      if (this.options.validateResponses === true) {
        const responseSchema = getResponseSchema(req.operation.operationId);
        if (responseSchema) {
          const result2 = responseSchema.safeParse(result);
          if (!result2.success) {
            throw new OllamaResponseValidationError(
              `Response validation failed for operation "${req.operation.operationId}" ` +
                `(${req.operation.method} ${req.operation.path}): ` +
                result2.error.issues
                  .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                  .join('; '),
              {
                operationId: req.operation.operationId,
                issues: result2.error.issues,
                request: { method: req.operation.method, url: req.operation.path },
              },
            );
          }
        }
      }
      return result;
    }

    // Streaming: HttpClient returns the raw Response (via the `raw: true`
    // option) so we can read its body through the parser the contract
    // specifies for this operation.
    //
    // Wave 12 (P0 #2): the runtime now honors `operation.transport.mode`
    // instead of unconditionally parsing every stream as NDJSON. Native
    // Ollama operations (chat/generate/create/pull/push) declare
    // `transport.mode === 'ndjson'` and continue to use parseNdjsonStream;
    // OpenAI/Anthropic compatibility operations declare `transport.mode ===
    // 'sse'` and now correctly use the SSE parser, then JSON-decode each
    // event's `data` field. This closes the contract/runtime violation
    // where generated compat streaming was being parsed as NDJSON.
    const response = await this.options.http.request<Response>(httpReq);
    if (!response.body) {
      throw new OllamaGenericClientError(
        `Operation ${req.operation.operationId}: streaming response had no body.`,
      );
    }
    return parseStreamByMode<T>(req.operation.transport.mode, response.body) as unknown as T;
  }

  /**
   * Apply environment + version guards before delegating to HttpClient.
   *
   * Throws {@link OllamaGenericClientError} when:
   *   - The operation is local-only and the runtime is in cloud mode.
   *   - The operation has `constraints.minOllamaVersion` and the server is older.
   *
   * Wave 12 (P0 #5): when `minOllamaVersion` is declared but the runtime's
   * `serverVersion` is unknown AND `enforceVersion` is `'auto'` or
   * `'strict'`, the runtime lazily fetches `/api/version` (cached on the
   * runtime instance) so the constraint is actually enforced even when the
   * caller didn't supply it. Previously the constraint was only enforced
   * when `serverVersion` was manually supplied — meaning in practice it was
   * almost never enforced.
   */
  private async assertOperationAllowed(operation: OperationDefinition): Promise<void> {
    const localMode = this.options.localMode ?? true;
    if (!localMode && !operation.environment.cloud) {
      throw new OllamaGenericClientError(
        `Operation ${operation.operationId} (${operation.method} ${operation.path}) ` +
          `is local-only and not supported in cloud mode.`,
      );
    }
    const minVersion = operation.constraints?.minOllamaVersion;
    if (!minVersion) return;

    let serverVersion = this.options.serverVersion;
    const policy = this.options.enforceVersion ?? 'auto';
    if (!serverVersion && policy !== 'off') {
      if (!this.serverVersionCache) {
        const p = fetchServerVersion(this.options.http).catch((err) => {
          if (policy === 'strict') {
            throw new OllamaServerVersionUnknownError(
              `Operation ${operation.operationId} requires Ollama >= ${minVersion} ` +
                `but the runtime could not determine the server version ` +
                `(enforceVersion: 'strict').`,
              {
                operationId: operation.operationId,
                minRequiredVersion: minVersion,
                cause: err,
              },
            );
          }
          // 'auto' — fail-open: surface nothing, the server will reject if
          // it can't handle it.
          return undefined;
        });
        this.serverVersionCache = p;
      }
      serverVersion = (await this.serverVersionCache) ?? undefined;
    }

    if (serverVersion && compareVersions(serverVersion, minVersion) < 0) {
      throw new OllamaGenericClientError(
        `Operation ${operation.operationId} (${operation.method} ${operation.path}) ` +
          `requires Ollama >= ${minVersion} (server reports ${serverVersion}).`,
      );
    }
  }
}

/**
 * Pick the stream parser that matches the operation's declared transport
 * mode, returning a uniform `AsyncGenerator<T>`.
 *
 * - `ndjson` → one JSON object per line (native Ollama streaming).
 * - `sse`    → Server-Sent Events; each event's `data` field is parsed as
 *             JSON. Heartbeat/comment-only events and events whose `data`
 *             is the literal `[DONE]` sentinel are skipped (the OpenAI
 *             compatibility layer uses that sentinel to terminate streams).
 * - `json`   → not a streaming mode; callers should never reach this branch
 *             for a non-streaming operation. We throw defensively so a
 *             future operation that mis-declares its transport surfaces
 *             loudly instead of silently degrading.
 */
function parseStreamByMode<T>(
  mode: TransportMode,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  if (mode === 'ndjson') {
    return parseNdjsonStream<T>(body);
  }
  if (mode === 'sse') {
    return parseSseStreamAsJson<T>(body);
  }
  throw new OllamaGenericClientError(
    `Transport mode "${mode}" is not a streaming mode; cannot parse a stream for it.`,
  );
}

/**
 * Adapter that yields the JSON-decoded payload of each SSE `data` field.
 *
 * The hand-written OpenAI/Anthropic compatibility clients
 * (`src/integrations/{openai,anthropic}.ts`) consume raw `SseEvent`s and
 * apply provider-specific event-shape logic (tool-call accumulation,
 * reasoning deltas, etc.). The generated compatibility API surface is
 * intentionally shape-agnostic: it yields the raw JSON payload of each
 * event, leaving provider-specific interpretation to the caller. Consumers
 * who want the richer aggregated streaming experience should use
 * `client.openai` / `client.anthropic` instead of the generated API class.
 */
async function* parseSseStreamAsJson<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  for await (const event of parseSseStream(body)) {
    const data = event.data;
    if (!data) continue;
    // OpenAI's stream terminator sentinel — yield nothing; the generator
    // simply completes on the next iteration.
    if (data === '[DONE]') return;
    try {
      yield JSON.parse(data) as T;
    } catch (err) {
      throw new OllamaGenericClientError(`Failed to parse SSE event data as JSON: ${data}`, {
        cause: err,
      });
    }
  }
}

/**
 * Serialize a request body for byte counting (used by the
 * `maxRequestBytes` guard). The byte count mirrors what the HttpClient
 * would actually send on the wire: UTF-8 encoded JSON. Buffer (Node) and
 * Uint8Array inputs are passed through directly since their byte length
 * is already known.
 *
 * This intentionally mirrors HttpClient's serialization (`JSON.stringify`
 * with no whitespace) so the byte count is accurate against the actual
 * request payload — using a different serializer would let oversized
 * bodies through.
 */
function serializeForByteCount(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  // HttpClient calls JSON.stringify on the body before sending — match that.
  const json = JSON.stringify(body);
  return new TextEncoder().encode(json);
}

/**
 * Wave 13: detect whether a request body carries a non-empty `images`
 * array. Used by the request-size guard to select between the base
 * `maxRequestBytes` limit and the higher `maxRequestBytesWithImages`
 * limit (e.g. System One: 64 KiB without images, 32 MiB with).
 *
 * Returns true only when the body is an object with an `images` property
 * that is a non-empty array. Falsy/absent/empty images → false (base
 * limit applies).
 */
function bodyHasImages(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  const images = obj.images;
  return Array.isArray(images) && images.length > 0;
}
