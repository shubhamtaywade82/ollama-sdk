/**
 * Conformance test harness — shared setup + skip-when-unavailable logic.
 *
 * Conformance tests hit a REAL Ollama server (no mocks, no VCR cassettes).
 * They are the last line of defense against wire-vs-contract drift:
 * if Ollama's actual response shape diverges from what the IR-derived
 * Zod schema expects, these tests fail.
 *
 * Two ways to run:
 *
 *   1. Locally against `ollama serve`:
 *        OLLAMA_BASE_URL=http://localhost:11434 npx vitest run test/conformance/
 *
 *   2. In CI (the `conformance` job in .github/workflows/ci.yml):
 *      uses a service container running `ollama/ollama` and pulls a
 *      tiny model before the test run.
 *
 * If `OLLAMA_BASE_URL` is not set OR the server is unreachable, every
 * conformance test is skipped with a clear reason — the main
 * test suite (`npm test`) is NOT affected.
 */
import { beforeAll, describe, it } from 'vitest';
import { OllamaClient } from '../../src/index.js';
import { HttpClient } from '../../src/transport/http.js';
import { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import { NativeApi } from '../../src/generated/api/native-api.js';

/** Read the base URL from env, defaulting to localhost. */
export function conformanceBaseUrl(): string | undefined {
  return process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
}

/** A small model the conformance suite can rely on being available. */
export const CONFORMANCE_MODEL = process.env.OLLAMA_CONFORMANCE_MODEL ?? 'qwen3:0.6b';

/** A small embedding model for the embed conformance test. */
export const CONFORMANCE_EMBED_MODEL =
  process.env.OLLAMA_CONFORMANCE_EMBED_MODEL ?? 'nomic-embed-text:latest';

let reachable: boolean | undefined;

/** Probe the server once; cache the result for the duration of the run. */
export async function isOllamaReachable(baseUrl: string): Promise<boolean> {
  if (reachable !== undefined) return reachable;
  try {
    const res = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  return reachable;
}

export interface ConformanceSetup {
  readonly client: OllamaClient;
  readonly api: NativeApi;
  readonly baseUrl: string;
}

/**
 * Set up a shared OllamaClient + NativeApi for a conformance test file.
 * Returns `undefined` when Ollama isn't reachable, so callers can skip
 * cleanly without throwing.
 */
export async function setupConformance(): Promise<ConformanceSetup | undefined> {
  const baseUrl = conformanceBaseUrl();
  if (!baseUrl) return undefined;
  if (!(await isOllamaReachable(baseUrl))) return undefined;
  const client = new OllamaClient({ baseUrl });
  const http = new HttpClient({ baseUrl });
  const runtime = new OllamaRuntime({ http });
  const api = new NativeApi(runtime);
  return { client, api, baseUrl };
}

/**
 * `describe` wrapper that probes Ollama before running. If unreachable,
 * prints a clear reason and the inner tests will skip themselves via
 * {@link itConformance}.
 */
export function describeConformance(name: string, fn: () => void): void {
  describe(name, () => {
    beforeAll(async () => {
      const baseUrl = conformanceBaseUrl();
      if (!baseUrl) {
        console.warn(`[conformance] OLLAMA_BASE_URL not set; skipping "${name}"`);
        return;
      }
      if (!(await isOllamaReachable(baseUrl))) {
        console.warn(
          `[conformance] Ollama not reachable at ${baseUrl}; skipping "${name}". ` +
            `Start it with \`ollama serve\` or set OLLAMA_BASE_URL.`,
        );
      }
    });
    fn();
  });
}

/**
 * `it` wrapper that skips when Ollama isn't reachable. Use inside
 * {@link describeConformance} blocks.
 *
 * The skip is achieved by calling `ctx.skip()` inside the test body
 * (vitest's runtime skip) — the test runner reports it as skipped
 * rather than passed, making the conformance suite's intent visible
 * in CI output.
 */
export function itConformance(
  name: string,
  fn: (ctx: { skip: () => never }) => Promise<void>,
): void {
  it(name, async (ctx) => {
    const baseUrl = conformanceBaseUrl();
    if (!baseUrl) {
      ctx.skip();
    }
    if (!(await isOllamaReachable(baseUrl!))) {
      ctx.skip();
    }
    await fn(ctx as { skip: () => never });
  });
}
