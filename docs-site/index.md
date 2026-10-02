---
layout: home

hero:
  name: Ollama SDK
  text: Production-grade TypeScript SDK for Ollama
  tagline: Native fetch, high-availability failover, structured outputs, agents, MCP, and a contract-first architecture — all from one package.
  image:
    src: /logo.svg
    alt: Ollama SDK
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/shubhamtaywade82/ollama-sdk
    - theme: alt
      text: npm
      link: https://www.npmjs.com/package/@nemesis-oss/ollama-sdk

features:
  - icon: 🚀
    title: Native Web Standards
    details: Built entirely on native fetch and Web Streams. Zero external HTTP dependencies, runs on Node 20+, Cloudflare Workers, and Vercel Edge without a single Node-only API in the root bundle.
    link: /guide/getting-started
    linkText: Quickstart →
  - icon: 🧠
    title: Reasoning & Thinking Tokens
    details: First-class support for reasoning models (qwen3, deepseek-r1) via the native think parameter, with discrete thinking and token streaming events plus logprobs/top_logprobs for token-level confidence scoring.
    link: /guide/chat
    linkText: Chat guide →
  - icon: 🎯
    title: Zod-Powered Structured Outputs
    details: Strictly typed schema enforcement via chatWithSchema and generateWithSchema. Pass a Zod schema, get back typed data — with resilient markdown-JSON parsing and automatic validation errors.
    link: /guide/structured-output
    linkText: Structured output →
  - icon: 🛠️
    title: Autonomous Agent & Tool Calling
    details: Multi-turn Agent loop with automated tool execution, parameter validation, self-correcting error recovery, and capability preflight against /api/show.
    link: /guide/agents
    linkText: Agents guide →
  - icon: 🌐
    title: High-Availability Failover
    details: Multi-endpoint registry with priority routing, circuit breaker failover, active health checks, per-endpoint model allow-lists, and least-connections load balancing for Ollama Cloud free-tier pools.
    link: /guide/failover
    linkText: Failover guide →
  - icon: 🔌
    title: MCP Integration
    details: First-class, transport-neutral McpBridge converts MCP tool descriptors into native Ollama function tools. Optional stdio and Streamable HTTP connectors in dedicated subpaths.
    link: /guide/mcp
    linkText: MCP guide →
  - icon: 🌉
    title: OpenAI & Anthropic Bridges
    details: Built-in clients for /v1/chat/completions, /v1/responses, /v1/models, and /v1/messages — including reasoning_effort for thinking models, streaming SSE adapters, and typed request shapes.
    link: /guide/openai-compat
    linkText: Compatibility guide →
  - icon: 🎛️
    title: System One Decision Layer
    details: Typed choice/noul/score questions with probability distributions and confidence, plus ergonomic helpers (choice, noul, score, route, verify, rank) for the six most common decision patterns.
    link: /guide/system-one
    linkText: System One guide →
  - icon: 🌊
    title: Web Stream Adapters
    details: Drop-in toTextStream, toDataStream, and toResponse adapters for Next.js Route Handlers, Vercel AI SDK, and standard fetch responses — no manual chunk-to-string plumbing.
    link: /guide/streaming
    linkText: Streaming guide →
  - icon: 🧩
    title: Contract-First Architecture
    details: A single canonical IR (contracts/ir/ollama.ir.json) drives TypeScript interfaces, generated API classes, MCP tool descriptors, Zod schemas, and field-level parity verification.
    link: /guide/contract-first
    linkText: Architecture →
  - icon: 📈
    title: OpenTelemetry Instrumentation
    details: Automatic spans for HTTP requests, endpoint failover, chat/generate calls, and agent runs following Gen AI semantic conventions. Zero-cost when OpenTelemetry isn't installed.
    link: /api/client
    linkText: API reference →
  - icon: 📦
    title: Dual ESM/CJS Build
    details: Full module support with clean TypeScript declaration maps. Verified by @arethetypeswrong/cli in CI so the runtime exports always match the published types.
    link: /adr/
    linkText: ADR index →
---

## Install

```bash
npm install @nemesis-oss/ollama-sdk zod
```

`zod` is a peer dependency (`^3.22.0 || ^4.0.0`) — install whichever major your project already uses instead of getting a second copy bundled in.

## Thirty-second quickstart

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient(); // defaults to http://localhost:11434

// Non-streaming chat
const answer = await client.chatText({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Explain streaming in one sentence.' }],
});
console.log(answer);

// Token-by-token streaming with reasoning events
const stream = await client.chatStream({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'What is 18 * 4?' }],
  think: 'high',
});
for await (const event of stream) {
  if (event.type === 'thinking') process.stdout.write(`\x1b[33m${event.data.delta}\x1b[0m`);
  else if (event.type === 'token') process.stdout.write(event.data.delta);
}
```

## Why this SDK

The official Ollama client is a thin JavaScript wrapper around the REST API. `@nemesis-oss/ollama-sdk` is built for production workloads:

- **High availability** — multi-endpoint failover with circuit breakers, health checks, and least-connections routing so a flapping Ollama Cloud key doesn't take down your application.
- **Type safety end-to-end** — request/response types generated from the canonical IR, runtime Zod validation you can opt into per-call or runtime-wide, and structured outputs that return typed data, not strings.
- **Edge runtime verified in CI** — `npm run verify:edge-runtime` bundles the client with `esbuild` and runs a full round-trip in `@edge-runtime/vm` on every PR. If it ships, it runs on Cloudflare/Vercel Edge.
- **Decision-aware** — System One (`/v1/systemone`) exposes a typed decision layer with probability distributions, confidence scores, and six ergonomic helpers for routing, verification, ranking, and scoring.
- **Contract-first** — a single canonical IR drives TypeScript interfaces, generated API classes, MCP tool descriptors, Zod schemas, and field-level parity verification against the official Ollama docs.

## What this site covers

- **[Guide](/guide/getting-started)** — practical walkthroughs for chat, generate, embed, streaming, failover, System One decisions, OpenAI/Anthropic compatibility, MCP, agents, structured outputs, and the contract-first architecture.
- **[API Reference](/api/client)** — type-level reference for `OllamaClient`, the generated `NativeApi`, decision helpers, and the structured error hierarchy.
- **[Architecture](/adr/)** — the ADR index linking to every architecture decision record in the repository.
