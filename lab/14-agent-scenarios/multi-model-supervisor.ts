import { z } from 'zod';
import { Agent, defineTool, OllamaClient, ToolRegistry } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

/**
 * Demonstrates keeping the SDK model-agnostic: role -> {client, model} is decided by the
 * caller, not baked into OllamaClient/Agent. See
 * docs/guides/multi-model-agent-benchmarking.md for the reasoning behind this specific
 * 3-key/3-role split. Model tags default to that guide's picks — confirm against your own
 * account's unlocked models and https://ollama.com/library before relying on them.
 */

type Role = 'supervisor' | 'coder' | 'researcher';

interface RoleProvider {
  readonly client: OllamaClient;
  readonly model: string;
}

function readEnv(name: string, fallback: string): string {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
      name
    ] ?? fallback
  );
}

function buildProviders(cloudBaseUrl: string): Record<Role, RoleProvider> {
  return {
    supervisor: {
      client: new OllamaClient({
        baseUrl: cloudBaseUrl,
        apiKey: readEnv('OLLAMA_SUPERVISOR_API_KEY', ''),
      }),
      model: readEnv('OLLAMA_SUPERVISOR_MODEL', 'gpt-oss:120b'),
    },
    coder: {
      client: new OllamaClient({
        baseUrl: cloudBaseUrl,
        apiKey: readEnv('OLLAMA_CODER_API_KEY', ''),
      }),
      model: readEnv('OLLAMA_CODER_MODEL', 'minimax-m3'),
    },
    researcher: {
      client: new OllamaClient({
        baseUrl: cloudBaseUrl,
        apiKey: readEnv('OLLAMA_RESEARCHER_API_KEY', ''),
      }),
      model: readEnv('OLLAMA_RESEARCHER_MODEL', 'nemotron-3-super'),
    },
  };
}

/**
 * Heuristic task router, standing in for what a real deployment would more likely do:
 * ask the supervisor model itself to classify the task, then dispatch on its answer.
 */
function classify(prompt: string): Role {
  const p = prompt.toLowerCase();
  if (/\b(implement|refactor|fix|bug|write code|git|unit test)\b/.test(p)) return 'coder';
  if (/\b(research|investigate|compare|summarize|find sources)\b/.test(p)) return 'researcher';
  return 'supervisor';
}

const recordFindingTool = defineTool({
  name: 'record_finding',
  description: 'Records a single finding or decision produced while working this task',
  schema: z.object({ finding: z.string() }),
  execute: async ({ finding }) => ({ recorded: true, finding }),
});

async function runRole(
  role: Role,
  providers: Record<Role, RoleProvider>,
  prompt: string,
): Promise<{ role: Role; model: string; durationMs: number; totalIterations: number; finalAnswer: string }> {
  const { client, model } = providers[role];
  const registry = new ToolRegistry([recordFindingTool]);
  const agent = new Agent(client, { tools: registry, maxIterations: 4 });
  const start = Date.now();
  const res = await agent.run({ model, messages: [{ role: 'user', content: prompt }] });
  return {
    role,
    model,
    durationMs: Date.now() - start,
    totalIterations: res.totalIterations,
    finalAnswer: res.finalMessage.content,
  };
}

async function main(): Promise<void> {
  const env = getLabEnv();
  const providers = buildProviders(env.cloudBaseUrl);

  const tasks = [
    'Plan the rollout of a new caching layer and decide which service owns invalidation.',
    'Implement a retry wrapper around the fetch call and add a unit test for it.',
    'Research how three other open-source SDKs handle multi-endpoint failover and summarize the tradeoffs.',
  ];

  for (const prompt of tasks) {
    const role = classify(prompt);
    const start = Date.now();
    try {
      const result = await runRole(role, providers, prompt);
      await labLogger.log({
        experimentId: '14-scenarios-multi-model-supervisor',
        timestamp: new Date().toISOString(),
        provider: role,
        endpoint: env.cloudBaseUrl,
        model: result.model,
        operation: 'agent-scenario-multi-model-route',
        durationMs: result.durationMs,
        prompt,
        response: {
          routedTo: role,
          totalIterations: result.totalIterations,
          finalAnswer: result.finalAnswer,
        },
      });
    } catch (err) {
      await labLogger.log({
        experimentId: '14-scenarios-multi-model-supervisor',
        timestamp: new Date().toISOString(),
        provider: role,
        endpoint: env.cloudBaseUrl,
        model: providers[role].model,
        operation: 'agent-scenario-multi-model-route',
        durationMs: Date.now() - start,
        prompt,
        error: (err as Error).message,
      });
    }
  }
}

void main();
