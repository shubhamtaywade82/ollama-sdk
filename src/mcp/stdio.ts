/**
 * Optional Node.js MCP stdio connector.
 *
 * This subpath uses the official @modelcontextprotocol/client v2 package dynamically so
 * the root SDK entrypoint remains transport-agnostic and Edge-runtime compatible.
 *
 * Install @modelcontextprotocol/client separately when using this adapter.
 */

import type { McpClientLike } from './types.js';

const MCP_CLIENT_PACKAGE = '@modelcontextprotocol/client';
const MCP_STDIO_PACKAGE = '@modelcontextprotocol/client/stdio';

export interface StdioMcpServerParameters {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly maxBufferSize?: number | undefined;
  readonly stderr?: 'inherit' | 'pipe' | 'ignore' | undefined;
}

export interface StdioMcpClientOptions {
  readonly name?: string | undefined;
  readonly version?: string | undefined;
}

export interface StdioMcpConnection {
  readonly client: McpClientLike;
  readonly close: () => Promise<void>;
}

interface DynamicMcpClientModule {
  readonly Client: new (metadata: { name: string; version: string }) => {
    connect: (transport: unknown) => Promise<void>;
    close: () => Promise<void>;
    listTools: McpClientLike['listTools'];
    callTool: McpClientLike['callTool'];
  };
}

interface DynamicMcpStdioModule {
  readonly StdioClientTransport: new (server: StdioMcpServerParameters) => unknown;
}

async function loadStdioModules(): Promise<{
  readonly clientModule: DynamicMcpClientModule;
  readonly stdioModule: DynamicMcpStdioModule;
}> {
  try {
    const [clientModule, stdioModule] = await Promise.all([
      import(MCP_CLIENT_PACKAGE) as Promise<unknown>,
      import(MCP_STDIO_PACKAGE) as Promise<unknown>,
    ]);
    return {
      clientModule: clientModule as DynamicMcpClientModule,
      stdioModule: stdioModule as DynamicMcpStdioModule,
    };
  } catch (error) {
    throw new Error(
      'MCP stdio support requires @modelcontextprotocol/client >= 2.0.0. ' +
        'Install it with npm install @modelcontextprotocol/client.',
      { cause: error },
    );
  }
}

/**
 * Connects to a local MCP server over stdin/stdout using the official MCP TypeScript
 * client's Node-only StdioClientTransport.
 */
export async function connectStdioMcpClient(
  server: StdioMcpServerParameters,
  options: StdioMcpClientOptions = {},
): Promise<StdioMcpConnection> {
  if (!server.command) {
    throw new TypeError('MCP stdio server command must be a non-empty string');
  }

  const { clientModule, stdioModule } = await loadStdioModules();
  const client = new clientModule.Client({
    name: options.name ?? '@nemesis-oss/ollama-sdk',
    version: options.version ?? '1.0.0',
  });
  const transport = new stdioModule.StdioClientTransport({
    command: server.command,
    ...(server.args !== undefined ? { args: [...server.args] } : {}),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    ...(server.env !== undefined ? { env: server.env } : {}),
    ...(server.maxBufferSize !== undefined ? { maxBufferSize: server.maxBufferSize } : {}),
    ...(server.stderr !== undefined ? { stderr: server.stderr } : {}),
  });

  await client.connect(transport);

  return {
    client,
    close: () => client.close(),
  };
}
