import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as nodeCrypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as fs from 'node:fs/promises';
import { OllamaClient } from '../src/client.js';
import { OllamaAbortError } from '../src/errors.js';
import { createMockOllamaServer, type OllamaMockServer } from '../src/testing/index.js';

/**
 * Streaming blob uploads (MOD-01) + typed-array view safety (BUF-01) —
 * the Oct-14 audit's transport-facing findings (ADR 0032).
 *
 * MOD-01 verdict: REAL for the blob path — `createBlobFromFile` used to
 * `fs.readFile` the whole file (multi-GB GGUFs hit the V8 heap ceiling) and
 * the transport never set `duplex: 'half'`, so the `ReadableStream` member
 * of `BinaryBody` was a promise Node's fetch rejected at dispatch. Both are
 * pinned here: duplex injection (unit, injected fetch), byte-exact streamed
 * uploads (raw capture server), two-pass `createBlobFromFile` (streaming
 * hash + streaming upload against a real HTTP server), abort semantics, and
 * the daemonless public-mock round trips incl. `createModelFromGguf`.
 *
 * BUF-01 verdict: STALE as a defect (src has zero `Buffer.from(view.buffer)`
 * call sites — Web APIs are view-safe by construction), but the invariant is
 * pinned with the digest's own suggested probe: a `subarray(10, 20)` view
 * must hash AND transmit exactly its 10 bytes, never the parent buffer.
 */

/** The wire path the client builds for a digest (note the `:` → `%3A` encoding). */
function blobPath(digest: string): string {
  return `/api/blobs/${encodeURIComponent(digest)}`;
}

function sha256Hex(bytes: Uint8Array | Buffer | string): string {
  return `sha256:${nodeCrypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Byte-precise capture server: HEAD status is scriptable, POST bodies are recorded verbatim. */
function createCaptureServer(opts?: {
  readonly headStatus?: number;
  readonly stallPost?: boolean;
}): {
  start: () => Promise<string>;
  stop: () => Promise<void>;
  setHeadStatus: (status: number) => void;
  bodyOf: (path: string) => Buffer;
  hitsOf: (path: string) => number;
  totalHits: () => number;
} {
  let headStatus = opts?.headStatus ?? 404;
  const received = new Map<string, Buffer[]>();
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (req.method === 'HEAD') {
      res.writeHead(headStatus);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.set(path, [...(received.get(path) ?? []), Buffer.concat(chunks)]);
      if (opts?.stallPost) {
        // Consume the body but never respond — the abort fixture.
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return {
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    setHeadStatus: (status: number) => {
      headStatus = status;
    },
    bodyOf: (path: string) => Buffer.concat(received.get(path) ?? []),
    hitsOf: (path: string) => hits.get(path) ?? 0,
    totalHits: () => [...hits.values()].reduce((sum, count) => sum + count, 0),
  };
}

type CaptureServer = ReturnType<typeof createCaptureServer>;

const tmpPaths: string[] = [];
const pendingStops: Array<Promise<void>> = [];
let activeServer: CaptureServer | undefined;
let mockServer: OllamaMockServer | undefined;

afterEach(async () => {
  if (activeServer) {
    const server = activeServer;
    activeServer = undefined;
    await server.stop();
  }
  if (mockServer) {
    const server = mockServer;
    mockServer = undefined;
    await server.stop();
  }
  await Promise.allSettled(pendingStops.splice(0));
  await Promise.allSettled(
    tmpPaths.splice(0).map((p) => fs.rm(p, { force: true }).catch(() => undefined)),
  );
});

async function startCaptureServer(opts?: {
  headStatus?: number;
  stallPost?: boolean;
}): Promise<{ baseUrl: string; server: CaptureServer }> {
  const server = createCaptureServer(opts);
  const baseUrl = await server.start();
  activeServer = server;
  return { baseUrl, server };
}

async function writeTempFile(name: string, content: string | Uint8Array): Promise<string> {
  const filePath = nodePath.join(os.tmpdir(), `ollama-sdk-test-${process.pid}-${name}`);
  await fs.writeFile(filePath, content);
  tmpPaths.push(filePath);
  return filePath;
}

describe('transport duplex injection (MOD-01: the BinaryBody stream member becomes real)', () => {
  it("sets duplex:'half' on the fetch init when the body is a ReadableStream", async () => {
    const captured: Array<RequestInit | undefined> = [];
    const client = new OllamaClient({
      baseUrl: 'http://capture.test',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'HEAD') {
          return new Response(null, { status: 404 });
        }
        captured.push(init);
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });

    const payload = new TextEncoder().encode('stream-me');
    const body = streamOf([payload]);
    await client.createBlob(sha256Hex(payload), body);

    const init = captured.at(-1);
    expect(init).toBeDefined();
    // Node's undici requires this member for stream bodies; without it the
    // dispatch throws "duplex option is required when sending a body".
    expect((init as { duplex?: string }).duplex).toBe('half');
    // The stream is handed to fetch as-is — no buffering at the seam.
    expect(init?.body).toBe(body);
    expect(init?.method).toBe('POST');
  });

  it('never sets duplex for JSON bodies or body-less GETs', async () => {
    const captured: Array<RequestInit | undefined> = [];
    const client = new OllamaClient({
      baseUrl: 'http://capture.test',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.push(init);
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });

    await client.models.show({ model: 'some-model' }); // POST, JSON body
    expect('duplex' in (captured.at(-1) ?? {})).toBe(false);

    await client.version(); // GET, no body
    expect('duplex' in (captured.at(-1) ?? {})).toBe(false);
  });
});

describe('typed-array view safety (BUF-01: byteOffset/byteLength bounds)', () => {
  it("computeBlobDigest hashes the view's bytes, not the parent buffer (subarray(10, 20))", async () => {
    const client = new OllamaClient({ baseUrl: 'http://unused.test' });
    // A patterned pool where every offset is distinguishable — garbage from
    // a wrong offset would change the digest.
    const pool = new Uint8Array(1024);
    for (let i = 0; i < pool.length; i += 1) {
      pool[i] = (i * 7 + 3) & 0xff;
    }
    const view = pool.subarray(10, 20);
    const standalone = pool.slice(10, 20);

    const viewDigest = await client.models.computeBlobDigest(view);
    expect(viewDigest).toBe(await client.models.computeBlobDigest(standalone));
    // External oracle: node:crypto over the exact slice bytes.
    expect(viewDigest).toBe(sha256Hex(standalone));
    // And it is NOT the digest of the parent buffer or of offset 0.
    expect(viewDigest).not.toBe(sha256Hex(pool));
    expect(viewDigest).not.toBe(sha256Hex(pool.subarray(0, 10)));
  });

  it('createBlob transmits exactly the subarray — 10 bytes on the wire, not the 1024-byte parent', async () => {
    const { baseUrl, server } = await startCaptureServer();
    const client = new OllamaClient({ baseUrl });

    const pool = new Uint8Array(1024);
    for (let i = 0; i < pool.length; i += 1) {
      pool[i] = (i * 13 + 5) & 0xff;
    }
    const view = pool.subarray(10, 20);
    const digest = await client.models.computeBlobDigest(view);

    await client.createBlob(digest, view);

    const path = blobPath(digest);
    expect(server.hitsOf(path)).toBe(1); // the POST itself — root createBlob never probes
    expect(server.bodyOf(path).byteLength).toBe(10);
    expect(server.bodyOf(path).equals(Buffer.from(pool.subarray(10, 20)))).toBe(true);
  });
});

describe('createBlobFromStream (MOD-01: streamed uploads without bulk buffering)', () => {
  it('streams a multi-chunk body byte-for-byte (dedupe HEAD first, then one POST)', async () => {
    const { baseUrl, server } = await startCaptureServer();
    const client = new OllamaClient({ baseUrl });

    const chunks = [
      new Uint8Array([0x00, 0x01, 0xfe, 0xff]),
      nodeCrypto.randomBytes(1024),
      new Uint8Array([0xaa, 0x55]),
    ];
    const expected = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const digest = sha256Hex(expected);

    const result = await client.models.createBlobFromStream(digest, streamOf(chunks));

    expect(result).toEqual({ digest, alreadyExisted: false });
    const path = blobPath(digest);
    expect(server.hitsOf(path)).toBe(2);
    expect(server.bodyOf(path).byteLength).toBe(expected.byteLength);
    expect(server.bodyOf(path).equals(expected)).toBe(true);
  });

  it('skips the upload when the HEAD probe says the blob already exists', async () => {
    const { baseUrl, server } = await startCaptureServer({ headStatus: 200 });
    const client = new OllamaClient({ baseUrl });

    const payload = new TextEncoder().encode('already-there');
    const digest = sha256Hex(payload);
    const result = await client.models.createBlobFromStream(digest, streamOf([payload]));

    expect(result).toEqual({ digest, alreadyExisted: true });
    const path = blobPath(digest);
    expect(server.hitsOf(path)).toBe(1); // HEAD only
    expect(server.bodyOf(path).byteLength).toBe(0);
  });

  it('aborts a stalled upload and surfaces OllamaAbortError', async () => {
    const { baseUrl } = await startCaptureServer({ stallPost: true });
    const client = new OllamaClient({ baseUrl });

    const payload = new TextEncoder().encode('stalled-upload');
    const digest = sha256Hex(payload);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);

    await expect(
      client.models.createBlobFromStream(digest, streamOf([payload]), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(OllamaAbortError);
  });
});

describe('createBlobFromFile — two streaming passes (MOD-01: multi-GB GGUFs never enter the heap)', () => {
  it('hashes and uploads a multi-chunk file byte-exactly (streaming hash matches the whole-file digest)', async () => {
    const { baseUrl, server } = await startCaptureServer();
    const client = new OllamaClient({ baseUrl });

    // 300 KiB of random bytes → ≥2 chunks at the 256 KiB read size per pass.
    const fileBytes = nodeCrypto.randomBytes(300 * 1024);
    const filePath = await writeTempFile('streaming-upload.gguf', fileBytes);

    const result = await client.models.createBlobFromFile(filePath);

    const expectedDigest = sha256Hex(fileBytes);
    expect(result.digest).toBe(expectedDigest);
    expect(result.alreadyExisted).toBe(false);
    expect(result.fileName).toBe(nodePath.basename(filePath));

    const path = blobPath(expectedDigest);
    expect(server.hitsOf(path)).toBe(2); // HEAD + POST
    expect(server.bodyOf(path).byteLength).toBe(fileBytes.byteLength);
    expect(server.bodyOf(path).equals(fileBytes)).toBe(true);
  });

  it('honors opts.digest (hash pass skipped) and dedupes once the server has the blob', async () => {
    const { baseUrl, server } = await startCaptureServer();
    const client = new OllamaClient({ baseUrl });

    const fileBytes = nodeCrypto.randomBytes(10);
    const filePath = await writeTempFile('known-digest.gguf', fileBytes);
    const givenDigest = sha256Hex(fileBytes);

    const first = await client.models.createBlobFromFile(filePath, { digest: givenDigest });
    expect(first).toEqual({
      digest: givenDigest,
      alreadyExisted: false,
      fileName: nodePath.basename(filePath),
    });

    // Second call: the server now answers HEAD 200 → upload skipped.
    server.setHeadStatus(200);
    const second = await client.models.createBlobFromFile(filePath, { digest: givenDigest });
    expect(second.alreadyExisted).toBe(true);
    const path = blobPath(givenDigest);
    expect(server.hitsOf(path)).toBe(3); // HEAD + POST + HEAD, no second POST
  });

  it('rejects with OllamaAbortError before any HTTP traffic when the signal is already aborted', async () => {
    const { baseUrl, server } = await startCaptureServer();
    const client = new OllamaClient({ baseUrl });

    const filePath = await writeTempFile('aborted.gguf', nodeCrypto.randomBytes(300 * 1024));
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.models.createBlobFromFile(filePath, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(OllamaAbortError);
    // The abort fires in the hash pass — no HEAD, no POST, nothing on the wire.
    expect(server.totalHits()).toBe(0);
  });
});

describe('public mock-server parity (daemonless e2e through the testing surface)', () => {
  it('streams blobs through request-aware mock routes: HEAD 404 → POST → HEAD 200 dedupe', async () => {
    mockServer = createMockOllamaServer();
    const payload = new TextEncoder().encode('mock-streaming-blob-payload');
    const digest = sha256Hex(payload);

    let uploaded = false;
    mockServer.register(blobPath(digest), {
      responder: (record) => {
        if (record.method === 'HEAD') {
          return { status: uploaded ? 200 : 404 };
        }
        uploaded = true;
        return { status: 200 };
      },
    });
    await mockServer.start();
    const client = new OllamaClient({ baseUrl: mockServer.baseUrl });

    const first = await client.models.createBlobFromStream(digest, streamOf([payload]));
    expect(first).toEqual({ digest, alreadyExisted: false });

    const second = await client.models.createBlobFromStream(digest, streamOf([payload]));
    expect(second).toEqual({ digest, alreadyExisted: true });

    const wire = mockServer.requests
      .filter((r) => r.path === blobPath(digest))
      .map((r) => r.method);
    expect(wire).toEqual(['HEAD', 'POST', 'HEAD']);
  });

  it('createModelFromGguf streams its shards through the blob path (the MOD-01 headline flow)', async () => {
    mockServer = createMockOllamaServer();
    // ASCII-only content so the mock's string body recording is byte-faithful.
    const content = `GGUF${'-'.repeat(512 * 1024)}EOF`;
    const fileBytes = Buffer.from(content, 'utf-8');
    const digest = sha256Hex(fileBytes);
    const filePath = await writeTempFile('headline.gguf', fileBytes);

    mockServer.register(blobPath(digest), {
      responder: (record) => {
        if (record.method === 'HEAD') {
          return { status: 404 };
        }
        return { status: 200 };
      },
    });
    mockServer.register('/api/create', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify({ status: 'success' }),
    });
    await mockServer.start();
    const client = new OllamaClient({ baseUrl: mockServer.baseUrl });

    const result = await client.models.createModelFromGguf('headline-model', filePath);

    expect(result.status).toBe('success');
    // The blob POST carried the file's exact bytes…
    const blobPost = mockServer.requests.find(
      (r) => r.path === blobPath(digest) && r.method === 'POST',
    );
    expect(blobPost?.body).toBe(content);
    // …and /api/create referenced it under the file's basename.
    const create = mockServer.requests.find((r) => r.path === '/api/create');
    expect(create?.body).toEqual({
      model: 'headline-model',
      files: { [nodePath.basename(filePath)]: digest },
      stream: false,
    });
  });
});
