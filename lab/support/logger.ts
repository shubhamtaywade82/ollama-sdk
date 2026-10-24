import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getLabEnv } from './env.js';

export interface ExperimentEvent {
  readonly experimentId: string;
  readonly timestamp: string;
  readonly provider: string;
  readonly endpoint: string;
  readonly model: string;
  readonly operation: string;
  readonly durationMs?: number | undefined;
  readonly prompt?: string | undefined;
  readonly response?: unknown | undefined;
  readonly toolCalls?: readonly unknown[] | undefined;
  readonly toolResults?: readonly unknown[] | undefined;
  readonly tokens?:
    { readonly prompt?: number | undefined; readonly eval?: number | undefined } | undefined;
  readonly error?: string | undefined;
}

export class ExperimentLogger {
  private readonly logDir: string;

  constructor(logDir = getLabEnv().logDir) {
    this.logDir = logDir;
  }

  async log(event: ExperimentEvent): Promise<void> {
    this.printToConsole(event);
    await this.persistJsonl(event);
  }

  async saveAgentTrace(name: string, data: unknown): Promise<string> {
    const tracePath = join(this.logDir, 'agents', `${name}.json`);
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(tracePath, JSON.stringify(data, null, 2), 'utf-8');
    return tracePath;
  }

  private printToConsole(event: ExperimentEvent): void {
    console.log('\n════════════════════════════════════════════');
    console.log(`EXPERIMENT: ${event.experimentId}`);
    console.log('════════════════════════════════════════════');
    console.log(`Provider: ${event.provider} | Endpoint: ${event.endpoint}`);
    console.log(`Model: ${event.model} | Operation: ${event.operation}`);
    if (event.durationMs !== undefined) console.log(`Duration: ${event.durationMs}ms`);
    if (event.toolCalls?.length)
      console.log(`Tool Calls (${event.toolCalls.length}):`, event.toolCalls);
    if (event.toolResults?.length)
      console.log(`Tool Results (${event.toolResults.length}):`, event.toolResults);
    if (event.response !== undefined) console.log('\nResponse:\n', event.response);
    if (event.error !== undefined) console.log('\nError:\n', event.error);
    console.log('════════════════════════════════════════════\n');
  }

  private async persistJsonl(event: ExperimentEvent): Promise<void> {
    const dateStr = event.timestamp.split('T')[0] ?? 'general';
    const filePath = join(this.logDir, 'manual', `${dateStr}.jsonl`);
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  }
}

export const labLogger = new ExperimentLogger();
