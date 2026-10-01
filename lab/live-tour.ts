import { readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  Agent,
  defineTool,
  HttpClient,
  McpBridge,
  OllamaClient,
  QuotaManager,
  toResponse,
  ToolRegistry,
  type McpClientLike,
} from '@nemesis-oss/ollama-sdk';
import { NativeApi } from '@nemesis-oss/ollama-sdk/generated/api';
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';
import { z } from 'zod';
import { getLabEnv } from './support/env.js';
import { ExperimentLogger, type ExperimentEvent } from './support/logger.js';

type StepStatus = 'passed' | 'failed' | 'skipped';

interface StepOutcome {
  readonly name: string;
  readonly status: StepStatus;
  readonly durationMs: number;
  readonly detail?: unknown;
  readonly error?: string;
}

const logger = new ExperimentLogger();
const outcomes: StepOutcome[] = [];
const env = getLabEnv();
const baseUrl = process.env['OLLAMA_LOCAL_BASE_URL'] ?? env.localBaseUrl;
let activeModel =
  process.env['OLLAMA_LOCAL_MODEL'] ?? process.env['OLLAMA_MODEL'] ?? env.localModel;

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid endpoint URL]';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logHttpEvent(event: {
  readonly type: 'start' | 'success' | 'retry' | 'error';
  readonly method?: string;
  readonly url?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly error?: Error;
}): void {
  const path =
    event.url === undefined
      ? ''
      : (() => {
          try {
            return new URL(event.url).pathname;
          } catch {
            return '[invalid URL]';
          }
        })();
  const facts = [
    event.method,
    path,
    event.status === undefined ? undefined : `HTTP ${event.status}`,
    event.durationMs === undefined ? undefined : `${event.durationMs}ms`,
    event.attempt === undefined ? undefined : `attempt ${event.attempt}`,
    event.delayMs === undefined ? undefined : `retry in ${event.delayMs}ms`,
    event.error === undefined ? undefined : event.error.message,
  ].filter(Boolean);
  console.log(`  [http:${event.type}] ${facts.join(' | ')}`);
}

const client = new OllamaClient({
  baseUrl,
  timeoutMs: 30_000,
  retries: 0,
  onLifecycleEvent: logHttpEvent,
});

async function runStep<T>(
  name: string,
  operation: string,
  fn: () => Promise<T> | T,
  summarize: (value: T) => unknown = (value) => value,
): Promise<T | undefined> {
  console.log(`\n▶ ${name}`);
  const startedAt = Date.now();
  let event: ExperimentEvent;
  try {
    const value = await fn();
    const durationMs = Date.now() - startedAt;
    const detail = summarize(value);
    outcomes.push({ name, status: 'passed', durationMs, detail });
    console.log(`✓ ${name} (${durationMs}ms)`);
    event = {
      experimentId: `live-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      timestamp: new Date().toISOString(),
      provider: 'local-ollama',
      endpoint: safeEndpoint(baseUrl),
      model: activeModel,
      operation,
      durationMs,
      response: detail,
    };
    await logger.log(event);
    return value;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = errorMessage(error);
    outcomes.push({ name, status: 'failed', durationMs, error: message });
    console.error(`✗ ${name} (${durationMs}ms): ${message}`);
    event = {
      experimentId: `live-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      timestamp: new Date().toISOString(),
      provider: 'local-ollama',
      endpoint: safeEndpoint(baseUrl),
      model: activeModel,
      operation,
      durationMs,
      error: message,
    };
    await logger.log(event);
    return undefined;
  }
}

async function skipStep(name: string, reason: string): Promise<void> {
  outcomes.push({ name, status: 'skipped', durationMs: 0, detail: reason });
  console.log(`↷ ${name}: ${reason}`);
  await logger.log({
    experimentId: `live-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    timestamp: new Date().toISOString(),
    provider: 'local-ollama',
    endpoint: safeEndpoint(baseUrl),
    model: activeModel,
    operation: 'skipped',
    response: { reason },
  });
}

function chooseModel(modelNames: readonly string[]): string | undefined {
  const configured = process.env['OLLAMA_LOCAL_MODEL'] ?? process.env['OLLAMA_MODEL'];
  if (configured !== undefined) {
    return (
      modelNames.find((name) => name === configured) ??
      modelNames.find((name) => name.split(':')[0] === configured)
    );
  }

  const preferred = modelNames.find((name) => name === env.localModel);
  if (preferred !== undefined) return preferred;
  return modelNames.find((name) => !/embed|rerank/i.test(name));
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error(`Embedding dimensions differ (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) throw new Error('Embedding vector has zero magnitude');
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function main(): Promise<void> {
  console.log('Ollama SDK live feature tour');
  console.log(`Endpoint: ${safeEndpoint(baseUrl)}`);
  console.log(`Preferred model: ${activeModel}`);
  console.log('Real requests will be sent to the configured Ollama server.');

  const discovery = await runStep(
    'Server and model discovery',
    'GET /api/version + GET /api/tags + GET /api/ps',
    async () => {
      const [version, catalog, running] = await Promise.all([
        client.version(),
        client.listModels(),
        client.ps(),
      ]);
      const installedModels = catalog;
      const runningModels = running.models ?? [];
      const names = installedModels.map((model) => model.name);
      const selectedModel = chooseModel(names);
      if (selectedModel === undefined) {
        const configured = process.env['OLLAMA_LOCAL_MODEL'] ?? process.env['OLLAMA_MODEL'];
        throw new Error(
          configured !== undefined
            ? `Configured model "${configured}" is not installed. Installed models: ${names.join(', ') || '(none)'}. Pull it or set OLLAMA_LOCAL_MODEL to an installed model.`
            : `No chat model is installed. Pull one with "ollama pull ${env.localModel}" or set OLLAMA_LOCAL_MODEL.`,
        );
      }
      activeModel = selectedModel;
      return {
        version: version.version,
        installedModels: names,
        runningModels: runningModels.map((model) => model.name),
      };
    },
    (result) => result,
  );
  if (discovery === undefined) {
    await printSummary();
    process.exitCode = 1;
    return;
  }

  const capabilities = await runStep(
    'Model inspection and capability detection',
    'POST /api/show',
    async () => {
      const [modelInfo, detected] = await Promise.all([
        client.showModel({ model: activeModel }),
        client.capabilities(activeModel),
      ]);
      return {
        family: modelInfo.details.family,
        parameterSize: modelInfo.details.parameter_size,
        reported: detected.reported,
        supportsTools: detected.supportsTools,
        supportsVision: detected.supportsVision,
        supportsThinking: detected.supportsThinking,
        contextLength: detected.contextLength,
      };
    },
  );

  const chat = await runStep(
    'Native chat',
    'POST /api/chat',
    () =>
      client.chat({
        model: activeModel,
        messages: [{ role: 'user', content: 'Reply with exactly: live chat works' }],
        stream: false,
        options: { temperature: 0, num_predict: 40 },
      }),
    (response) => ({
      model: response.model,
      text: response.message.content,
      done: response.done,
      usage: { prompt: response.prompt_eval_count, completion: response.eval_count },
    }),
  );

  await runStep(
    'Chat text convenience helper',
    'POST /api/chat (chatText)',
    () =>
      client.chatText({
        model: activeModel,
        messages: [{ role: 'user', content: 'Reply with exactly: text helper works' }],
        options: { temperature: 0, num_predict: 40 },
      }),
    (response) => ({ text: response }),
  );

  const generated = await runStep(
    'Native text generation',
    'POST /api/generate',
    () =>
      client.generate({
        model: activeModel,
        prompt: 'In one short sentence, explain what Ollama does.',
        stream: false,
        options: { temperature: 0, num_predict: 50 },
      }),
    (response) => ({
      model: response.model,
      text: response.response,
      done: response.done,
      usage: { prompt: response.prompt_eval_count, completion: response.eval_count },
    }),
  );

  await runStep(
    'Generate text convenience helper',
    'POST /api/generate (generateText)',
    () =>
      client.generateText({
        model: activeModel,
        prompt: 'Reply with exactly: generate helper works',
        options: { temperature: 0, num_predict: 40 },
      }),
    (response) => ({ text: response }),
  );

  await runStep(
    'Chat streaming with live token events',
    'POST /api/chat (stream=true)',
    async () => {
      const stream = await client.chatStream({
        model: activeModel,
        messages: [{ role: 'user', content: 'Count from one to five, one number per word.' }],
        options: { temperature: 0, num_predict: 40 },
      });
      let text = '';
      let tokenEvents = 0;
      for await (const event of stream) {
        if (event.type === 'token') {
          tokenEvents += 1;
          text += event.data.delta;
          process.stdout.write(event.data.delta);
        } else if (event.type === 'thinking') {
          console.log(`\n  [thinking] ${event.data.delta}`);
        } else if (event.type === 'error') {
          throw event.data.error;
        }
      }
      console.log();
      const final = await stream.finalResult;
      return { text, tokenEvents, done: final.done, usage: final.usage };
    },
  );

  await runStep(
    'Generate streaming with live token events',
    'POST /api/generate (stream=true)',
    async () => {
      const stream = await client.generateStream({
        model: activeModel,
        prompt: 'Write a short greeting.',
        options: { temperature: 0, num_predict: 30 },
      });
      let text = '';
      let tokenEvents = 0;
      for await (const event of stream) {
        if (event.type === 'token') {
          tokenEvents += 1;
          text += event.data.delta;
          process.stdout.write(event.data.delta);
        } else if (event.type === 'thinking') {
          console.log(`\n  [thinking] ${event.data.delta}`);
        } else if (event.type === 'error') {
          throw event.data.error;
        }
      }
      console.log();
      const final = await stream.finalResult;
      return { text, tokenEvents, done: final.done, usage: final.usage };
    },
  );

  await runStep('Web Response stream adapter', 'POST /api/chat + toResponse()', async () => {
    const stream = await client.chatStream({
      model: activeModel,
      messages: [{ role: 'user', content: 'Say hello in five words or fewer.' }],
      options: { temperature: 0, num_predict: 20 },
    });
    const response = toResponse(stream);
    const text = await response.text();
    console.log(`  [web response] ${text}`);
    return { status: response.status, contentType: response.headers.get('content-type'), text };
  });

  const StructuredReply = z.object({
    summary: z.string().max(120),
    points: z.array(z.string().max(100)).length(2),
  });
  await runStep('Zod-validated structured chat output', 'POST /api/chat (format=JSON Schema)', () =>
    client.chatWithSchema(
      {
        model: activeModel,
        messages: [
          {
            role: 'user',
            content:
              'Return JSON with a summary under 12 words and exactly two brief points, each under 10 words, about local language models.',
          },
        ],
        options: { temperature: 0, num_predict: 256 },
      },
      StructuredReply,
    ),
  );

  await runStep(
    'Zod-validated structured generation output',
    'POST /api/generate (format=JSON Schema)',
    () =>
      client.generateWithSchema(
        {
          model: activeModel,
          prompt:
            'Return JSON with a summary under 12 words and exactly two brief points, each under 10 words, about streaming APIs.',
          options: { temperature: 0, num_predict: 256 },
        },
        StructuredReply,
      ),
  );

  if (capabilities?.supportsTools) {
    const addTool = defineTool({
      name: 'add_numbers',
      description: 'Add two numbers and return the exact sum.',
      schema: z.object({ left: z.number(), right: z.number() }),
      execute: ({ left, right }) => {
        const sum = left + right;
        console.log(`  [tool executed] ${left} + ${right} = ${sum}`);
        return { sum };
      },
    });
    const registry = new ToolRegistry({ tools: [addTool] });
    const agent = new Agent(client, {
      tools: registry,
      maxIterations: 3,
      hooks: {
        onTurnStart: (iteration) => console.log(`  [agent] turn ${iteration}`),
        onToolCallStart: (call) => console.log(`  [agent] calling ${call.function.name}`),
      },
    });
    await runStep(
      'Live LLM tool call and Agent loop',
      'POST /api/chat + ToolRegistry + Agent',
      async () => {
        const result = await agent.run({
          model: activeModel,
          messages: [
            {
              role: 'user',
              content: 'Use add_numbers with left=19 and right=23. Do not calculate it yourself.',
            },
          ],
          options: { temperature: 0, num_predict: 100 },
        });
        const executions = result.turns.flatMap((turn) => turn.toolResults ?? []);
        if (executions.length === 0) {
          throw new Error('The model did not call the registered tool');
        }
        return {
          iterations: result.turns.length,
          toolResults: executions.map((execution) => ({
            toolName: execution.toolName,
            success: execution.success,
            result: execution.success ? execution.result : execution.error.message,
          })),
          finalMessage: result.finalMessage.content,
        };
      },
    );
  } else {
    await skipStep(
      'Tool calling and Agent loop',
      'Selected model does not report the tools capability',
    );
  }

  const embedModelNames = discovery.installedModels;
  const configuredEmbed = process.env['OLLAMA_EMBED_MODEL'] ?? env.embedModel;
  const embedModel =
    embedModelNames.find((name) => name === configuredEmbed) ??
    embedModelNames.find((name) => /embed/i.test(name));
  if (embedModel !== undefined) {
    const embeddings = await runStep(
      'Batch embeddings and cosine similarity',
      'POST /api/embed',
      async () => {
        const vectors = await client.embedText(embedModel, [
          'A dog is playing in a park.',
          'A puppy runs outdoors.',
          'The stock market closed higher today.',
        ]);
        if (vectors.length !== 3)
          throw new Error(`Expected three vectors, received ${vectors.length}`);
        return {
          model: embedModel,
          dimensions: vectors[0]?.length ?? 0,
          relatedSimilarity: cosineSimilarity(vectors[0] ?? [], vectors[1] ?? []),
          unrelatedSimilarity: cosineSimilarity(vectors[0] ?? [], vectors[2] ?? []),
        };
      },
    );
    void embeddings;
  } else {
    await skipStep(
      'Batch embeddings and cosine similarity',
      `No embedding model installed (set OLLAMA_EMBED_MODEL; preferred "${configuredEmbed}")`,
    );
  }

  await runStep('OpenAI-compatible API', 'GET /v1/models + POST /v1/chat/completions', async () => {
    const models = await client.openai.listModels();
    const result = await client.openai.chatCompletions({
      model: activeModel,
      messages: [{ role: 'user', content: 'Reply with exactly: openai compatibility works' }],
      stream: false,
      temperature: 0,
      max_tokens: 40,
    });
    return {
      listedModels: models.data.length,
      response: result.choices[0]?.message.content,
      usage: result.usage,
    };
  });

  await runStep('Anthropic-compatible Messages API', 'POST /v1/messages', async () => {
    const result = await client.anthropic.messages({
      model: activeModel,
      max_tokens: 40,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with exactly: anthropic compatibility works' }],
    });
    return { id: result.id, model: result.model, content: result.content, usage: result.usage };
  });

  await runStep('Generated contract API surface', 'NativeApi through OllamaRuntime', async () => {
    const runtime = new OllamaRuntime({
      http: new HttpClient({
        baseUrl,
        timeoutMs: 30_000,
        onLifecycleEvent: logHttpEvent,
      }),
    });
    const api = new NativeApi(runtime);
    const response = await api.chat({
      model: activeModel,
      messages: [{ role: 'user', content: 'Reply with exactly: generated API works' }],
      stream: false,
      options: { temperature: 0, num_predict: 40 },
    });
    return {
      model: response.model,
      done: response.done,
      response: response.message.content,
    };
  });

  const usageQuota = new QuotaManager({
    windows: [{ id: 'live-tour', windowMs: 60 * 60 * 1000, maxRequests: 100 }],
  });
  if (chat !== undefined) {
    usageQuota.recordUsage(chat);
  }
  if (generated !== undefined) {
    usageQuota.recordUsage(generated);
  }
  await runStep('Usage extraction and local quota accounting', 'SDK usage/quota utilities', () => ({
    usageFromChat:
      chat === undefined
        ? undefined
        : {
            prompt_eval_count: chat.prompt_eval_count,
            eval_count: chat.eval_count,
          },
    usageFromGenerate:
      generated === undefined
        ? undefined
        : {
            prompt_eval_count: generated.prompt_eval_count,
            eval_count: generated.eval_count,
          },
    quota: usageQuota.status(),
    canProceed: usageQuota.canProceed(),
  }));

  const imagePath = process.env['OLLAMA_LIVE_IMAGE'];
  if (imagePath && capabilities?.supportsVision) {
    await runStep('Vision input', 'POST /api/chat with image bytes', async () => {
      const image = new Uint8Array(await readFile(imagePath));
      const response = await client.chatText({
        model: activeModel,
        messages: [
          {
            role: 'user',
            content: 'Describe this image in one short sentence.',
            images: [image],
          },
        ],
        options: { temperature: 0, num_predict: 60 },
      });
      return { imagePath, response };
    });
  } else {
    await skipStep(
      'Vision input',
      imagePath === undefined
        ? 'Set OLLAMA_LIVE_IMAGE to an image file and select a vision-capable model'
        : 'Selected model does not report the vision capability',
    );
  }

  if (process.env['OLLAMA_LIVE_CLOUD'] === '1' && env.apiKey) {
    await runStep(
      'Ollama Cloud web search',
      'POST https://ollama.com/api/web_search',
      () => client.webSearch({ query: 'Ollama SDK documentation', max_results: 2 }),
      (result) => ({ resultCount: result.results.length, results: result.results }),
    );
  } else {
    await skipStep(
      'Ollama Cloud web tools',
      'Not called: set OLLAMA_API_KEY and OLLAMA_LIVE_CLOUD=1 to explicitly opt in to a hosted request',
    );
  }

  const mcpClient: McpClientLike = {
    listTools: async () => ({
      tools: [
        {
          name: 'lookup_status',
          description: 'Look up a demo status record by key.',
          inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
          },
        },
      ],
    }),
    callTool: async ({ name, arguments: args }) => ({
      content: [
        {
          type: 'text',
          text: `${name}(${String(args?.['key'])}) -> ready`,
        },
      ],
      structuredContent: { key: args?.['key'], status: 'ready' },
    }),
  };
  const mcpBridge = new McpBridge(mcpClient, { namePrefix: 'mcp_' });
  const mcpRegistry = new ToolRegistry();
  await runStep(
    'MCP bridge with a live model tool choice',
    'McpBridge + ToolRegistry + real /api/chat; in-memory MCP server adapter',
    async () => {
      await mcpBridge.register(mcpRegistry);
      const agent = new Agent(client, { tools: mcpRegistry, maxIterations: 3 });
      const result = await agent.run({
        model: activeModel,
        messages: [
          {
            role: 'user',
            content: 'Use lookup_status with key "demo" and report the status it returns.',
          },
        ],
        options: { temperature: 0, num_predict: 100 },
      });
      const executions = result.turns.flatMap((turn) => turn.toolResults ?? []);
      if (executions.length === 0) {
        throw new Error('The model did not call the MCP-backed tool');
      }
      return {
        registeredTools: mcpRegistry.definitions().map((definition) => definition.function.name),
        toolResults: executions.map((execution) => ({
          toolName: execution.toolName,
          success: execution.success,
          result: execution.success ? execution.result : execution.error.message,
        })),
        finalMessage: result.finalMessage.content,
      };
    },
  );

  if (process.env['OLLAMA_LIVE_MCP_URL']) {
    await skipStep(
      'Remote MCP server',
      'A remote MCP URL is configured, but this tour intentionally avoids invoking arbitrary remote tools; use the dedicated MCP lab after reviewing its tool list.',
    );
  } else {
    await skipStep(
      'Remote MCP server',
      'Not run: the tour only invokes its safe in-memory adapter; use the dedicated MCP labs to configure a server and review its tools.',
    );
  }

  await skipStep(
    'Model mutation (pull/create/copy/delete/push)',
    'Not run: these operations can download large models or mutate server state',
  );
  await skipStep(
    'Multi-endpoint failover',
    'Not run: this tour targets one local Ollama endpoint; configure multiple endpoints in the dedicated routing labs',
  );

  await printSummary();
}

async function printSummary(): Promise<void> {
  const passed = outcomes.filter((item) => item.status === 'passed').length;
  const failed = outcomes.filter((item) => item.status === 'failed').length;
  const skipped = outcomes.filter((item) => item.status === 'skipped').length;
  console.log('\n════════════════════════════════════════════════════');
  console.log(`LIVE TOUR: ${passed} passed | ${failed} failed | ${skipped} skipped`);
  for (const item of outcomes) {
    const marker = item.status === 'passed' ? '✓' : item.status === 'failed' ? '✗' : '↷';
    console.log(`${marker} ${item.name}${item.error ? ` — ${item.error}` : ''}`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const logPath = `${process.env['LAB_LOG_DIR'] ?? 'logs'}/manual/${date}.jsonl`;
  console.log(`Detailed JSONL logs: ${logPath}`);
  console.log('════════════════════════════════════════════════════');
  if (failed > 0) process.exitCode = 1;
}

void main().catch(async (error: unknown) => {
  const message = errorMessage(error);
  console.error(`Live tour stopped: ${message}`);
  outcomes.push({ name: 'Live tour aborted', status: 'failed', durationMs: 0, error: message });
  await printSummary();
});
