# ADR 0011: MCP Boundary and Agent Tool Preconditions

## Status

Accepted

## Context

The SDK needs a first-class way to consume Model Context Protocol (MCP) tool
definitions while preserving the root package's Edge-runtime compatibility.

MCP supports multiple transports. Some implementations, such as the official
Node.js `StdioClientTransport`, are runtime-specific, while other transports
can be used from non-Node environments. Embedding process spawning in the core
SDK would make the public root entrypoint harder to use in Edge runtimes.

Tool-enabled agent loops also have two operational preconditions that can be
known before the first inference request:

1. The selected Ollama model can advertise `tools` support through
   `/api/show` metadata.
2. The model can expose a maximum context length through `model_info`.

## Decision

Add `McpBridge` as a transport-neutral adapter.

- MCP clients remain responsible for connecting to servers.
- `McpBridge` consumes a small structural client contract (`listTools()` and
  `callTool()`), converts MCP tool definitions to Ollama function tools, and
  registers MCP-backed tools in the existing `ToolRegistry`.
- The bridge preserves arbitrary JSON Schema keywords so MCP schemas are not
  silently narrowed during conversion.
- Node-specific transports such as stdio are not imported by the root package.

Add optional agent preflight through `AgentChatClient.capabilities()`.

- `Agent` checks model tool support before the first tool-enabled turn when
  capability discovery is available.
- A missing `tools` capability raises `OllamaIncompatibleModelError`.
- For real `OllamaClient` instances, the discovered context limit is used to
  clamp the agent's automatic tool context size.
- The automatic default is `num_ctx: 32768`, and an explicit
  `options.num_ctx` always takes precedence.
- `validateToolCapability: false` disables both capability discovery and the
  automatic context override for legacy/custom clients.

## Consequences

### Positive

- MCP integration stays compatible with local, remote, Node, and Edge MCP
  client implementations.
- Tool-enabled agents fail before an inference call when the model explicitly
  lacks tool support.
- Larger context is selected automatically for tool-heavy agents without
  exceeding the model's reported maximum.
- Existing custom/VCR agent clients retain their previous request behavior when
  the preflight is explicitly disabled.
- Full MCP JSON Schema metadata survives conversion.

### Trade-offs

- A real `OllamaClient` tool-enabled agent performs an additional
  `/api/show` request once per `Agent.run()`.
- Capability metadata is advisory runtime information; a provider/model can
  still behave incorrectly after advertising a capability.
- The core SDK does not provide its own MCP process lifecycle manager; callers
  must supply an MCP client/transport.

## Alternatives Considered

### Hard-code `num_ctx: 16384`

Rejected because current Ollama guidance for tool-heavy workflows indicates
that larger context, around 32K or more, can improve tool/MCP reliability. The
SDK therefore uses 32K as the default and clamps to model capacity.

### Spawn MCP stdio processes from the root package

Rejected because the official stdio client transport is Node.js-specific and
would compromise the root package's Edge-runtime boundary.

### Strip `<think>...</think>` with a regex in the transport

Rejected. Native Ollama responses expose thinking as a structured field and
tool calls as structured data. Regex manipulation of the raw protocol stream
could corrupt legitimate text or tool payloads. Any future reasoning cleanup
should operate on explicit textual fields, never on serialized protocol data.

## References

- Ollama API: https://docs.ollama.com/api
- Ollama chat/tool calling: https://docs.ollama.com/api/chat
- Ollama show model details: https://docs.ollama.com/api-reference/show-model-details
- MCP TypeScript SDK client/transports: https://ts.sdk.modelcontextprotocol.io/
