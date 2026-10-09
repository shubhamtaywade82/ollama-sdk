/**
 * Model and blob management operations.
 */

import { listAvailableModels } from './capabilities/capabilities.js';
import {
  extractParameterNumCtx,
  findRunningModelContextLength,
  resolveContextLength,
  type ContextDiscoveryRequestOptions,
  type DiscoveredContextLength,
} from './context-discovery.js';
import { extractContextLength } from './capabilities/capabilities.js';
import { OllamaClientError, OllamaNotFoundError } from './errors.js';
import { KEEP_ALIVE_INDEFINITE, KEEP_ALIVE_UNLOAD } from './keep-alive.js';
import { normalizeProgressStream } from './streaming/normalize.js';
import type { OllamaStream } from './streaming/stream.js';
import type { ProgressStreamResult } from './streaming/types.js';
import type { BinaryBody } from './transport/http.js';
import type { RequestRunner } from './transport/runner.js';
import type {
  CopyRequestOptions,
  CreateRequestOptions,
  DeleteRequestOptions,
  GenerateResponse,
  ModelResponse,
  ProgressResponse,
  PsResponse,
  PullRequestOptions,
  PushRequestOptions,
  RequestCancellationOptions,
  ShowRequestOptions,
  ShowResponse,
  StatusResponse,
  VersionResponse,
} from './types.js';

/** Result of a convenience blob upload ({@link ModelsClient.createBlobFromData}). */
export interface BlobUploadResult {
  /** Content digest (`sha256:<hex>`) of the uploaded payload. */
  readonly digest: string;
  /** True when the server already had this blob (HTTP 200) and skipped writing. */
  readonly alreadyExisted: boolean;
}

/**
 * Every operation here targets one specific Ollama server's local model catalog or blob
 * store — unlike `chat`/`generate`/`embed`, a different endpoint isn't an interchangeable
 * substitute; it's a different catalog/store entirely. `singleEndpoint: true` disables
 * `OllamaClient`'s cross-endpoint failover for these calls (same-endpoint retry via
 * `withRetry` still applies), so a multi-endpoint setup never silently lists/mutates the
 * wrong server just because the intended one had a transient failure. See ADR 0008.
 */
export class ModelsClient {
  constructor(private readonly runner: RequestRunner) {}

  list(): Promise<ModelResponse[]> {
    return this.runner((http) => listAvailableModels(http), { singleEndpoint: true });
  }

  show(request: ShowRequestOptions): Promise<ShowResponse> {
    return this.runner(
      (http, signal) => http.request<ShowResponse>({ path: '/api/show', body: request, signal }),
      { ...request, singleEndpoint: true },
    );
  }

  pull(
    request: PullRequestOptions & { stream: true },
  ): Promise<OllamaStream<ProgressResponse, ProgressStreamResult>>;
  pull(request: PullRequestOptions & { stream?: false | undefined }): Promise<ProgressResponse>;
  pull(
    request: PullRequestOptions,
  ): Promise<ProgressResponse | OllamaStream<ProgressResponse, ProgressStreamResult>>;
  async pull(
    request: PullRequestOptions,
  ): Promise<ProgressResponse | OllamaStream<ProgressResponse, ProgressStreamResult>> {
    if (request.stream) {
      return this.runner(
        async (http, signal) => {
          const stream = await http.requestStream<ProgressResponse>({
            path: '/api/pull',
            body: { ...request, stream: true },
            signal,
          });
          return normalizeProgressStream(stream, signal);
        },
        { ...request, singleEndpoint: true, holdUntil: (stream) => stream.finalResult },
      );
    }
    return this.runner(
      (http, signal) =>
        http.request<ProgressResponse>({
          path: '/api/pull',
          body: { ...request, stream: false },
          signal,
        }),
      { ...request, singleEndpoint: true },
    );
  }

  push(
    request: PushRequestOptions & { stream: true },
  ): Promise<OllamaStream<ProgressResponse, ProgressStreamResult>>;
  push(request: PushRequestOptions & { stream?: false | undefined }): Promise<ProgressResponse>;
  push(
    request: PushRequestOptions,
  ): Promise<ProgressResponse | OllamaStream<ProgressResponse, ProgressStreamResult>>;
  async push(
    request: PushRequestOptions,
  ): Promise<ProgressResponse | OllamaStream<ProgressResponse, ProgressStreamResult>> {
    if (request.stream) {
      return this.runner(
        async (http, signal) => {
          const stream = await http.requestStream<ProgressResponse>({
            path: '/api/push',
            body: { ...request, stream: true },
            signal,
          });
          return normalizeProgressStream(stream, signal);
        },
        { ...request, singleEndpoint: true, holdUntil: (stream) => stream.finalResult },
      );
    }
    return this.runner(
      (http, signal) =>
        http.request<ProgressResponse>({
          path: '/api/push',
          body: { ...request, stream: false },
          signal,
        }),
      { ...request, singleEndpoint: true },
    );
  }

  create(
    request: CreateRequestOptions & { stream: true },
  ): Promise<OllamaStream<ProgressResponse, ProgressStreamResult>>;
  create(request: CreateRequestOptions & { stream?: false | undefined }): Promise<ProgressResponse>;
  create(
    request: CreateRequestOptions,
  ): Promise<ProgressResponse | OllamaStream<ProgressResponse, ProgressStreamResult>>;
  async create(
    request: CreateRequestOptions,
  ): Promise<ProgressResponse | OllamaStream<ProgressResponse, ProgressStreamResult>> {
    if (request.stream) {
      return this.runner(
        async (http, signal) => {
          const stream = await http.requestStream<ProgressResponse>({
            path: '/api/create',
            body: { ...request, stream: true },
            signal,
          });
          return normalizeProgressStream(stream);
        },
        { ...request, singleEndpoint: true, holdUntil: (stream) => stream.finalResult },
      );
    }
    return this.runner(
      (http, signal) =>
        http.request<ProgressResponse>({
          path: '/api/create',
          body: { ...request, stream: false },
          signal,
        }),
      { ...request, singleEndpoint: true },
    );
  }

  delete(request: DeleteRequestOptions): Promise<StatusResponse> {
    return this.runner(
      (http, signal) =>
        http.request<StatusResponse>({
          path: '/api/delete',
          method: 'DELETE',
          body: request,
          signal,
        }),
      { ...request, singleEndpoint: true },
    );
  }

  copy(request: CopyRequestOptions): Promise<StatusResponse> {
    return this.runner(
      (http, signal) => http.request<StatusResponse>({ path: '/api/copy', body: request, signal }),
      { ...request, singleEndpoint: true },
    );
  }

  ps(request?: RequestCancellationOptions): Promise<PsResponse> {
    return this.runner(
      (http, signal) => http.request<PsResponse>({ path: '/api/ps', method: 'GET', signal }),
      {
        singleEndpoint: true,
        ...(request?.signal !== undefined ? { signal: request.signal } : {}),
        ...(request?.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      },
    );
  }

  /**
   * Discovers the model's real context window from the server — no more
   * 2048/4096 guesswork. Consults, in precedence order:
   *
   *   1. `GET /api/ps` — the window the **running instance actually
   *      allocated** (exact, reflects the Modelfile `num_ctx` default and
   *      what fit in memory); skipped when the model isn't loaded, when
   *      `skipRunningCheck` is set, or harmlessly on servers without the
   *      field.
   *   2. `POST /api/show` `parameters` — a Modelfile-authored
   *      `num_ctx <n>` default, i.e. the window a cold load will allocate.
   *   3. `POST /api/show` `model_info["<arch>.context_length"]` — the
   *      model's **native GGUF maximum** (a ceiling to raise `num_ctx`
   *      toward, not the allocated window).
   *   4. Fallback — Ollama's conservative unset-`num_ctx` default (2048).
   *
   * The result carries every signal it found, so `nativeContextLength:
   * 131072` vs `contextLength: 4096` (a 32× gap seen in the official API
   * examples) is visible rather than guessed. Typical wiring:
   *
   * ```ts
   * const { contextLength, source, nativeContextLength } =
   *   await client.models.getContextLength({ model: 'gemma4' });
   * // -> { contextLength: 4096, source: 'running', nativeContextLength: 131072 }
   * ```
   *
   * Makes two server calls (`/api/ps` + `/api/show`) unless
   * `skipRunningCheck` is set. A 404 from `/api/ps` (endpoint without the
   * listing) is treated as "not running" and never fails the lookup;
   * other transport errors propagate normally.
   */
  async getContextLength(
    request: ContextDiscoveryRequestOptions,
  ): Promise<DiscoveredContextLength> {
    let running: number | undefined;
    if (request.skipRunningCheck !== true) {
      try {
        const ps = await this.ps({ signal: request.signal, timeoutMs: request.timeoutMs });
        running = findRunningModelContextLength(ps.models, request.model);
      } catch (err) {
        // Endpoints without the running-models listing (e.g. compat-only
        // hosts) still deserve parameter/model-info discovery.
        if (!(err instanceof OllamaNotFoundError)) throw err;
      }
    }
    const showRes = await this.show({
      model: request.model,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    });
    return resolveContextLength({
      running,
      parameter: extractParameterNumCtx(showRes.parameters),
      native: extractContextLength(showRes.model_info),
    });
  }

  version(): Promise<VersionResponse> {
    return this.runner(
      (http) => http.request<VersionResponse>({ path: '/api/version', method: 'GET' }),
      { singleEndpoint: true },
    );
  }

  /**
   * Immediately unloads `model` from VRAM/RAM by issuing an empty
   * `/api/generate` request with `keep_alive: 0`. The server
   * finalizes any in-flight generation, releases the model's
   * weights from GPU memory, and frees the slot for subsequent
   * pipelines (e.g. swap a vision encoder out before loading an
   * LLM).
   *
   * This is the ergonomic equivalent of:
   *
   * ```ts
   * client.generate({ model, prompt: '', keep_alive: 0 });
   * ```
   *
   * Use {@link pin} for the opposite lifecycle — pinning a model
   * indefinitely in VRAM for hot-loop inference.
   *
   * Resolves once the server acknowledges the unload. The promise
   * rejects on transport errors, model-not-found (404), or auth
   * failures — callers handling transient issues can retry via the
   * standard {@link withRetry} policy.
   *
   * See: https://github.com/ollama/ollama/blob/main/docs/faq.md
   *      #how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately
   */
  async unload(model: string): Promise<void> {
    await this.runner(
      (http, signal) =>
        http.request<GenerateResponse>({
          path: '/api/generate',
          body: { model, prompt: '', keep_alive: KEEP_ALIVE_UNLOAD, stream: false },
          signal,
        }),
      { model, singleEndpoint: true },
    );
  }

  /**
   * Pre-loads and pins `model` into VRAM indefinitely by issuing an
   * empty `/api/generate` request with `keep_alive: -1`. The server
   * loads the model into GPU memory (paying the cold-load latency
   * once) and keeps it resident until either:
   *
   *   - an explicit {@link unload} call is made,
   *   - the server process is restarted, or
   *   - the host runs out of VRAM and the server's own eviction
   *     policy kicks in.
   *
   * This is the ergonomic equivalent of:
   *
   * ```ts
   * client.generate({ model, prompt: '', keep_alive: -1 });
   * ```
   *
   * Use {@link unload} to release the pinned slot when the hot loop
   * is done — leaving models pinned indefinitely exhausts VRAM and
   * starves subsequent pipelines.
   *
   * Resolves once the server acknowledges the pin (i.e. the model
   * is fully loaded). The promise rejects on transport errors,
   * model-not-found (404), or VRAM-exhaustion failures.
   */
  async pin(model: string): Promise<void> {
    await this.runner(
      (http, signal) =>
        http.request<GenerateResponse>({
          path: '/api/generate',
          body: { model, prompt: '', keep_alive: KEEP_ALIVE_INDEFINITE, stream: false },
          signal,
        }),
      { model, singleEndpoint: true },
    );
  }

  async createBlob(digest: string, data: BinaryBody): Promise<void> {
    await this.runner(
      (http, signal) =>
        http.request<void>({
          path: `/api/blobs/${encodeURIComponent(digest)}`,
          method: 'POST',
          rawBody: data,
          signal,
        }),
      { singleEndpoint: true },
    );
  }

  async checkBlob(digest: string): Promise<boolean> {
    // Wave 12 (P2): previously this method caught every error and returned
    // false, which conflated "blob absent" (HTTP 404) with auth failures
    // (401/403), rate limits (429), server errors (5xx), network failures,
    // timeouts, and aborts. Callers had no way to distinguish "the blob
    // doesn't exist" from "the server is unreachable" — both looked like
    // `false`. That's a real SDK correctness issue: a transient network
    // blip would silently look like a missing blob, and a downstream
    // caller would proceed to re-upload (potentially burning bandwidth
    // and quota on a blob that was already there).
    //
    // Only HTTP 404 means "blob absent." Everything else propagates so
    // callers can branch on the actual failure mode. The OllamaNotFoundError
    // class is what HttpClient throws for 404s (see src/errors.ts).
    try {
      await this.runner(
        (http, signal) =>
          http.request<void>({
            path: `/api/blobs/${encodeURIComponent(digest)}`,
            method: 'HEAD',
            signal,
          }),
        { singleEndpoint: true },
      );
      return true;
    } catch (err) {
      if (err instanceof OllamaNotFoundError) return false;
      throw err;
    }
  }

  /**
   * Computes a blob digest the way Ollama's content-addressed store expects:
   * SHA-256 over the raw bytes, formatted as `sha256:<64 lowercase hex>`.
   *
   * Uses the Web Crypto API (`crypto.subtle.digest`), which exists in every
   * supported runtime — Node.js ≥ 19 exposes it as a global (this SDK
   * requires Node ≥ 20), and browsers/edge runtimes have always had it.
   */
  async computeBlobDigest(data: Uint8Array): Promise<string> {
    // Minimal structural type for Web Crypto's SubtleCrypto.digest — declared
    // locally because this project's `lib` is ES2022-only (no DOM types),
    // while Node ≥ 20 and every browser expose `crypto.subtle` as a global.
    const subtle = (
      globalThis as {
        crypto?:
          | {
              subtle?:
                | {
                    digest(
                      algorithm: 'SHA-256',
                      data: ArrayBufferView | ArrayBuffer,
                    ): Promise<ArrayBuffer>;
                  }
                | undefined;
            }
          | undefined;
      }
    ).crypto?.subtle;
    if (subtle === undefined) {
      throw new OllamaClientError(
        'computeBlobDigest requires the Web Crypto API (crypto.subtle), unavailable in this runtime.',
        { code: 'crypto_unavailable' },
      );
    }
    const digestBytes = await subtle.digest('SHA-256', data as unknown as ArrayBuffer);
    const hex = Array.from(new Uint8Array(digestBytes), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    return `sha256:${hex}`;
  }

  /**
   * Computes the SHA-256 digest of `data` and pushes it as a blob in one
   * step — the content-addressed upload Ollama's own tooling performs
   * (`curl -T file http://…/api/blobs/sha256:…`). Returns the digest, which
   * `/api/create`'s `files` field references.
   *
   * Pass `digest` to skip recomputation when the caller already knows it —
   * the server verifies the content against the digest and rejects mismatches.
   */
  async createBlobFromData(
    data: Uint8Array,
    opts?: { readonly digest?: string | undefined; readonly signal?: AbortSignal | undefined },
  ): Promise<BlobUploadResult> {
    const digest = opts?.digest ?? (await this.computeBlobDigest(data));
    const alreadyExisted = await this.checkBlob(digest);
    if (!alreadyExisted) {
      await this.createBlob(digest, data);
    }
    return { digest, alreadyExisted };
  }

  /**
   * Reads a local file and uploads it as a blob (Node.js only — dynamic
   * `node:fs` import, so browser bundles never pull it in). The file name
   * (basename) is what `/api/create`'s `files` map expects as the key, so
   * this returns it alongside the digest.
   */
  async createBlobFromFile(
    path: string,
    opts?: { readonly signal?: AbortSignal | undefined },
  ): Promise<BlobUploadResult & { readonly fileName: string }> {
    // Specifier hidden behind a variable so browser/edge bundlers never try
    // to resolve `node:fs` at build time — see src/vision.ts NODE_FS_MODULE.
    const nodeFsModule = 'node:fs';
    const { promises: fs } = (await import(nodeFsModule)) as typeof import('node:fs');
    const data = await fs.readFile(path);
    const result = await this.createBlobFromData(new Uint8Array(data), {
      ...opts,
    });
    const fileName = path.split(/[\\/]/).pop() ?? path;
    return { ...result, fileName };
  }

  /**
   * One-shot custom-model publishing from raw GGUF weights, following the
   * protocol Ollama's API reference documents: push a blob for the GGUF
   * bytes, then `POST /api/create` with `files: { <fileName>: <digest> }`.
   * Split GGUFs are supported via `files` — pass every shard's path.
   *
   * ```ts
   * await client.models.createModelFromGguf('my-model', '/path/to/model.gguf', {
   *   template: '{{ .Prompt }}',
   * });
   * ```
   *
   * @param model Name for the new model (e.g. `'my-model:latest'`).
   * @param gguf Path(s) to GGUF file(s) on the local filesystem.
   * @param opts Everything else `/api/create` accepts (`template`, `system`,
   *   `parameters`, `license`, `quantize`, …) except `files` and `from`.
   */
  async createModelFromGguf(
    model: string,
    gguf: string | readonly string[],
    opts?: Omit<CreateRequestOptions, 'model' | 'files' | 'from' | 'stream'>,
  ): Promise<ProgressResponse> {
    const paths = typeof gguf === 'string' ? [gguf] : gguf;
    if (paths.length === 0) {
      throw new OllamaClientError('createModelFromGguf: at least one GGUF path is required.', {
        code: 'invalid_request',
      });
    }
    const files: Record<string, string> = {};
    for (const path of paths) {
      const uploaded = await this.createBlobFromFile(path, { signal: opts?.signal });
      files[uploaded.fileName] = uploaded.digest;
    }
    const {
      model: _model,
      files: _files,
      from: _from,
      stream: _stream,
      ...rest
    } = (opts ?? {}) as CreateRequestOptions;
    return this.create({ ...rest, model, files, stream: false } as CreateRequestOptions & {
      stream: false;
    });
  }
}
