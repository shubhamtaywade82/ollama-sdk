import { type McpClientLike, registerMcpTools, ToolRegistry } from '../../src/index.js';
import { labLogger } from '../support/logger.js';

const mockMultiMcpClient: McpClientLike = {
  listTools: async () => ({
    tools: [
      {
        name: 'read_file',
        description: 'Read file from disk',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'write_file',
        description: 'Write file to disk',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }),
  callTool: async ({ name }) => ({
    content: [{ type: 'text', text: `Called ${name}` }],
  }),
};

async function main(): Promise<void> {
  const registry = new ToolRegistry();
  await registerMcpTools(registry, mockMultiMcpClient, { namePrefix: 'fs_' });

  const defs = registry.definitions();

  await labLogger.log({
    experimentId: '11-mcp-client-adapter',
    timestamp: new Date().toISOString(),
    provider: 'mcp-adapter',
    endpoint: 'local-memory',
    model: 'registry',
    operation: 'registerMcpTools-with-prefix',
    response: {
      registeredToolCount: defs.length,
      toolNames: defs.map((d) => d.function.name),
    },
  });
}

void main();
