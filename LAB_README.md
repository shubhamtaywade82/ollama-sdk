# Ollama SDK Manual Laboratory (`lab/`)

This directory is a **manual LLM and Agent experimentation harness** for `@nemesis-oss/ollama-sdk`. Every script is self-contained and runnable independently using `tsx`, allowing direct inspection of SDK behavior, protocol flows, tool invocations, and agent iterations.

---

## 🚀 Quick Start

### Run the consolidated live feature tour

Start a local Ollama server and install at least one chat model. Then run:

```bash
ollama serve
ollama pull qwen2.5:0.5b
npm run lab:live
```

`lab:live` builds the SDK, then runs `lab/live-tour.ts`, which imports the public
`@nemesis-oss/ollama-sdk` package and makes real requests to Ollama. It prints
HTTP lifecycle events, streams generated tokens in real time, reports each
feature as passed/failed/skipped, and appends details to
`logs/manual/YYYY-MM-DD.jsonl`.

Configure a different local server or installed model with:

```env
OLLAMA_LOCAL_BASE_URL=http://localhost:11434
OLLAMA_LOCAL_MODEL=qwen2.5:0.5b
OLLAMA_EMBED_MODEL=nomic-embed-text:latest
```

The tour automatically selects an installed non-embedding model when
`OLLAMA_LOCAL_MODEL` is unset or its preferred default is unavailable. Embedding
and vision checks run only when a matching model/input is available. Set
`OLLAMA_LIVE_IMAGE` to an image file to exercise vision with a vision-capable
model. Hosted web search is deliberately opt-in: set `OLLAMA_API_KEY` and
`OLLAMA_LIVE_CLOUD=1`. Model mutation operations (pull/create/copy/delete/push)
are never run by the tour.

The tour covers native chat/generate, streaming and Web `Response` adapters,
structured Zod output, tool calls and `Agent`, embeddings, model inspection,
OpenAI/Anthropic compatibility, generated API/runtime, usage/quota utilities,
and an MCP bridge connected to a deterministic in-memory adapter plus a real
local model decision. A configured remote MCP URL is not invoked automatically:
review its advertised tools first using the dedicated MCP labs.

1. **Configure Environment Variables**

   ```bash
   cp .env.example .env
   ```

   Edit `.env`:

   ```env
   OLLAMA_LOCAL_BASE_URL=http://localhost:11434
   OLLAMA_LOCAL_MODEL=qwen2.5:0.5b
   OLLAMA_EMBED_MODEL=nomic-embed-text:latest
   OLLAMA_CLOUD_BASE_URL=https://ollama.com
   OLLAMA_CLOUD_MODEL=qwen2.5:0.5b
   OLLAMA_API_KEY=your_api_key_here
   ```

2. **List All Available Experiments**

   ```bash
   npm run lab
   # or
   npx tsx lab/run.ts list
   ```

3. **Run An Individual Experiment**

   ```bash
   npx tsx lab/00-smoke/local-chat.ts
   npx tsx lab/05-tools/one-tool.ts
   npx tsx lab/06-agent/multi-step.ts
   ```

   Or run via the helper runner:

   ```bash
   npx tsx lab/run.ts multi-step
   ```

---

## 📁 Laboratory Directory Structure

```text
lab/
├── support/                     # Environment resolution, logger, trace & replay
│   ├── env.ts
│   ├── logger.ts
│   └── replay.ts
├── live-tour.ts                 # Consolidated public-package live Ollama tour
│
├── 00-smoke/                    # Connectivity & baseline smoke tests
│   ├── local-chat.ts
│   ├── cloud-chat.ts
│   └── compare-local-cloud.ts
│
├── 01-chat/                     # /api/chat primitive experiments
│   ├── basic.ts
│   ├── system-prompt.ts
│   ├── multi-turn.ts
│   ├── think.ts
│   └── model-options.ts
│
├── 02-generate/                 # /api/generate primitive experiments
│   ├── basic.ts
│   ├── raw.ts
│   ├── structured-json.ts
│   └── thinking.ts
│
├── 03-streaming/                # Stream chunking, adapters, & cancellation
│   ├── chat-stream.ts
│   ├── generate-stream.ts
│   ├── inspect-chunks.ts
│   └── abort-stream.ts
│
├── 04-structured-output/        # JSON & Zod schema validation
│   ├── json.ts
│   ├── zod.ts
│   ├── invalid-output.ts
│   └── compare-models.ts
│
├── 05-tools/                    # Tool definitions, IDs, errors, & concurrency
│   ├── one-tool.ts
│   ├── multiple-tools.ts
│   ├── parallel-tools.ts
│   ├── tool-errors.ts
│   └── tool-call-ids.ts
│
├── 06-agent/                    # Iterative agent loop & execution lifecycle
│   ├── single-step.ts
│   ├── multi-step.ts
│   ├── max-iterations.ts
│   ├── hooks.ts
│   ├── state.ts
│   └── failure-recovery.ts
│
├── 07-models/                   # ModelsClient catalog lifecycle operations
│   ├── list.ts
│   ├── show.ts
│   ├── pull.ts
│   ├── create.ts
│   ├── copy.ts
│   ├── delete.ts
│   └── ps.ts
│
├── 08-embeddings/               # Vector embeddings & in-memory cosine similarity
│   ├── single.ts
│   ├── batch.ts
│   └── similarity.ts
│
├── 09-web/                      # Web search & web fetch operations
│   ├── search.ts
│   └── fetch.ts
│
├── 10-routing/                  # Endpoint failover, retries, & health checks
│   ├── local.ts
│   ├── cloud.ts
│   ├── failover.ts
│   ├── retries.ts
│   └── health.ts
│
├── 11-mcp/                      # Model Context Protocol tool bridges
│   ├── one-tool.ts
│   └── client-adapter.ts
│
├── 12-skills/                   # Markdown skill frontmatter & prompt composition
│   ├── frontmatter.ts
│   └── apply.ts
│
├── 13-integrations/             # OpenAI and Anthropic API compatibility bridges
│   ├── openai-compatible.ts
│   └── anthropic-compatible.ts
│
├── 14-agent-scenarios/          # Autonomous multi-turn problem solvers
│   ├── calculator-agent.ts
│   ├── research-agent.ts
│   └── planner-executor.ts
│
└── run.ts                       # CLI experiment runner
```

---

## 📊 Observability & Trace Logs

Experiment executions automatically output human-readable summaries to stdout and persist structured traces under `logs/`:

* `logs/manual/YYYY-MM-DD.jsonl`: Event stream of requests, durations, models, and outputs.
* `logs/agents/<agent-name>.json`: Complete multi-turn agent execution trace, turns, and tool results.
* `logs/replay/<id>-<timestamp>.json`: Recorded snapshots for deterministic replay.
