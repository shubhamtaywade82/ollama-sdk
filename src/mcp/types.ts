/**
 * Duck-typed MCP (Model Context Protocol) client interfaces.
 * Decoupled from any specific MCP SDK.
 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly annotations?: Record<string, unknown> | undefined;
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
  readonly [key: string]: unknown;
}
export interface McpCallToolResult {
  readonly content: readonly McpContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
}
export interface McpClientLike {
  listTools: (params?: McpListToolsParams) => Promise<McpListToolsResult>;
  callTool: (params: {
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
  }) => Promise<McpCallToolResult>;
}
