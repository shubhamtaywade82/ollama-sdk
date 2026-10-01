/**
 * First-class MCP-to-Ollama bridge.
 *
 * The core package deliberately stays transport-agnostic and Edge-compatible. Connect
 * to an MCP server with an MCP client implementation (stdio, Streamable HTTP, etc.)
 * then pass that client to this bridge.
 */
import type { ToolDefinition } from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { OllamaMcpError } from '../errors.js';
import { z } from 'zod';
import { listAllMcpTools, loadMcpTools, type LoadMcpToolsOptions } from './mcp-tools.js';
import type {
  McpClientLike,
  McpCallToolResult,
  McpTask,
  McpTaskMethod,
  McpToolDescriptor,
} from './types.js';

export type McpBridgeOptions = LoadMcpToolsOptions;

const taskSchema = z.object({
  taskId: z.string(),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttl: z.number().optional(),
  pollInterval: z.number().optional(),
}).passthrough();
const callToolResultSchema = z.custom<McpCallToolResult>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    Array.isArray(value.content),
);

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

  /** Refreshes the current MCP tool catalog into an existing registry without clearing local tools. */
  async refresh(registry: ToolRegistry, signal?: AbortSignal): Promise<void> {
    await registry.registerMany(await this.loadTools(signal));
  }

  /** Fetches one legacy MCP task's current status without starting a polling loop. */
  async getTaskStatus(taskId: string, signal?: AbortSignal): Promise<McpTask> {
    return this.requestTask(
      'tasks/get',
      taskId,
      taskSchema,
      signal,
    );
  }

  /** Retrieves a completed legacy MCP task's result. */
  async getTaskResult(taskId: string, signal?: AbortSignal): Promise<McpCallToolResult> {
    return this.requestTask(
      'tasks/result',
      taskId,
      callToolResultSchema,
      signal,
    );
  }

  /** Cancels one legacy MCP task. */
  async cancelTask(taskId: string, signal?: AbortSignal): Promise<McpTask> {
    return this.requestTask(
      'tasks/cancel',
      taskId,
      taskSchema,
      signal,
    );
  }

  private requestTask<T>(
    method: McpTaskMethod,
    taskId: string,
    resultSchema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.client.request === undefined) {
      throw new OllamaMcpError(
        `MCP client does not support ${method} requests`,
        { mcpMethod: method },
      );
    }
    return this.client.request(
      { method, params: { taskId } },
      resultSchema,
      signal !== undefined ? { signal } : undefined,
    );
  }
}
