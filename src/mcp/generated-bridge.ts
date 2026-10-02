/**
 * Generated Ollama MCP tools — runtime adapter.
 *
 * Reads the descriptor list from `src/generated/mcp/tools.json` (the Wave 6
 * MCP emitter output) and exposes them as a `McpToolDescriptor[]` that
 * `McpBridge` can register. The actual call execution delegates to the
 * generated `OllamaRuntime` via the user-provided runtime instance.
 *
 * Usage:
 * ```ts
 * import { NativeApi, OllamaRuntime } from '@nemesis-oss/ollama-sdk/runtime';
 * import { createGeneratedOllamaTools } from '@nemesis-oss/ollama-sdk/mcp/generated';
 *
 * const runtime = new OllamaRuntime({ http });
 * const tools = createGeneratedOllamaTools(runtime);
 * bridge.registerTools(tools);
 * ```
 *
 * This is a Wave 6 opt-in feature — the existing McpBridge continues to work
 * unchanged. Users who want generated MCP tools import this adapter
 * explicitly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { McpToolDescriptor } from './types.js';
import { OllamaRuntime } from '../generated/runtime/runtime.js';
import type { OperationDefinition } from '../generated/runtime/operation-definition.js';

interface GeneratedToolEntry extends McpToolDescriptor {
  readonly _operationId: string;
}

interface GeneratedToolsFile {
  readonly _comment?: string;
  readonly tools: readonly GeneratedToolEntry[];
}

/**
 * Resolve the path to `tools.json` across runtime environments:
 *
 *   - **In source (development):** `src/generated/mcp/tools.json`
 *   - **In the published tarball:** `dist/mcp/tools.json` (copied by tsup's
 *     `onSuccess` hook; see tsup.config.ts)
 *
 * The dist bundle is at `dist/mcp-generated.js`, so the JSON sits two
 * directories up + into `mcp/`. The source file is at
 * `src/mcp/generated-bridge.ts`, so the JSON sits one directory up +
 * into `generated/mcp/`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_JSON_PATH = (() => {
  // Try the source layout first (development), then fall back to the dist
  // layout (published). The order matters because in a tsx-run dev env
  // we may be executing from `src/mcp/generated-bridge.ts`, but in a
  // consumer install we're at `dist/mcp-generated.js`.
  const candidates = [
    resolve(HERE, '../generated/mcp/tools.json'), // source layout
    resolve(HERE, 'mcp/tools.json'), // dist layout (next to mcp-generated.js)
    resolve(HERE, '../mcp/tools.json'), // alt dist layout (sibling of bundled dir)
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // try next candidate
    }
  }
  // Fall back to the source-layout path; the error will surface with a
  // clearer message when the loader is actually invoked.
  return candidates[0] ?? resolve(HERE, '../generated/mcp/tools.json');
})();

let cachedTools: readonly GeneratedToolEntry[] | undefined;

/** Load and cache the generated tool descriptors from tools.json. */
export function loadGeneratedOllamaTools(): readonly GeneratedToolEntry[] {
  if (cachedTools) return cachedTools;
  const raw = readFileSync(TOOLS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw) as GeneratedToolsFile;
  cachedTools = parsed.tools;
  return cachedTools;
}

/** Drop the `_operationId` field before exposing the descriptor externally. */
function publicDescriptor(entry: GeneratedToolEntry): McpToolDescriptor {
  const { _operationId, ...rest } = entry;
  void _operationId;
  return rest;
}

/**
 * Build a list of MCP tool descriptors for the generated Ollama operations.
 * Each tool can be invoked by name via {@link callGeneratedOllamaTool}.
 *
 * The descriptors are read once and cached for the lifetime of the process.
 */
export function listGeneratedOllamaTools(): readonly McpToolDescriptor[] {
  return loadGeneratedOllamaTools().map(publicDescriptor);
}

/**
 * Invoke a generated tool by name. The `name` must match a tool from
 * {@link listGeneratedOllamaTools}.
 *
 * Returns a `McpCallToolResult` containing the structured response. The
 * caller (typically `McpBridge`) is responsible for serializing the result
 * back over the MCP transport.
 */
export async function callGeneratedOllamaTool(
  runtime: OllamaRuntime,
  name: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<{ content: readonly { type: 'text'; text: string }[]; structuredContent: unknown }> {
  const tools = loadGeneratedOllamaTools();
  const entry = tools.find((t) => t.name === name);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      structuredContent: { error: 'unknown_tool', name },
    };
  }

  // Look up the operation in the IR by id. We re-import the operations
  // module to avoid a circular dependency at module-load time.
  const operations = await import('../generated/api/operations.js');
  const opKey = `${entry._operationId}Op` as keyof typeof operations;
  const operation = operations[opKey] as OperationDefinition | undefined;
  if (!operation || typeof operation !== 'object' || !('operationId' in operation)) {
    return {
      content: [{ type: 'text', text: `Operation not found for ${name}` }],
      structuredContent: { error: 'operation_not_found', name },
    };
  }

  try {
    // Wave 15 (P0): split path/query/header parameters from the request
    // body. The MCP input schema may declare path parameters (e.g. `model`
    // for /v1/models/{model}) — those must be passed as `pathParams` to
    // the runtime, not put in the request body. The operation's
    // `parameters` field tells us which args are path/query/header vs body.
    const opParams = operation.parameters ?? [];
    const pathParams: Record<string, string> = {};
    const queryParams: Record<string, string> = {};
    const headerParams: Record<string, string> = {};
    const bodyArgs: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      const paramDef = opParams.find((p) => p.name === key);
      if (paramDef) {
        if (paramDef.in === 'path') {
          pathParams[key] = String(value);
        } else if (paramDef.in === 'query') {
          queryParams[key] = String(value);
        } else if (paramDef.in === 'header') {
          headerParams[key] = String(value);
        }
      } else {
        // Not a declared parameter → goes in the request body.
        bodyArgs[key] = value;
      }
    }

    const hasBody = Object.keys(bodyArgs).length > 0;
    const result = await runtime.invoke<unknown>({
      operation,
      body: hasBody ? bodyArgs : undefined,
      ...(Object.keys(pathParams).length > 0 ? { pathParams } : {}),
      ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
      ...(Object.keys(headerParams).length > 0 ? { headerParams } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Ollama tool ${name} failed: ${message}` }],
      structuredContent: { error: 'tool_failed', name, message },
    };
  }
}
