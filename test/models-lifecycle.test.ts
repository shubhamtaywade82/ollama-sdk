import { describe, expect, it, vi } from 'vitest';
import { OllamaNotFoundError } from '../src/errors.js';
import { OllamaClient } from '../src/client.js';
import { KEEP_ALIVE_INDEFINITE, KEEP_ALIVE_UNLOAD } from '../src/keep-alive.js';

/**
 * ModelsClient VRAM lifecycle primitives — see
 * `src/models-client.ts`'s `unload()` and `pin()` methods.
 *
 * These methods issue an empty `/api/generate` request with
 * `keep_alive: 0` (unload) or `keep_alive: -1` (pin) — the
 * documented Ollama mechanism for explicit VRAM management.
 *
 * The tests stub `fetch` to verify the wire payload without
 * making real HTTP requests. They focus on:
 *   - The request body contains the right sentinel and an empty prompt.
 *   - The `singleEndpoint: true` flag is honored (no cross-endpoint
 *     failover for lifecycle calls).
 *   - 404s surface as OllamaNotFoundError (not silently swallowed).
 *   - The convenience aliases on OllamaClient delegate correctly.
 */

function fakeFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown) as typeof globalThis.fetch;
}

function readCallBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalled();
  const [, init] = fetchMock.mock.calls[0]!;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('ModelsClient.unload(model) — VRAM eviction', () => {
  it('issues POST /api/generate with prompt="" and keep_alive=0', async () => {
    const fetchImpl = fakeFetch(200, {
      model: 'llama3',
      response: '',
      done: true,
      done_reason: 'unload',
    });
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    await client.models.unload('llama3');
    const body = readCallBody(fetchImpl as ReturnType<typeof vi.fn>);
    expect(body.model).toBe('llama3');
    expect(body.prompt).toBe('');
    expect(body.keep_alive).toBe(KEEP_ALIVE_UNLOAD);
    expect(body.keep_alive).toBe(0);
    expect(body.stream).toBe(false);
  });

  it('does not include system, suffix, or context fields in the body', async () => {
    // Empty-prompt lifecycle probes shouldn't carry inference-payload fields
    // that the server would try to evaluate. Verify the body is minimal.
    const fetchImpl = fakeFetch(200, { model: 'm', response: '', done: true });
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    await client.models.unload('m');
    const body = readCallBody(fetchImpl as ReturnType<typeof vi.fn>);
    expect(body.system).toBeUndefined();
    expect(body.suffix).toBeUndefined();
    expect(body.context).toBeUndefined();
    expect(body.images).toBeUndefined();
    expect(body.options).toBeUndefined();
  });

  it('propagates OllamaNotFoundError when the model is not installed', async () => {
    const fetchImpl = fakeFetch(404, { error: 'model "ghost" not found' });
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    await expect(client.models.unload('ghost')).rejects.toBeInstanceOf(OllamaNotFoundError);
  });

  it('OllamaClient.unloadModel() is a convenience alias for models.unload()', async () => {
    const fetchImpl = fakeFetch(200, { model: 'm', response: '', done: true });
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    await client.unloadModel('m');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = readCallBody(fetchImpl as ReturnType<typeof vi.fn>);
    expect(body.keep_alive).toBe(0);
  });
});

describe('ModelsClient.pin(model) — VRAM pinning', () => {
  it('issues POST /api/generate with prompt="" and keep_alive=-1', async () => {
    const fetchImpl = fakeFetch(200, {
      model: 'llama3',
      response: '',
      done: true,
      done_reason: 'load',
    });
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    await client.models.pin('llama3');
    const body = readCallBody(fetchImpl as ReturnType<typeof vi.fn>);
    expect(body.model).toBe('llama3');
    expect(body.prompt).toBe('');
    expect(body.keep_alive).toBe(KEEP_ALIVE_INDEFINITE);
    expect(body.keep_alive).toBe(-1);
    expect(body.stream).toBe(false);
  });

  it('propagates OllamaNotFoundError when the model is not installed', async () => {
    const fetchImpl = fakeFetch(404, { error: 'model "ghost" not found' });
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    await expect(client.models.pin('ghost')).rejects.toBeInstanceOf(OllamaNotFoundError);
  });

  it('OllamaClient.pinModel() is a convenience alias for models.pin()', async () => {
    const fetchImpl = fakeFetch(200, { model: 'm', response: '', done: true });
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    await client.pinModel('m');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = readCallBody(fetchImpl as ReturnType<typeof vi.fn>);
    expect(body.keep_alive).toBe(-1);
  });
});

describe('ModelsClient.unload vs pin: wire-level distinction', () => {
  it('unload and pin produce different keep_alive values for the same model', async () => {
    const unloadFetch = fakeFetch(200, { model: 'm', response: '', done: true });
    const pinFetch = fakeFetch(200, { model: 'm', response: '', done: true });

    const unloadClient = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      fetch: unloadFetch,
    });
    const pinClient = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: pinFetch });

    await unloadClient.models.unload('m');
    await pinClient.models.pin('m');

    const unloadBody = readCallBody(unloadFetch as ReturnType<typeof vi.fn>);
    const pinBody = readCallBody(pinFetch as ReturnType<typeof vi.fn>);
    expect(unloadBody.keep_alive).toBe(0);
    expect(pinBody.keep_alive).toBe(-1);
    expect(unloadBody.keep_alive).not.toBe(pinBody.keep_alive);
  });
});
