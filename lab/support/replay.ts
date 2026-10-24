import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getLabEnv } from './env.js';

export interface RecordedRun<T = unknown> {
  readonly experimentId: string;
  readonly recordedAt: string;
  readonly input: unknown;
  readonly result: T;
}

export async function recordRun<T>(
  experimentId: string,
  input: unknown,
  result: T,
): Promise<string> {
  const env = getLabEnv();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetPath = join(env.logDir, 'replay', `${experimentId}-${timestamp}.json`);
  const record: RecordedRun<T> = {
    experimentId,
    recordedAt: new Date().toISOString(),
    input,
    result,
  };
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(record, null, 2), 'utf-8');
  console.log(`[replay] Saved run snapshot to: ${targetPath}`);
  return targetPath;
}

export async function loadReplay<T>(replayPath: string): Promise<RecordedRun<T>> {
  const raw = await readFile(replayPath, 'utf-8');
  return JSON.parse(raw) as RecordedRun<T>;
}
