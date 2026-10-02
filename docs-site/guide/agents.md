---
outline: [2, 3]
---

# Agents & Tool Calling

The `Agent` class is a multi-turn `chat` + tool-execution loop. It runs the model, executes any requested tool calls, appends the results to history, and loops until the model responds without further tool calls — or until `maxIterations` is exceeded. It handles capability preflight, automatic context sizing, parallel tool execution, and self-correcting error recovery.

## A simple agent

```typescript
import { Agent, OllamaClient, defineTool, ToolRegistry } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';

const client = new OllamaClient();

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  schema: z.object({ city: z.string().describe('City name, e.g. "Tokyo"') }),
  execute: async ({ city }) => {
    // In production, call a real weather API.
    return { city, temperature: 22, condition: 'Sunny', unit: 'celsius' };
  },
});

const registry = new ToolRegistry([weatherTool]);
const agent = new Agent(client, { tools: registry, maxIterations: 5 });

const result = await agent.run({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'What is the weather in Tokyo and Paris?' }],
});

console.log(result.finalMessage.content);
console.log(`Completed in ${result.totalIterations} turns`);

// Inspect every turn:
for (const turn of result.turns) {
  console.log(`Turn ${turn.iteration}:`, turn.message.content?.slice(0, 80));
  if (turn.toolCalls?.length) {
    console.log(`  Tools called: ${turn.toolCalls.map((c) => c.function.name).join(', ')}`);
  }
}
```

The agent calls `get_weather` twice (once for Tokyo, once for Paris — possibly in parallel if the model requests both in one turn), feeds the results back, and produces a final answer.

## Defining tools

`defineTool` accepts a Zod schema and an async `execute` function. The schema is converted to JSON Schema automatically and passed to the model; arguments are validated with `safeParse` before `execute` runs:

```typescript
import { defineTool } from '@nemesis-oss/ollama-sdk';
import { z } from 'zod';

const searchTool = defineTool({
  name: 'search_docs',
  description: 'Search internal documentation for a query',
  schema: z.object({
    query: z.string().describe('The search query'),
    limit: z.number().int().min(1).max(20).default(5).describe('Max results to return'),
  }),
  execute: async ({ query, limit }, ctx) => {
    // ctx: { signal?: AbortSignal } — cooperative cancellation
    const results = await docsIndex.search(query, { limit, signal: ctx?.signal });
    return { results, count: results.length };
  },
  timeoutMs: 5_000, // per-call timeout, overrides the registry default
});
```

::: tip Schema descriptions become model hints
Zod's `.describe()` strings are emitted into the JSON Schema as `description` fields — the model uses them to decide when and how to call the tool. Write clear, specific descriptions.
:::

## The ToolRegistry

`ToolRegistry` is the central place for tool definitions and execution controls:

```typescript
import { ToolRegistry } from '@nemesis-oss/ollama-sdk';

const registry = new ToolRegistry({
  tools: [weatherTool, searchTool],
  timeoutMs: 10_000,        // default per-call timeout
  maxConcurrency: 4,        // parallel execution cap
  maxOutputChars: 20_000,   // truncate oversized tool output before it re-enters history
  onError: (error, toolCall) => `Tool ${toolCall.function.name} failed: ${error.message}`,
});
```

| Option           | Default        | Effect                                                                                   |
| ---------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `timeoutMs`      | unset          | Race each tool call against a timer; throw `OllamaToolTimeoutError` on expiry.          |
| `maxConcurrency` | unset (infinite) | Cap parallel execution when the model requests multiple tool calls in one turn.        |
| `maxOutputChars` | unset (infinite) | Truncate `outputString` (what's fed back into history); full result still on `result.result`. |
| `onError`        | unset          | Custom error-to-string converter; the returned string is what the model sees.            |

### Per-tool timeout

Override the registry default per-tool:

```typescript
defineTool({
  name: 'slow_api',
  description: 'A tool that sometimes takes a while',
  schema: z.object({}),
  execute: async () => { /* ... */ },
  timeoutMs: 30_000, // override the registry's 10s default
});
```

Pass `0` to explicitly disable timeout enforcement for a tool.

## Manual tool execution (no Agent)

If you want full control over the chat loop, skip `Agent` and execute tool calls yourself:

```typescript
const client = new OllamaClient();
const registry = new ToolRegistry([weatherTool]);
const history = [
  { role: 'user' as const, content: 'What is the weather in Tokyo?' },
];

for (let i = 0; i < 5; i++) {
  const res = await client.chat({
    model: 'qwen3:8b',
    messages: history,
    tools: registry.definitions(),
    stream: false,
  });

  history.push(res.message);

  if (!res.message.tool_calls?.length) {
    console.log(res.message.content);
    break;
  }

  // Execute the requested tool calls (parallel by default, or bounded by maxConcurrency)
  const results = await registry.executeToolCalls(res.message.tool_calls);
  for (const r of results) {
    history.push({
      role: 'tool',
      content: r.outputString,
      tool_name: r.toolName,
    });
  }
}
```

This is exactly what `Agent` does internally — the `Agent` class is just sugar over this loop plus capability preflight, hooks, and error recovery.

## Agent hooks

Wire callbacks for observability, logging, or UI updates:

```typescript
const agent = new Agent(client, {
  tools: registry,
  maxIterations: 10,
  hooks: {
    onTurnStart: (iteration) => console.log(`--- Turn ${iteration} ---`),
    onToken: (delta) => process.stdout.write(delta),
    onThinking: (delta) => process.stderr.write(`\x1b[33m${delta}\x1b[0m`),
    onToolCallStart: (call) => console.log(`→ ${call.function.name}(${JSON.stringify(call.function.arguments)})`),
    onToolCallEnd: (result) => console.log(`← ${result.toolName}: ${result.outputString.slice(0, 100)}`),
    onTurnEnd: (turn) => console.log(`  (turn had ${turn.toolCalls?.length ?? 0} tool calls)`),
  },
});
```

`onToken` and `onThinking` fire only when the agent's internal `chat()` call is streaming — currently `Agent` uses non-streaming chat calls (so the loop can append tool results synchronously), so these hooks fire once per turn with the full message. If you need token-by-token streaming during agent runs, use `chatStream` directly and skip `Agent`.

## Capability preflight

Before the first model turn, `Agent` queries `/api/show` and verifies the model advertises the `tools` capability. If it doesn't, the agent throws `OllamaIncompatibleModelError` before any chat call is made:

```typescript
import { OllamaIncompatibleModelError } from '@nemesis-oss/ollama-sdk';

try {
  await agent.run({ model: 'llama3.2', messages });
} catch (err) {
  if (err instanceof OllamaIncompatibleModelError) {
    console.error(`Model ${err.model} doesn't support tools.`);
    console.error('Reported capabilities:', err.reportedCapabilities);
    // Fall back to a no-tools chat, or pick a different model.
  }
}
```

Disable preflight with `validateToolCapability: false` (useful for custom `AgentChatClient` implementations or non-Ollama backends):

```typescript
const agent = new Agent(client, {
  tools: registry,
  validateToolCapability: false,
});
```

## Automatic context sizing

When tools are registered and `options.num_ctx` is not supplied, `Agent` automatically sizes the context window to `Math.min(toolContextSize, capabilities.contextLength)` — default `toolContextSize` is 32768. An explicit `options.num_ctx` always takes precedence:

```typescript
const agent = new Agent(client, {
  tools: registry,
  toolContextSize: 65_536, // override the default 32768
});

await agent.run({
  model: 'qwen3:8b',
  messages,
  options: { num_ctx: 16_384 }, // explicit override — agent won't auto-size
});
```

## maxIterations and maxToolCalls

| Option          | Default | Behavior                                                                              |
| --------------- | ------- | ------------------------------------------------------------------------------------- |
| `maxIterations` | 10      | Hard cap on the number of model turns. Throws `OllamaAgentMaxIterationsError` when exceeded. |
| `maxToolCalls`  | unset   | Hard cap on the total number of tool calls across the whole run. Throws `OllamaAgentMaxToolCallsError` when exceeded. |

```typescript
const agent = new Agent(client, {
  tools: registry,
  maxIterations: 8,
  maxToolCalls: 20, // safety net against runaway tool loops
});
```

Both errors are `OllamaClientError` subclasses — see the [Errors reference](../api/errors).

## Error recovery

When a tool throws, the registry's default behavior is to convert the error into a string and feed it back to the model as the tool result — letting the model self-correct:

```typescript
const flakyTool = defineTool({
  name: 'flaky_api',
  description: 'An API that sometimes fails',
  schema: z.object({}),
  execute: async () => {
    if (Math.random() < 0.5) throw new Error('API timed out');
    return { ok: true };
  },
});

// The model sees: "Error: API timed out" — and can decide to retry, fall back, or explain.
```

Customize the error-to-string conversion with `onError`:

```typescript
const registry = new ToolRegistry({
  tools: [flakyTool],
  onError: (error, toolCall) => JSON.stringify({
    error: error.message,
    tool: toolCall.function.name,
    retryable: true,
  }),
});
```

If a tool exceeds its `timeoutMs`, the registry throws `OllamaToolTimeoutError` _and_ feeds a timeout message back to the model — the model can choose to retry or use a different tool.

## Mixing models and credentials

For multi-model agents (e.g. a planner model + a coder model), use one `OllamaClient` with [per-endpoint `models` allow-lists](./failover#model-scoped-endpoints-per-model-api-keys). The client resolves the right credential from the model name; `Agent` itself stays unaware of credentials:

```typescript
const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  endpoints: [
    { name: 'planner-key', apiKey: process.env.OLLAMA_PLANNER_KEY!, models: ['gpt-oss:120b'] },
    { name: 'coder-key', apiKey: process.env.OLLAMA_CODER_KEY!, models: ['qwen2.5-coder:7b'] },
  ],
});

const planner = new Agent(client, { tools: registry, maxIterations: 3 });
const coder = new Agent(client, { tools: registry, maxIterations: 10 });

const plan = await planner.run({ model: 'gpt-oss:120b', messages: [...] });
const code = await coder.run({ model: 'qwen2.5-coder:7b', messages: [...] });
```

## Synthetic tool-call IDs

Ollama's native tool-calling protocol has no OpenAI-style per-call ID. The SDK synthesizes a stable client-side `id` (see [ADR 0007](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0007-synthetic-tool-call-ids.md)) so you can correlate `turn.toolCalls[i].id` with `turn.toolResults[i].toolCallId`:

```typescript
const result = await agent.run({ model: 'qwen3:8b', messages });

for (const turn of result.turns) {
  for (let i = 0; i < (turn.toolCalls?.length ?? 0); i++) {
    const call = turn.toolCalls![i]!;
    const result = turn.toolResults![i]!;
    console.assert(call.id === result.toolCallId); // always true
  }
}
```

This `id` is metadata only — it isn't sent to Ollama on the wire. Native `role: 'tool'` messages use Ollama's `tool_name` field instead.

## OpenTelemetry

`Agent` runs emit an `invoke_agent` span (parent), one `ollama.agent.turn` span per iteration (with `ollama.agent.iteration` attribute), and one `execute_tool` span per tool call (with `gen_ai.tool.name` and `gen_ai.tool.call_id` attributes). See [ADR 0005](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0005-opentelemetry-instrumentation.md) for the full span taxonomy.

## Next steps

- **[MCP Integration](./mcp)** — register MCP-backed tools on the same registry.
- **[Streaming](./streaming)** — token-by-token streaming outside the agent loop.
- **[System One Decisions](./system-one)** — typed routing decisions inside agent flows.
- **[API Reference: OllamaClient](../api/client)** — the `chat({ tools })` surface.
- **[ADR 0004: Tool Execution Sandboxing](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0004-tool-execution-sandboxing.md)** — the rationale for `timeoutMs`/`maxConcurrency`/`maxOutputChars`.
- **[ADR 0011: MCP Boundary and Agent Tool Preconditions](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0011-mcp-boundary-and-agent-tool-preconditions.md)** — capability preflight design.
