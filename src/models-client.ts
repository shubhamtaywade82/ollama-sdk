/**
 * Model and blob management operations.
 */

import { listAvailableModels } from './capabilities/capabilities.js';
import { normalizeProgressStream } from './streaming/normalize.js';
import type { OllamaStream } from './streaming/stream.js';
import type { ProgressStreamResult } from './streaming/types.js';
import type { BinaryBody, HttpClient } from './transport/http.js';
import type {
  CopyRequestOptions,
  CreateRequestOptions,
  DeleteRequestOptions,
  ModelResponse,
  ProgressResponse,
  PsResponse,
  PullRequestOptions,
  PushRequestOptions,
  ShowRequestOptions,
  ShowResponse,
  StatusResponse,
  VersionResponse,
} from './types.js';

export type RequestRunner = <T>(
  op: (http: HttpClient, signal: AbortSignal) => Promise<T>,
  opts?: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
    singleEndpoint?: boolean | undefined;
    model?: string | undefined;
  },
) => Promise<T>;

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
          return normalizeProgressStream(stream);
        },
        { ...request, singleEndpoint: true },
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
          return normalizeProgressStream(stream);
        },
        { ...request, singleEndpoint: true },
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
        { ...request, singleEndpoint: true },
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

  ps(): Promise<PsResponse> {
    return this.runner((http) => http.request<PsResponse>({ path: '/api/ps', method: 'GET' }), {
      singleEndpoint: true,
    });
  }

  version(): Promise<VersionResponse> {
    return this.runner(
      (http) => http.request<VersionResponse>({ path: '/api/version', method: 'GET' }),
      { singleEndpoint: true },
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
    } catch {
      return false;
    }
  }
}
