/**
 * Conformance test harness — shared setup + skip-when-unavailable logic.
 *
 * Conformance tests hit a REAL Ollama server (no mocks, no VCR cassettes).
 * They are the last line of defense against wire-vs-contract drift:
 * if Ollama's actual response shape diverges from what the IR-derived
 * Zod schema expects, these tests fail.
 *
 * ## Two flavors of conformance test
 *
 *   1. **Live conformance** (this harness, `native-api.test.ts`,
 *      `system-one.test.ts`) — hits a real Ollama server. Skips
 *      cleanly when none is available. Validates BOTH wire format
 *      AND model behavior (e.g. "the model actually generates text
 *      in response to a prompt").
 *
 *   2. **Offline wire-format conformance** (`native-api-offline.test.ts`)
 *      — uses `OllamaMockServer` to emit contract-shaped NDJSON
 *      frames without any model inference. Runs in every CI
 *      environment, including those without an Ollama daemon.
 *      Validates ONLY the wire format (schema conformance,
 *      error-class mapping, optional-field handling). Does NOT
 *      validate model behavior.
 *
 * The split exists because wire-format drift is a contract concern
 * (catchable offline), while model-behavior drift is a server/model
 * concern (only catchable against a live server). The offline tests
 * catch the former in every PR; the live tests catch the latter
 * when a real server is available.
 *
 * ## Two ways to run the LIVE tests
 *
 *   1. Locally against `ollama serve`:
 *        OLLAMA_BASE_URL=http://localhost:11434 npx vitest run test/conformance/
 *
 *   2. In CI (the `conformance` job in .github/workflows/ci.yml):
 *      uses a service container running `ollama/ollama` and pulls a
 *      tiny model before the test run.
 *
 * If `OLLAMA_BASE_URL` is not set OR the server is unreachable, every
 * LIVE conformance test is skipped with a clear reason — the main
 * test suite (`npm test`) and the offline conformance tests are NOT
 * affected.
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

/**
 * A System One-compatible decision model for the systemOne conformance
 * tests. Wave 13: System One requires a dedicated decision model (not a
 * general LLM). The default is `tev1:0.8b` (smallest System One model);
 * override via OLLAMA_CONFORMANCE_SYSTEMONE_MODEL.
 */
export const CONFORMANCE_SYSTEMONE_MODEL =
  process.env.OLLAMA_CONFORMANCE_SYSTEMONE_MODEL ?? 'tev1:0.8b';

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

let cachedModel: string | undefined;

async function resolveModel(baseUrl: string): Promise<string> {
  if (process.env.OLLAMA_CONFORMANCE_MODEL) {
    return process.env.OLLAMA_CONFORMANCE_MODEL;
  }
  if (cachedModel !== undefined) return cachedModel;

  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        models?: Array<{ name?: string; remote_host?: string }>;
      };
      const models = data.models ?? [];
      const hasDefault = models.some((m) => m.name === CONFORMANCE_MODEL);
      const fallback =
        models.find(
          (m) =>
            m.name && /qwen|llama/i.test(m.name) && !m.name.includes('embed') && !m.remote_host,
        ) ??
        models.find(
          (m) => m.name && !m.name.includes('embed') && !m.name.startsWith('tev') && !m.remote_host,
        ) ??
        models.find((m) => m.name && !m.name.includes('embed') && !m.remote_host);
      cachedModel = hasDefault ? CONFORMANCE_MODEL : (fallback?.name ?? CONFORMANCE_MODEL);
      return cachedModel;
    }
  } catch {
    // Tags endpoint failed; fall back to configured default
  }

  cachedModel = CONFORMANCE_MODEL;
  return cachedModel;
}

export interface ConformanceSetup {
  readonly client: OllamaClient;
  readonly api: NativeApi;
  readonly baseUrl: string;
  readonly model: string;
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
  const model = await resolveModel(baseUrl);
  const client = new OllamaClient({ baseUrl });
  const http = new HttpClient({ baseUrl });
  const runtime = new OllamaRuntime({ http });
  const api = new NativeApi(runtime);
  return { client, api, baseUrl, model };
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
 *
 * Conformance tests hit a REAL Ollama server, which means the first
 * request to each model triggers a model load (downloading weights
 * into memory). On CI this can take 10–60s for small models. The
 * default vitest test timeout (5s) is far too short — we use 120s
 * to match the functional test suite (see test/functional-models-blobs.test.ts).
 */
export function itConformance(
  name: string,
  fn: (ctx: { skip: () => never }) => Promise<void>,
): void {
  it(
    name,
    async (ctx) => {
      const baseUrl = conformanceBaseUrl();
      if (!baseUrl) {
        ctx.skip();
      }
      if (!(await isOllamaReachable(baseUrl!))) {
        ctx.skip();
      }
      await fn(ctx as { skip: () => never });
    },
    120_000,
  );
}
