import { z } from 'zod';
import { Agent, defineTool, OllamaClient, ToolRegistry } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

/**
 * Demonstrates credential-scoped multi-key routing: one `OllamaClient` with three named
 * `credentials`, each bound via `modelBindings` to the one model its API key is entitled
 * to. The client resolves the right key from the `model` you pass to `Agent.run` —
 * `Agent` and `ToolRegistry` stay unaware of credentials entirely. See
 * docs/guides/multi-model-agent-benchmarking.md for the reasoning behind this specific
 * 3-key/3-role split. Model tags default to that guide's picks — confirm against your own
 * account's unlocked models and https://ollama.com/library before relying on them.
 */

type Role = 'supervisor' | 'coder' | 'researcher';

function readEnv(name: string, fallback: string): string {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
      name
    ] ?? fallback
  );
}

function buildClient(cloudBaseUrl: string): { client: OllamaClient; roles: Record<Role, string> } {
  const roles: Record<Role, string> = {
    supervisor: readEnv('OLLAMA_SUPERVISOR_MODEL', 'gpt-oss:120b'),
    coder: readEnv('OLLAMA_CODER_MODEL', 'minimax-m3'),
    researcher: readEnv('OLLAMA_RESEARCHER_MODEL', 'nemotron-3-super'),
  };

  const client = new OllamaClient({
    baseUrl: cloudBaseUrl,
    credentials: {
      supervisor: { apiKey: readEnv('OLLAMA_SUPERVISOR_API_KEY', '') },
      coder: { apiKey: readEnv('OLLAMA_CODER_API_KEY', '') },
      researcher: { apiKey: readEnv('OLLAMA_RESEARCHER_API_KEY', '') },
    },
    modelBindings: {
      [roles.supervisor]: 'supervisor',
      [roles.coder]: 'coder',
      [roles.researcher]: 'researcher',
    },
  });

  return { client, roles };
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
  client: OllamaClient,
  model: string,
  role: Role,
  prompt: string,
): Promise<{ role: Role; model: string; durationMs: number; totalIterations: number; finalAnswer: string }> {
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
  const { client, roles } = buildClient(env.cloudBaseUrl);

  const tasks = [
    'Plan the rollout of a new caching layer and decide which service owns invalidation.',
    'Implement a retry wrapper around the fetch call and add a unit test for it.',
    'Research how three other open-source SDKs handle multi-endpoint failover and summarize the tradeoffs.',
  ];

  for (const prompt of tasks) {
    const role = classify(prompt);
    const model = roles[role];
    const start = Date.now();
    try {
      const result = await runRole(client, model, role, prompt);
      await labLogger.log({
        experimentId: '14-scenarios-multi-model-supervisor',
        timestamp: new Date().toISOString(),
        provider: role,
        endpoint: env.cloudBaseUrl,
        model,
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
        model,
        operation: 'agent-scenario-multi-model-route',
        durationMs: Date.now() - start,
        prompt,
        error: (err as Error).message,
      });
    }
  }
}

void main();
