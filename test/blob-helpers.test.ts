import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { ModelsClient } from '../src/models-client.js';

/**
 * Blob management upgrades (src/models-client.ts): SHA-256 digest
 * computation, convenience uploads, and the GGUF -> model creation protocol
 * (push blob per file, then POST /api/create with files: {name: digest}).
 */

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function recordingFetch(route: (call: Recorded) => { status: number; json?: unknown } | Response) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const call: Recorded = {
      method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
      path: parsed.pathname,
      body: init?.body,
    };
    calls.push(call);
    const result = route(call);
    if (result instanceof Response) return result;
    return new Response(result.json !== undefined ? JSON.stringify(result.json) : '', {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

let tempDir: string | undefined;

afterAll(async () => {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
});

async function tempFile(name: string, bytes: Uint8Array): Promise<string> {
  tempDir ??= await mkdtemp(join(tmpdir(), 'ollama-sdk-blobs-'));
  const path = join(tempDir, name);
  await writeFile(path, bytes);
  return path;
}

function makeClient(fetchImpl: typeof globalThis.fetch): ModelsClient {
  return new OllamaClient({ fetch: fetchImpl }).models;
}

describe('computeBlobDigest', () => {
  it('produces sha256:<64 lowercase hex> matching node:crypto', async () => {
    const data = new TextEncoder().encode('gguf-payload-bytes');
    const digest = await makeClient((() => new Response('')) as never).computeBlobDigest(data);
    const expected = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    expect(digest).toBe(expected);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('createBlobFromData', () => {
  it('HEAD-checks then POSTs the raw bytes under the computed digest when absent', async () => {
    const data = new TextEncoder().encode('model weights');
    const expectedDigest = `sha256:${createHash('sha256').update(data).digest('hex')}`;

    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.method === 'HEAD') return { status: 404, json: { error: 'not found' } };
      return { status: 201 };
    });

    const result = await makeClient(fetchImpl).createBlobFromData(data);

    expect(result).toEqual({ digest: expectedDigest, alreadyExisted: false });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `HEAD /api/blobs/${encodeURIComponent(expectedDigest)}`,
      `POST /api/blobs/${encodeURIComponent(expectedDigest)}`,
    ]);
    // The POST body is the raw binary payload, not JSON.
    expect(new TextDecoder().decode(calls[1]?.body as unknown as Uint8Array)).toBe('model weights');
  });

  it('skips the upload when the blob already exists (HEAD 200)', async () => {
    const data = new TextEncoder().encode('already there');
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;

    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.method === 'HEAD') return { status: 200 };
      throw new Error(`unexpected ${call.method}`);
    });

    const result = await makeClient(fetchImpl).createBlobFromData(data);
    expect(result).toEqual({ digest, alreadyExisted: true });
    expect(calls).toHaveLength(1); // HEAD only — no POST
  });

  it('honors a caller-provided digest without recomputation', async () => {
    const { fetchImpl, calls } = recordingFetch(() => ({ status: 200 }));
    const result = await makeClient(fetchImpl).createBlobFromData(new TextEncoder().encode('x'), {
      digest: 'sha256:' + 'a'.repeat(64),
    });
    expect(result.digest).toBe('sha256:' + 'a'.repeat(64));
    expect(calls[0]?.path).toBe(`/api/blobs/${encodeURIComponent('sha256:' + 'a'.repeat(64))}`);
  });
});

describe('createBlobFromFile', () => {
  it('reads the file, uploads it, and returns the basename for the files map', async () => {
    const bytes = new TextEncoder().encode('fake gguf content');
    const path = await tempFile('my-model.gguf', bytes);
    const expectedDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.method === 'HEAD') return { status: 404, json: { error: 'nf' } };
      return { status: 201 };
    });

    const result = await makeClient(fetchImpl).createBlobFromFile(path);
    expect(result).toEqual({
      digest: expectedDigest,
      alreadyExisted: false,
      fileName: 'my-model.gguf',
    });
    expect(calls).toHaveLength(2);
  });
});

describe('createModelFromGguf', () => {
  it('uploads each GGUF blob then calls /api/create with files: {name: digest}', async () => {
    const bytesA = new TextEncoder().encode('gguf shard A');
    const bytesB = new TextEncoder().encode('gguf shard B');
    const pathA = await tempFile('model-00001-of-00002.gguf', bytesA);
    const pathB = await tempFile('model-00002-of-00002.gguf', bytesB);
    const digestA = `sha256:${createHash('sha256').update(bytesA).digest('hex')}`;
    const digestB = `sha256:${createHash('sha256').update(bytesB).digest('hex')}`;

    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.path === '/api/create') {
        return { status: 200, json: { status: 'success' } };
      }
      if (call.method === 'HEAD') return { status: 404, json: { error: 'nf' } };
      return { status: 201 };
    });

    const res = await makeClient(fetchImpl).createModelFromGguf('my-model', [pathA, pathB], {
      template: '{{ .Prompt }}',
      parameters: { temperature: 0.7 },
    });
    expect(res).toEqual({ status: 'success' });

    const createCall = calls.find((c) => c.path === '/api/create');
    expect(createCall).toBeDefined();
    const createBody = JSON.parse(String(createCall?.body)) as {
      model: string;
      files: Record<string, string>;
      template: string;
      parameters: Record<string, unknown>;
      stream: boolean;
    };
    expect(createBody.model).toBe('my-model');
    expect(createBody.files).toEqual({
      'model-00001-of-00002.gguf': digestA,
      'model-00002-of-00002.gguf': digestB,
    });
    expect(createBody.template).toBe('{{ .Prompt }}');
    expect(createBody.parameters).toEqual({ temperature: 0.7 });
    expect(createBody.stream).toBe(false);
    // Two blob uploads (HEAD + POST each) before the create call.
    expect(calls.filter((c) => c.path.startsWith('/api/blobs/'))).toHaveLength(4);
  });

  it('rejects an empty path list client-side', async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 200 }));
    await expect(makeClient(fetchImpl).createModelFromGguf('m', [])).rejects.toThrow(
      /at least one GGUF path/,
    );
  });
});
