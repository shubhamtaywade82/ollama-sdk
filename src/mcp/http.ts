/**
 * Optional remote MCP transport connectors.
 *
 * The root SDK stays transport-agnostic and Edge-compatible. This subpath dynamically
 * loads the official MCP TypeScript client so applications can connect to remote servers
 * over modern Streamable HTTP or legacy SSE.
 */

import type { McpClientLike } from './types.js';

const MCP_CLIENT_PACKAGE = '@modelcontextprotocol/client';

export type McpHttpTransport = 'streamable-http' | 'sse' | 'auto';

export interface HttpMcpClientOptions {
  /** Absolute MCP server URL, for example https://example.com/mcp. */
  readonly url: string | URL;
  /**
   * Transport selection. Defaults to Streamable HTTP. In 'auto' mode, a compatible 4xx
   * from the modern transport triggers a retry with the legacy SSE transport.
   */
  readonly transport?: McpHttpTransport | undefined;
  readonly name?: string | undefined;
  readonly version?: string | undefined;
  /** Fetch RequestInit forwarded to the MCP transport for remote authentication/proxy headers. */
  readonly requestInit?: RequestInit | undefined;
  /** Optional fetch implementation forwarded to the MCP transport. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface HttpMcpConnection {
  readonly client: McpClientLike;
  readonly transport: 'streamable-http' | 'sse';
  readonly close: () => Promise<void>;
  /**
   * Streamable HTTP only: terminate the server-side MCP session when one exists.
   * Undefined for legacy SSE connections.
   */
  readonly terminateSession?: (() => Promise<void>) | undefined;
}

interface DynamicMcpClient {
  readonly Client: new (
    metadata: { name: string; version: string },
  ) => {
    connect: (transport: unknown) => Promise<void>;
    close: () => Promise<void>;
    listTools: McpClientLike['listTools'];
    callTool: McpClientLike['callTool'];
  };
  readonly StreamableHTTPClientTransport: new (
    url: URL,
    options?: unknown,
  ) => unknown;
  readonly SSEClientTransport: new (url: URL, options?: unknown) => unknown;
}

async function loadClientModule(): Promise<DynamicMcpClient> {
  try {
    return (await import(MCP_CLIENT_PACKAGE)) as unknown as DynamicMcpClient;
  } catch (error) {
    throw new Error(
      'MCP HTTP support requires @modelcontextprotocol/client >= 2.0.0. ' +
        'Install it with npm install @modelcontextprotocol/client.',
      { cause: error },
    );
  }
}

function parseServerUrl(value: string | URL): URL {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('MCP HTTP server URL must use http: or https:');
  }
  return url;
}

function transportOptions(options: HttpMcpClientOptions): Record<string, unknown> {
  return {
    ...(options.requestInit !== undefined ? { requestInit: options.requestInit } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  };
}

function connectionFrom(
  client: DynamicMcpClient['Client'] extends new (...args: infer _Args) => infer C ? C : never,
  transport: unknown,
  kind: 'streamable-http' | 'sse',
): HttpMcpConnection {
  const transportWithTermination = transport as {
    terminateSession?: (() => Promise<void>) | undefined;
  };

  return {
    client,
    transport: kind,
    close: () => client.close(),
    ...(kind === 'streamable-http' && typeof transportWithTermination.terminateSession === 'function'
      ? { terminateSession: () => transportWithTermination.terminateSession!() }
      : {}),
  };
}

async function connectWithTransport(
  mode: Exclude<McpHttpTransport, 'auto'>,
  url: URL,
  options: HttpMcpClientOptions,
  modules: DynamicMcpClient,
): Promise<HttpMcpConnection> {
  const client = new modules.Client({
    name: options.name ?? '@nemesis-oss/ollama-sdk',
    version: options.version ?? '1.0.0',
  });
  const transport =
    mode === 'streamable-http'
      ? new modules.StreamableHTTPClientTransport(url, transportOptions(options))
      : new modules.SSEClientTransport(url, transportOptions(options));

  await client.connect(transport);
  return connectionFrom(client, transport, mode);
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as Record<string, unknown>;
  if (typeof value.status === 'number') return value.status;
  if (typeof value.statusCode === 'number') return value.statusCode;

  const response = value.response;
  if (typeof response === 'object' && response !== null && typeof (response as Record<string, unknown>).status === 'number') {
    return (response as Record<string, number>).status;
  }

  const cause = value.cause;
  if (cause !== error) return responseStatus(cause);
  return undefined;
}

function shouldFallbackToSse(error: unknown): boolean {
  const status = responseStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}

/**
 * Connect to a remote MCP server.
 *
 * Defaults to modern Streamable HTTP. Use 'sse' for an explicitly legacy server or
 * 'auto' to try Streamable HTTP and fall back to SSE only for a non-authentication 4xx
 * response, avoiding accidental downgrade on credentials, throttling, or server failures.
 */
export async function connectMcpHttpClient(
  options: HttpMcpClientOptions,
): Promise<HttpMcpConnection> {
  const url = parseServerUrl(options.url);
  const mode = options.transport ?? 'streamable-http';
  if (mode !== 'auto') {
    return connectWithTransport(mode, url, options, await loadClientModule());
  }

  const modules = await loadClientModule();
  try {
    return await connectWithTransport('streamable-http', url, options, modules);
  } catch (error) {
    if (!shouldFallbackToSse(error)) throw error;
    try {
      return await connectWithTransport('sse', url, options, modules);
    } catch (sseError) {
      throw new Error(
        'MCP Streamable HTTP was unavailable and the legacy SSE fallback also failed.',
        { cause: sseError },
      );
    }
  }
}

export async function connectStreamableHttpMcpClient(
  options: Omit<HttpMcpClientOptions, 'transport'>,
): Promise<HttpMcpConnection> {
  return connectMcpHttpClient({ ...options, transport: 'streamable-http' });
}

export async function connectSseMcpClient(
  options: Omit<HttpMcpClientOptions, 'transport'>,
): Promise<HttpMcpConnection> {
  return connectMcpHttpClient({ ...options, transport: 'sse' });
}
