# ADR 0012: MCP Remote Transport Boundary

## Status

Accepted

## Context

The SDK now has a transport-neutral `McpBridge` plus an optional Node-oriented stdio connector.
MCP v2 also defines Streamable HTTP as the preferred remote transport and retains legacy
SSE during the migration period.

The SDK should make remote MCP connectivity easy without importing an MCP implementation
or transport into the root entrypoint. It also needs to avoid an automatic downgrade that
could hide authentication, throttling, or server failures.

## Decision

Add a separate `@nemesis-oss/ollama-sdk/mcp/http` entrypoint that dynamically loads
`@modelcontextprotocol/client` v2 and exposes:

- `connectStreamableHttpMcpClient()` for the preferred Streamable HTTP transport.
- `connectSseMcpClient()` for explicit legacy SSE servers.
- `connectMcpHttpClient({ transport: 'auto' })` for Streamable HTTP first with guarded SSE
  fallback only when the modern connection returns a non-authentication 4xx response.
- `requestInit` and `fetch` pass-through for remote authentication, proxy, testing, and
  custom network environments.
- `close()` for client lifecycle cleanup and `terminateSession()` when the selected
  Streamable HTTP transport exposes server-session termination.

The MCP client dependency remains an optional peer dependency. The root package does not
import the MCP transport implementation, preserving the existing Edge-runtime boundary.

## Rationale

The official MCP TypeScript SDK v2 recommends Streamable HTTP for remote servers and keeps
SSE only as a backwards-compatibility transport. A transport-specific subpath keeps the
core `OllamaClient` and `McpBridge` independent of the optional MCP runtime.

Automatic fallback is intentionally narrower than catch-all error handling: authentication
failures, rate limits, and server errors must remain visible to callers rather than being
reinterpreted as transport migration signals.

## Consequences

- Remote MCP servers can use the same `McpBridge` and `ToolRegistry` path as stdio servers.
- Applications can select modern or legacy MCP transport without adding MCP-specific code
  to their Ollama integration layer.
- The extra package entrypoint must remain tested for ESM/CJS packaging.
- SSE remains available but is explicitly legacy; it should not gain new protocol-specific
  behavior that belongs to Streamable HTTP.

## References

- MCP TypeScript SDK v2 client connection guide: https://ts.sdk.modelcontextprotocol.io/v2/clients/connect
- MCP TypeScript SDK v2 SSE transport: https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/client/client/sse.html