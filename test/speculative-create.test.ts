import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import type { ModelsClient } from '../src/models-client.js';

/**
 * Speculative-decoding model assembly (Oct-12 digest): the wire contract for
 * `draft_files` / `draft_quantize` on `/api/create` and the
 * `createModelFromGguf({ draftGguf })` convenience.
 *
 * Audit note: the `draft_files` + `draft_quantize` request fields already
 * existed on `CreateRequestOptions` (generated AND hand-written types) —
 * the digest's "SDK types only expose files and base quantize" claim was
 * stale. What was missing: a path-based draft upload convenience, wire
 * tests proving the fields round-trip, and the `draft_num_predict`
 * parameter documentation. All three are pinned here.
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
  tempDir ??= await mkdtemp(join(tmpdir(), 'ollama-sdk-draft-'));
  const path = join(tempDir, name);
  await writeFile(path, bytes);
  return path;
}

function sha(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function makeClient(fetchImpl: typeof globalThis.fetch): ModelsClient {
  return new OllamaClient({ fetch: fetchImpl }).models;
}

function blobRoute(call: Recorded): { status: number; json?: unknown } {
  if (call.path === '/api/create') return { status: 200, json: { status: 'success' } };
  if (call.method === 'HEAD') return { status: 404, json: { error: 'nf' } };
  return { status: 201 };
}

describe('createModel: speculative-decoding fields on the wire', () => {
  it('passes draft_files, draft_quantize, and parameters.draft_num_predict through to /api/create', async () => {
    const { fetchImpl, calls } = recordingFetch(blobRoute);
    const res = await makeClient(fetchImpl).create({
      model: 'spec-model',
      files: { 'model.gguf': 'sha256:' + 'a'.repeat(64) },
      draft_files: { 'draft.gguf': 'sha256:' + 'b'.repeat(64) },
      quantize: 'q4_0',
      draft_quantize: 'q8_0',
      parameters: { draft_num_predict: 8 },
      stream: false,
    });
    expect(res.status).toBe('success');

    const createCall = calls.find((c) => c.path === '/api/create');
    expect(createCall).toBeDefined();
    const body = JSON.parse(String(createCall?.body)) as {
      files: Record<string, string>;
      draft_files: Record<string, string>;
      quantize: string;
      draft_quantize: string;
      parameters: Record<string, unknown>;
    };
    expect(body.files).toEqual({ 'model.gguf': 'sha256:' + 'a'.repeat(64) });
    expect(body.draft_files).toEqual({ 'draft.gguf': 'sha256:' + 'b'.repeat(64) });
    expect(body.quantize).toBe('q4_0');
    expect(body.draft_quantize).toBe('q8_0');
    expect(body.parameters).toEqual({ draft_num_predict: 8 });
  });
});

describe('createModelFromGguf: draft shards (draftGguf)', () => {
  it('uploads draft blobs separately and assembles them into draft_files alongside files', async () => {
    const primary = new TextEncoder().encode('primary gguf bytes');
    const draft = new TextEncoder().encode('draft gguf bytes');
    const primaryPath = await tempFile('model.gguf', primary);
    const draftPath = await tempFile('draft.gguf', draft);

    const { fetchImpl, calls } = recordingFetch(blobRoute);
    const res = await makeClient(fetchImpl).createModelFromGguf('spec-model', primaryPath, {
      draftGguf: draftPath,
      draft_quantize: 'q8_0',
      parameters: { draft_num_predict: 8 },
    });
    expect(res).toEqual({ status: 'success' });

    const createCall = calls.find((c) => c.path === '/api/create');
    expect(createCall).toBeDefined();
    const body = JSON.parse(String(createCall?.body)) as {
      model: string;
      files: Record<string, string>;
      draft_files: Record<string, string>;
      draft_quantize: string;
      parameters: Record<string, unknown>;
      stream: boolean;
    };
    expect(body.model).toBe('spec-model');
    expect(body.files).toEqual({ 'model.gguf': sha(primary) });
    expect(body.draft_files).toEqual({ 'draft.gguf': sha(draft) });
    expect(body.draft_quantize).toBe('q8_0');
    expect(body.parameters).toEqual({ draft_num_predict: 8 });
    expect(body.stream).toBe(false);
    // One HEAD + one POST per uploaded blob: primary + draft.
    expect(calls.filter((c) => c.path.startsWith('/api/blobs/'))).toHaveLength(4);
    // The draft blob was actually uploaded (a POST to its digest URL).
    expect(
      calls.some(
        (c) => c.method === 'POST' && c.path === `/api/blobs/${encodeURIComponent(sha(draft))}`,
      ),
    ).toBe(true);
  });

  it('supports multiple draft shards (split draft GGUFs)', async () => {
    const primary = new TextEncoder().encode('primary');
    const draftA = new TextEncoder().encode('draft shard A');
    const draftB = new TextEncoder().encode('draft shard B');
    const primaryPath = await tempFile('model.gguf', primary);
    const draftAPath = await tempFile('draft-00001-of-00002.gguf', draftA);
    const draftBPath = await tempFile('draft-00002-of-00002.gguf', draftB);

    const { fetchImpl, calls } = recordingFetch(blobRoute);
    await makeClient(fetchImpl).createModelFromGguf('spec-model', primaryPath, {
      draftGguf: [draftAPath, draftBPath],
    });

    const createCall = calls.find((c) => c.path === '/api/create');
    const body = JSON.parse(String(createCall?.body)) as {
      draft_files: Record<string, string>;
    };
    expect(body.draft_files).toEqual({
      'draft-00001-of-00002.gguf': sha(draftA),
      'draft-00002-of-00002.gguf': sha(draftB),
    });
  });

  it('omits draft_files entirely when no draft is given (no empty maps on the wire)', async () => {
    const primary = new TextEncoder().encode('primary');
    const primaryPath = await tempFile('model.gguf', primary);

    const { fetchImpl, calls } = recordingFetch(blobRoute);
    await makeClient(fetchImpl).createModelFromGguf('plain-model', primaryPath);

    const createCall = calls.find((c) => c.path === '/api/create');
    const raw = String(createCall?.body);
    expect(raw).not.toContain('draft_files');
    expect(raw).not.toContain('draftGguf');
  });

  it('merges an explicit draft_files digest map with uploaded draft paths (paths win on collision)', async () => {
    const primary = new TextEncoder().encode('primary');
    const draft = new TextEncoder().encode('draft bytes');
    const primaryPath = await tempFile('model.gguf', primary);
    const draftPath = await tempFile('draft.gguf', draft);

    const { fetchImpl, calls } = recordingFetch(blobRoute);
    await makeClient(fetchImpl).createModelFromGguf('spec-model', primaryPath, {
      draftGguf: draftPath,
      draft_files: {
        // Different file — both should survive the merge.
        'pre-uploaded-draft.gguf': 'sha256:' + 'c'.repeat(64),
        // Same basename as the uploaded path — the upload wins.
        'draft.gguf': 'sha256:' + 'd'.repeat(64),
      },
    });

    const createCall = calls.find((c) => c.path === '/api/create');
    const body = JSON.parse(String(createCall?.body)) as {
      draft_files: Record<string, string>;
    };
    expect(body.draft_files).toEqual({
      'pre-uploaded-draft.gguf': 'sha256:' + 'c'.repeat(64),
      'draft.gguf': sha(draft),
    });
  });

  it('treats an empty draftGguf array as "no draft" (primary paths still required)', async () => {
    const primary = new TextEncoder().encode('primary');
    const primaryPath = await tempFile('model.gguf', primary);

    const { fetchImpl, calls } = recordingFetch(blobRoute);
    await makeClient(fetchImpl).createModelFromGguf('spec-model', primaryPath, {
      draftGguf: [],
    });
    const createCall = calls.find((c) => c.path === '/api/create');
    expect(String(createCall?.body)).not.toContain('draft_files');
  });
});
