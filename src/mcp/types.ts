/**
 * Duck-typed MCP (Model Context Protocol) client interfaces.
 * Decoupled from any specific MCP SDK.
 */

import type { z } from 'zod';

export interface McpToolAnnotations {
  readonly title?: string | undefined;
  readonly readOnlyHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
  readonly [key: string]: unknown;
}

export interface McpToolExecution {
  readonly taskSupport?: 'forbidden' | 'optional' | 'required' | undefined;
  readonly [key: string]: unknown;
}

export interface McpIcon {
  readonly src: string;
  readonly mimeType?: string | undefined;
  readonly sizes?: readonly string[] | undefined;
  readonly theme?: 'light' | 'dark' | undefined;
  readonly [key: string]: unknown;
}

export interface McpRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly allowInputRequired?: boolean | undefined;
}

export interface McpElicitationFormRequest {
  readonly mode?: 'form' | undefined;
  readonly message: string;
  readonly requestedSchema: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface McpElicitationUrlRequest {
  readonly mode: 'url';
  readonly message: string;
  readonly url: string;
  readonly elicitationId: string;
  readonly [key: string]: unknown;
}

export type McpElicitationRequest = McpElicitationFormRequest | McpElicitationUrlRequest;

export type McpElicitationResult =
  | { readonly action: 'accept'; readonly content?: Record<string, unknown> | undefined }
  | { readonly action: 'decline' | 'cancel' };

export interface McpElicitationHandlers {
  readonly form?: ((request: McpElicitationFormRequest) => Promise<McpElicitationResult> | McpElicitationResult) | undefined;
  readonly url?: ((request: McpElicitationUrlRequest) => Promise<McpElicitationResult> | McpElicitationResult) | undefined;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly annotations?: McpToolAnnotations | undefined;
  readonly execution?: McpToolExecution | undefined;
  readonly icons?: readonly McpIcon[] | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface McpListToolsResult {
  readonly tools: readonly McpToolDescriptor[];
  readonly nextCursor?: string | undefined;
}

export interface McpListToolsParams {
  readonly cursor?: string | undefined;
}

export interface McpContentBlock {
  readonly type: string;
  readonly text?: string | undefined;
  readonly annotations?: Record<string, unknown> | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
  readonly [key: string]: unknown;
}

export interface McpCallToolResult {
  readonly content: readonly McpContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
  readonly _meta?: Record<string, unknown> | undefined;
}

export interface McpInputRequiredResult {
  readonly resultType: 'input_required';
  readonly inputRequests?: Record<string, unknown> | undefined;
  readonly requestState?: string | undefined;
  readonly [key: string]: unknown;
}

export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTask {
  readonly taskId: string;
  readonly status: McpTaskStatus;
  readonly statusMessage?: string | undefined;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttl?: number | undefined;
  readonly pollInterval?: number | undefined;
}

export type McpTaskMethod = 'tasks/get' | 'tasks/result' | 'tasks/cancel';

export interface McpTaskRequest {
  readonly method: McpTaskMethod;
  readonly params: { readonly taskId: string };
}

export interface McpCreateTaskResult {
  readonly task: McpTask;
  readonly _meta?: Record<string, unknown> | undefined;
}

export type McpToolCallResult =
  | McpCallToolResult
  | McpInputRequiredResult
  | McpCreateTaskResult;

export interface McpServerCapabilities {
  readonly tasks?: {
    readonly requests?: {
      readonly tools?: { readonly call?: Record<string, unknown> | undefined } | undefined;
    } | undefined;
  } | undefined;
  readonly [key: string]: unknown;
}

export interface McpClientLike {
  getServerCapabilities?: (() => McpServerCapabilities | undefined) | undefined;
  request?: (<T>(
    request: McpTaskRequest,
    resultSchema: z.ZodType<T>,
    options?: McpRequestOptions,
  ) => Promise<T>) | undefined;
  listTools: (
    params?: McpListToolsParams,
    options?: McpRequestOptions,
  ) => Promise<McpListToolsResult>;
  callTool: (
    params: {
      readonly name: string;
      readonly arguments?: Record<string, unknown>;
      readonly task?: { readonly ttl?: number | undefined } | undefined;
      readonly inputResponses?: Record<string, unknown> | undefined;
      readonly requestState?: string | undefined;
    },
    options?: McpRequestOptions,
  ) => Promise<McpToolCallResult>;
}
