/**
 * First-class MCP-to-Ollama bridge.
 *
 * The core package deliberately stays transport-agnostic and Edge-compatible. Connect
 * to an MCP server with an MCP client implementation (stdio, Streamable HTTP, etc.)
 * then pass that client to this bridge.
 */
import type { ToolDefinition } from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { listAllMcpTools, loadMcpTools, type LoadMcpToolsOptions } from './mcp-tools.js';
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

  async listTools(signal?: AbortSignal): Promise<readonly McpToolDescriptor[]> {
    return listAllMcpTools(this.client, this.options, signal);
  }

  async definitions(signal?: AbortSignal): Promise<ToolDefinition[]> {
    return McpBridge.toOllamaTools(await this.listTools(signal), this.options);
  }

  async loadTools(signal?: AbortSignal) {
    return loadMcpTools(this.client, this.options, signal);
  }

  async register(registry: ToolRegistry, signal?: AbortSignal): Promise<void> {
    await registry.registerMany(await this.loadTools(signal));
  }
}
