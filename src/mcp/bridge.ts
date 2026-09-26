/**
 * First-class MCP-to-Ollama bridge.
 *
 * The core package deliberately stays transport-agnostic and Edge-compatible. Connect
 * to an MCP server with an MCP client implementation (stdio, Streamable HTTP, etc.)
 * then pass that client to this bridge.
 */
import type { ToolDefinition } from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { loadMcpTools, type LoadMcpToolsOptions } from './mcp-tools.js';
import type { McpClientLike, McpToolDescriptor } from './types.js';

export type McpBridgeOptions = LoadMcpToolsOptions;

export class McpBridge {
  constructor(
    private readonly client: McpClientLike,
    private readonly options: McpBridgeOptions = {},
  ) {}

  static toOllamaTools(
    tools: readonly McpToolDescriptor[],
    options: McpBridgeOptions = {},
  ): ToolDefinition[] {
    const prefix = options.namePrefix ?? '';
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: prefix + tool.name,
        description: tool.description ?? '',
        parameters: {
          ...(tool.inputSchema ?? { type: 'object', properties: {} }),
          type: 'object' as const,
          properties: ((tool.inputSchema ?? {})['properties'] ?? {}) as ToolDefinition['function']['parameters']['properties'],
        } as ToolDefinition['function']['parameters'],
      },
    }));
  }

  async listTools(): Promise<readonly McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.client.listTools(cursor !== undefined ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    return tools;
  }

  async definitions(): Promise<ToolDefinition[]> {
    return McpBridge.toOllamaTools(await this.listTools(), this.options);
  }

  async loadTools() {
    return loadMcpTools(this.client, this.options);
  }

  async register(registry: ToolRegistry): Promise<void> {
    await registry.registerMany(await this.loadTools());
  }
}
