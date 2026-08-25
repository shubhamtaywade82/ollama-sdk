# Guide: Benchmarking Agent Models Across Multiple Ollama Cloud Keys

This guide is for anyone using this SDK's `Agent`/`ToolRegistry`/structured-output stack
against **multiple Ollama Cloud API keys**, each with its own set of unlocked models, and
trying to decide which models are worth spending those scarce keys on.

It captures a specific 3-key model selection worked out for exactly that scenario, plus
the general principles behind it — because the principles outlast any specific model
lineup as Ollama's [model library](https://ollama.com/library) changes.

## The governing principle: entitlement, not UI state

A model showing as "unlocked" in the Ollama account picker is **not** proof that your
plan can actually run it — free-tier availability, capacity limits, and per-model gating
are account-level facts the UI doesn't always reflect accurately. Before committing one
of a small number of API keys to a model:

1. Actually call it (`chatText`/`generate`) with that key and confirm you get a real
   response, not a `402`/`403`/`429`.
2. Treat "the account says it's unlocked" as a hint, not a constraint satisfied.
3. If a model turns out to be gated behind a paid tier despite appearing selectable,
   drop it from the plan rather than assuming the UI is authoritative.

Your real constraint is **N keys → N actually-callable models**, not N keys → N models
that happen to appear in a dropdown.

## A worked example: 3 keys, 3 roles

Given three Ollama Cloud keys and Ollama's current library, this split gives good model
*and* training-philosophy diversity, each model doing the job it's actually described for:

| Key | Model            | Role                                          | Why                                                                                                                                                        |
| --- | ---------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GPT-OSS 120B      | Supervisor — planning, tool selection, review | General-purpose reasoning model; drives the bulk of `Agent`'s plan → act → observe → re-plan loop.                                                        |
| 2   | MiniMax M3        | Coder — autonomous, tool-heavy execution      | Documented by Ollama as a coding/agentic model with autonomous task decomposition and multi-step tool invocation — a good match for `ToolRegistry`-heavy work. |
| 3   | Nemotron 3 Super  | Worker/researcher — long-running, multi-agent | 120B MoE, 12B active, 256K context, native tool/thinking support; Ollama documents it explicitly for "complex multi-agent applications" and high-volume workloads. |

```
                          AGENT ORCHESTRATOR
                                  │
                                  ▼
                        ┌───────────────────┐
                        │   GPT-OSS 120B    │
                        │    SUPERVISOR     │
                        └─────────┬─────────┘
                                  │
                        ┌─────────┴─────────┐
                        │                   │
                        ▼                   ▼
                 ┌──────────────┐    ┌────────────────┐
                 │  MiniMax M3  │    │ Nemotron 3     │
                 │    CODER     │    │ Super WORKER   │
                 └──────────────┘    └────────────────┘
```

### Why not spend a slot on GPT-OSS 20B

`gpt-oss:20b` is useful, but `{GPT-OSS 120B, GPT-OSS 20B, MiniMax M3}` gives only two
model families across three keys. `{GPT-OSS 120B, MiniMax M3, Nemotron 3 Super}` gives
three distinct families, which is strictly more informative for evaluating this SDK
against different providers' agentic behavior — model diversity, not just capability, is
the point of spending a key on a fourth-plus model.

### Why not Nemotron 3 Ultra (yet)

Nemotron 3 Ultra (550B total / 55B active, 1M-token context, built for long-running
coding agents and deep research) would in principle outrank Nemotron 3 Super for this
workload. But per the governing principle above: don't commit a scarce key to it until
you've confirmed your account can actually call it under your plan. If it isn't
reachable, it stays a "would be nice" rather than part of the 3-key plan.

### Shortlist for reference

| Tier                                        | Models                                    |
| -------------------------------------------- | ------------------------------------------ |
| A — commit a key                             | `gpt-oss:120b`, `minimax-m3`, `nemotron-3-super` |
| B — benchmark opportunistically if reachable | `nemotron-3-ultra`, `gpt-oss:20b`          |
| C — cheap workers for later, not initial slots | `gemma4:31b`, `nemotron-3-nano:30b`      |

Model tags above are illustrative — always confirm the exact tag your account exposes
against the [Ollama model library](https://ollama.com/library) before wiring it into a
benchmark; library entries and naming change over time.

## One client, credential-scoped routing — don't hard-code roles into it

Each of your three keys is entitled to a different model, so this is exactly what the
SDK's `credentials`/`modelBindings` config is for (see the main README's
["Multiple API keys, each entitled to different models"](../../README.md#multiple-api-keys-each-entitled-to-different-models)):
**one** `OllamaClient`, three named credentials, and the client resolves
`KEY_1`/`KEY_2`/`KEY_3` from whichever `model` you pass to `chat`/`generate`/`Agent.run`.
Neither `Agent` nor `ToolRegistry` gain any concept of "supervisor" or "coder" — that
stays a plain naming convention your own code applies on top of model tags:

```typescript
import { Agent, OllamaClient, ToolRegistry } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient({
  baseUrl: 'https://ollama.com',
  credentials: {
    supervisor: { apiKey: process.env.SUPERVISOR_KEY! },
    coder: { apiKey: process.env.CODER_KEY! },
    researcher: { apiKey: process.env.RESEARCHER_KEY! },
  },
  modelBindings: {
    'gpt-oss:120b': 'supervisor',
    'minimax-m3': 'coder',
    'nemotron-3-super': 'researcher',
  },
});

const roles = {
  supervisor: 'gpt-oss:120b',
  coder: 'minimax-m3',
  researcher: 'nemotron-3-super',
} as const;

// Your own orchestration layer decides routing — the client resolves the right
// credential from whichever model name you hand it.
function routeTask(task: string): keyof typeof roles {
  if (/implement|refactor|fix|test/i.test(task)) return 'coder';
  if (/research|investigate|compare|summarize/i.test(task)) return 'researcher';
  return 'supervisor';
}

const agent = new Agent(client, { tools: new ToolRegistry([]) });
const role = routeTask('Implement a retry wrapper and add a unit test for it.');
await agent.run({ model: roles[role], messages: [{ role: 'user', content: '...' }] });
```

A full runnable version of this pattern — one `OllamaClient` with all three keys
registered, a heuristic router, and `Agent`/`ToolRegistry` wired per role — lives at
[`lab/14-agent-scenarios/multi-model-supervisor.ts`](../../lab/14-agent-scenarios/multi-model-supervisor.ts).
Run it with `npx tsx lab/14-agent-scenarios/multi-model-supervisor.ts` after setting
`OLLAMA_SUPERVISOR_API_KEY`/`OLLAMA_CODER_API_KEY`/`OLLAMA_RESEARCHER_API_KEY` (and the
matching `*_MODEL` overrides, if your account's tags differ from the defaults above).
Requesting a model none of the configured keys are scoped to throws
`OllamaModelRoutingError` immediately, rather than silently trying every key.

## Benchmark scorecard

Don't lock in a model lineup off marketing copy — treat the 3 keys as a controlled
benchmark against what this SDK actually exercises, and score each model against it:

```
                        AGENT BENCHMARK
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
   GPT-OSS 120B          MiniMax M3           Nemotron 3 Super
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              ▼
                       Evaluation Engine
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
  Tool Calling            Agent Loop              Coding
   Accuracy                Reliability            Accuracy
       │                      │                      │
       ▼                      ▼                      ▼
  Structured               Recovery                 MCP
   Output                   Ability                Handling
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              ▼
                        MODEL SCORECARD
```

Concretely, score each model against the SDK surfaces it exercises:

- `Agent`/`ToolRegistry`: multi-turn tool calling, parallel tool calls, recovery from a
  failed/invalid tool call (`OllamaToolValidationError`, `OllamaToolTimeoutError`), and
  whether it reliably stops within `maxIterations` (vs. tripping
  `OllamaAgentMaxIterationsError`).
- `chatWithSchema`/`generateWithSchema`: structured-output adherence and how often
  malformed JSON needs the SDK's markdown-fenced-JSON recovery path.
- `think`/`logprobs`: whether reasoning/thinking tokens stream usefully and whether
  `logprobs` are populated at all (cloud-hosted models vary here).
- `loadMcpTools`/`registerMcpTools`: MCP tool-schema compatibility.
- Streaming (`chatStream`/`generateStream`, `toTextStream`/`toDataStream`): chunk
  cadence and whether tool-call events interleave cleanly with content tokens.
- Retry/failover behavior (`DEFAULT_RETRY_CONFIG`, `DEFAULT_FAILOVER_CODES`): how often
  each model's endpoint actually triggers a retryable error class under load.

The result is an Ollama agent-model compatibility matrix specific to *this SDK's*
feature surface — more useful for picking a default model than a generic leaderboard.
