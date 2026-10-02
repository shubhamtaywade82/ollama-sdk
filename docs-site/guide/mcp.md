---
outline: [2, 3]
---

# MCP Integration

The Model Context Protocol (MCP) is an open standard for exposing tools, resources, and prompts to LLM-based applications. The SDK exposes a transport-neutral `McpBridge` that converts MCP tool descriptors into native Ollama function tools — and registers executable MCP-backed tools on a `ToolRegistry` for use by `Agent` or direct `chat({ tools })` calls.

## Architecture

The core package deliberately stays **transport-agnostic and Edge-runtime safe**. The bridge accepts any `McpClientLike` — an object with `listTools()` and `callTool()` methods — and the actual transport (stdio, Streamable HTTP, SSE, WebSocket) lives behind optional subpath exports:

```
@nemesis-oss/ollama-sdk              — McpBridge (transport-neutral)
@nemesis-oss/ollama-sdk/mcp/stdio    — connectStdioMcpClient (Node-only)
@nemesis-oss/ollama-sdk/mcp/http     — connectMcpHttpClient (Edge-safe)
@nemesis-oss/ollama-sdk/mcp/generated — generated MCP tools backed by the Ollama API itself
```

This keeps the root bundle free of Node-only imports while still supporting every transport.

## A minimal MCP bridge

Bring your own MCP client (mock, real, or generated), pass it to `McpBridge`, and register the resulting tools:

```typescript
import { McpBridge, ToolRegistry, type McpClientLike } from '@nemesis-oss/ollama-sdk';

const mcpClient: McpClientLike = {
  listTools: async () => ({
    tools: [
      {
        name: 'mcp_calc',
        description: 'Evaluate an arithmetic expression',
        inputSchema: {
          type: 'object',
          properties: { expression: { type: 'string' } },
          required: ['expression'],
        },
      },
    ],
  }),
  callTool: async ({ name, arguments: args }) => {
    if (name === 'mcp_calc') {
      const expr = String(args?.['expression'] ?? '0');
      // In production, actually evaluate `expr`.
      return { content: [{ type: 'text', text: `Result: 42` }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] };
  },
};

const bridge = new McpBridge(mcpClient, { namePrefix: 'mcp_' });
const registry = new ToolRegistry();
await bridge.register(registry);

// Inspect the converted Ollama tool definitions:
console.log(registry.definitions());
// [{ type: 'function', function: { name: 'mcp_mcp_calc', ... } }]
```

The `namePrefix` option namespaces MCP tools to avoid collisions with locally-defined tools.

## Connecting a real MCP server (stdio)

Use the optional `@nemesis-oss/ollama-sdk/mcp/stdio` subpath — it depends on `@modelcontextprotocol/client` (a peer dependency):

```typescript
import { connectStdioMcpClient } from '@nemesis-oss/ollama-sdk/mcp/stdio';
import { Agent, McpBridge, OllamaClient, ToolRegistry } from '@nemesis-oss/ollama-sdk';

const connection = await connectStdioMcpClient({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
});

const bridge = new McpBridge(connection.client, { namePrefix: 'mcp_' });
const registry = new ToolRegistry();
await bridge.register(registry);

const client = new OllamaClient();
const agent = new Agent(client, { tools: registry, maxIterations: 10 });

const result = await agent.run({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'List the available files in /tmp.' }],
});

console.log(result.finalMessage.content);

await connection.close();
```

## Connecting a remote MCP server (Streamable HTTP)

`@nemesis-oss/ollama-sdk/mcp/http` is Edge-safe — uses the official MCP v2 Streamable HTTP transport (with SSE fallback):

```typescript
import { connectMcpHttpClient } from '@nemesis-oss/ollama-sdk/mcp/http';
import { Agent, McpBridge, OllamaClient, ToolRegistry } from '@nemesis-oss/ollama-sdk';

const connection = await connectMcpHttpClient({
  url: 'https://example.com/mcp',
  transport: 'auto', // tries Streamable HTTP first, falls back to SSE on compatible 4xx
  requestInit: {
    headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
  },
});

const bridge = new McpBridge(connection.client, { namePrefix: 'mcp_' });
const registry = new ToolRegistry();
await bridge.register(registry);

const client = new OllamaClient();
const agent = new Agent(client, { tools: registry });

const result = await agent.run({
  model: 'qwen3',
  messages: [{ role: 'user', content: 'Use the MCP tools to complete this task.' }],
});

await connection.close();
console.log(result.finalMessage.content);
```

`transport: 'auto'` (default) tries Streamable HTTP first and falls back to legacy SSE only on a compatible non-authentication 4xx response. Pass `'sse'` explicitly to force the legacy transport.

## Using MCP tools with the Agent loop

Once registered, MCP-backed tools behave exactly like locally-defined tools — the `Agent` loop calls them, validates arguments, recovers from errors, and respects `maxIterations`/`maxToolCalls`:

```typescript
import { Agent, McpBridge, OllamaClient, ToolRegistry, defineTool } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';

const registry = new ToolRegistry();

// Mix MCP tools with locally-defined tools:
const localTool = defineTool({
  name: 'now',
  description: 'Get the current ISO timestamp',
  schema: z.object({}),
  execute: async () => ({ iso: new Date().toISOString() }),
});
registry.register(localTool);

const bridge = new McpBridge(mcpClient, { namePrefix: 'mcp_' });
await bridge.register(registry);

const agent = new Agent(new OllamaClient(), {
  tools: registry,
  maxIterations: 10,
  hooks: {
    onToolCallStart: (call) => console.log(`→ ${call.function.name}`, call.function.arguments),
    onToolCallEnd: (result) => console.log(`← ${result.toolName}: ${result.outputString.slice(0, 80)}`),
  },
});

const result = await agent.run({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Use the MCP tools and the now() tool to answer: what time is it and what files are in /tmp?' }],
});
```

## Manual discovery and execution

If you don't want to use `Agent`, you can discover tools, pass them to `chat`, and execute the model's requested calls yourself:

```typescript
import { loadMcpTools, OllamaClient, ToolRegistry } from '@nemesis-oss/ollama-sdk';

const mcpTools = await loadMcpTools(mcpClient);
const registry = new ToolRegistry(mcpTools);

const client = new OllamaClient();
const res = await client.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Use mcp_calc to compute 6 * 7.' }],
  tools: registry.definitions(),
  stream: false,
});

if (res.message.tool_calls?.length) {
  const results = await registry.executeToolCalls(res.message.tool_calls);
  for (const r of results) {
    console.log(r.toolName, r.outputString);
  }
}
```

## `resultMode: 'structured'` for raw MCP results

By default, MCP tool results are flattened into a model-friendly text representation (the historical behavior). For programmatic access to the raw MCP `CallToolResult` — including `structuredContent`, content blocks, `isError`, and `_meta` — set `resultMode: 'structured'`:

```typescript
import { loadMcpTools } from '@nemesis-oss/ollama-sdk';

const tools = await loadMcpTools(mcpClient, { resultMode: 'structured' });
```

In structured mode, the tool's `execute` returns the raw MCP `CallToolResult` rather than a flattened string. This is useful when:

- You need to inspect `structuredContent` (machine-readable output) separately from the model-visible text.
- You need to detect `isError: true` (model-readable errors that aren't transport failures).
- You need to forward `_meta` (request/response metadata).

## JSON Schema validation at the boundary

MCP tool arguments are validated against the tool's advertised JSON Schema **before** the MCP server is called — preventing invalid model-generated arguments from crossing the protocol boundary. Validation covers object, array, scalar, required, enum, and common numeric/string constraints.

```typescript
// If the model passes { expression: 42 } (wrong type), the registry throws
// OllamaToolValidationError BEFORE the MCP server is ever called.
```

## Input-required mode (human-in-the-loop)

Some MCP servers return `input_required` responses when they need user input. By default, the bridge forwards these unchanged (use `resultMode: 'structured'` for raw values, including the opaque `requestState` and keyed `inputRequests`). The bridge **does not** solicit data or retry the tool call itself.

For automatic handling, set `inputRequiredMode: 'automatic'` on a connector and provide elicitation handlers:

```typescript
const connection = await connectStdioMcpClient(
  { command: 'npx', args: ['-y', '@modelcontextprotocol/server-example'] },
  {
    elicitation: {
      form: async (request) => collectAndValidateForm(request),
      url: async (request) => {
        const approved = await askUserToOpen(request.url, request.message);
        return { action: approved ? 'accept' : 'decline' };
      },
    },
    inputRequiredMode: 'manual', // default — host controls the loop
  },
);

// In manual mode, the host gathers responses and retries with the same requestState:
await connection.client.callTool(
  { name, arguments: args, inputResponses, requestState },
  { allowInputRequired: true },
);
```

The requested modes (form, URL) are declared as client capabilities before connection, and the host retains control over user interaction. No URL is opened automatically — URL handlers should show the destination and obtain consent before accepting or opening it.

## Legacy task support

For legacy task-capable servers, required task tools (`execution.taskSupport: "required"`) are invoked using task augmentation. Optional task-capable tools remain synchronous unless `taskMode: 'all-supported'` is set. Set `taskTtlMs` to request a task lifetime:

```typescript
const bridge = new McpBridge(connection.client, {
  namePrefix: 'mcp_',
  taskMode: 'all-supported',
  taskTtlMs: 60_000,
});

// Task creation and input_required task statuses are preserved (serialized as JSON in text mode);
// no polling starts automatically. The host controls progress:
const status = await bridge.getTaskStatus(taskId);
const result = await bridge.getTaskResult(taskId);
await bridge.cancelTask(taskId);
```

## Refreshing the tool catalog

`bridge.refresh(registry)` re-fetches the current MCP tool catalog into an existing registry without clearing locally-defined tools:

```typescript
const bridge = new McpBridge(connection.client, { namePrefix: 'mcp_' });
const registry = new ToolRegistry();
await bridge.register(registry);

// ...later, the MCP server added new tools...
await bridge.refresh(registry);
console.log(registry.definitions().length); // updated
```

## Generated MCP tools (Ollama API as MCP)

The contract-first pipeline also produces 21 MCP tool descriptors (one per documented Ollama operation) at `src/generated/mcp/tools.json`. The runtime adapter at `@nemesis-oss/ollama-sdk/mcp/generated` exposes them as a callable tool registry — letting any MCP-compatible host drive an Ollama server without writing tool glue:

```typescript
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';
import { HttpClient } from '@nemesis-oss/ollama-sdk';
import {
  listGeneratedOllamaTools,
  callGeneratedOllamaTool,
} from '@nemesis-oss/ollama-sdk/mcp/generated';

const http = new HttpClient({ baseUrl: 'http://localhost:11434' });
const runtime = new OllamaRuntime({ http });

const tools = listGeneratedOllamaTools();
// [{ name: 'ollama_chat', inputSchema: {...}, annotations: {...} }, ...]

const result = await callGeneratedOllamaTool(runtime, 'ollama_version', {});
console.log(result.structuredContent); // { version: '0.5.0' }
```

See [Contract-First Architecture](./contract-first) for the full pipeline.

## Errors

MCP failures throw `OllamaMcpError` (a subclass of `OllamaClientError`) with `code: 'mcp_error'` and a `mcpMethod` field (`'listTools'`, `'callTool'`, `'tools/call'`, `'tasks/get'`, `'tasks/result'`, `'tasks/cancel'`). Argument validation failures throw `OllamaToolValidationError` like any other tool.

## Next steps

- **[Agents & Tool Calling](./agents)** — the `Agent` loop that calls MCP tools autonomously.
- **[Contract-First Architecture](./contract-first)** — how MCP tool descriptors are generated from the canonical IR.
- **[ADR 0011: MCP Boundary and Agent Tool Preconditions](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0011-mcp-boundary-and-agent-tool-preconditions.md)** — why the core package stays transport-agnostic.
- **[ADR 0012: MCP Remote Transport Boundary](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0012-mcp-remote-transport-boundary.md)** — the Streamable HTTP / SSE split.
- **[ADR 0016: MCP Tool Generation from the IR](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0016-mcp-tool-generation.md)** — how the 21 generated Ollama tools are produced.
