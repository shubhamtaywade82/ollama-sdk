/**
 * Duck-typed MCP (Model Context Protocol) client interfaces.
 * Decoupled from any specific MCP SDK.
 */

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

export interface McpClientLike {
  listTools: (
    params?: McpListToolsParams,
    options?: McpRequestOptions,
  ) => Promise<McpListToolsResult>;
  callTool: (
    params: {
      readonly name: string;
      readonly arguments?: Record<string, unknown>;
    },
    options?: McpRequestOptions,
  ) => Promise<McpCallToolResult>;
}
