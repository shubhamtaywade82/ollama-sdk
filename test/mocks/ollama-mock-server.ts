/**
 * In-memory Ollama mock server for deterministic CI testing.
 *
 * The SDK already has a VCR (cassette) system at `test/vcr.ts` that
 * replays recorded HTTP interactions. But cassettes are static —
 * they can't simulate:
 *
 *   - programmable inter-chunk delays (to test backpressure)
 *   - mid-stream error injection (to test in-band error trapping)
 *   - chunk fragmentation (split a single NDJSON frame across
 *     multiple TCP packets, exposing parser buffering bugs)
 *   - split-packet UTF-8 (a multi-byte char split across packets)
 *   - 503/502/429 error status codes with custom bodies
 *   - connection drops mid-stream
 *
 * This mock server fills that gap. It's a thin `node:http` wrapper
 * that lets tests register route handlers with programmable delay,
 * chunk fragmentation, and error injection — all without touching
 * the network or requiring a live Ollama daemon.
 *
 * ## Usage
 *
 *   ```ts
 *   import { OllamaMockServer } from './mocks/ollama-mock-server.js';
 *
 *   const server = new OllamaMockServer(0); // 0 = ephemeral port
 *   await server.start();
 *
 *   server.register('/api/chat', {
 *     status: 200,
 *     chunks: [
 *       JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'Hel' }, done: false }),
 *       JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'lo' }, done: true }),
 *     ],
 *     chunkDelayMs: 50,
 *   });
 *
 *   const client = new OllamaClient({ baseUrl: server.baseUrl });
 *   // ... test against the mock ...
 *
 *   await server.stop();
 *   ```
 *
 * The server is designed for Vitest (or Jest) — `start()` returns
 * a promise that resolves once the server is listening, and `stop()`
 * returns a promise that resolves once the server is fully closed.
 * Use `beforeEach`/`afterEach` hooks to manage the lifecycle.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A single mock route handler. The server matches on the request
 * path (no query string matching — Ollama's API doesn't use query
 * params for the routes we care about).
 *
 * All fields optional except `chunks` (which defaults to `[]` —
 * useful for testing the "stream closed without any data" case).
 */
export interface MockEndpointOptions {
  /** HTTP status code. Defaults to 200. */
  readonly status?: number | undefined;
  /**
   * NDJSON chunks to emit, in order. Each chunk is emitted as a
   * separate `res.write()` call followed by `\n`. Pass `[]` to emit
   * no body (useful for testing the "stream closed without data"
   * case).
   */
  readonly chunks?: readonly string[] | undefined;
  /**
   * Delay (ms) before emitting each chunk. Defaults to 0 (no delay).
   * Set to a small value (5-50ms) to test backpressure handling;
   * set to a large value (10_000ms) to test timeout/cancellation.
   */
  readonly chunkDelayMs?: number | undefined;
  /**
   * Custom response headers. Defaults to
   * `{ 'content-type': 'application/x-ndjson' }` for streaming
   * endpoints. Override for non-JSON responses (e.g. blob uploads).
   */
  readonly headers?: Record<string, string> | undefined;
  /**
   * When `true`, the server closes the connection mid-stream after
   * emitting the first chunk. Use this to test connection-drop
   * recovery. Defaults to `false`.
   */
  readonly dropConnectionMidStream?: boolean | undefined;
  /**
   * Optional callback fired when a request arrives at this route.
   * Receives the parsed request body (or `undefined` if the body
   * wasn't valid JSON). Useful for assertions like
   * "the client sent the right `model` field".
   */
  readonly onRequest?: (body: unknown) => void | undefined;
}

/**
 * Lightweight in-memory Ollama mock server.
 *
 * Spawns a real `node:http` server on a free port (or a fixed port
 * if you pass one). Tests register route handlers via `register()`,
 * then point an `OllamaClient` at `server.baseUrl`. The server
 * emits the registered chunks with the configured delay, status,
 * and connection behavior.
 *
 * The server is **single-process** — it doesn't fork or use
 * workers. It's intended for unit/integration tests, not load
 * testing. For load testing, use a real Ollama instance or a
 * dedicated HTTP load-test tool.
 */
export class OllamaMockServer {
  private readonly server: Server;
  private readonly routes = new Map<string, MockEndpointOptions>();
  private port: number;

  /**
   * @param port TCP port to listen on. Pass `0` for an ephemeral
   *        port (recommended for parallel test runs — avoids
   *        port-already-in-use races). The actual port is exposed
   *        via {@link baseUrl} after {@link start}.
   */
  constructor(port = 0) {
    this.port = port;
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    // Disable Nagle's algorithm so chunks are emitted immediately
    // rather than being coalesced — this makes the chunk-fragmentation
    // tests actually test fragmentation.
    this.server.on('connection', (socket) => {
      socket.setNoDelay(true);
    });
  }

  /**
   * Register a route handler. Replaces any existing handler for
   * the same path.
   *
   * The path is matched against `req.url` exactly (no query string
   * matching). For path-parameter routes like `/api/blobs/{digest}`,
   * the test must register each specific digest value separately —
   * the mock doesn't do template matching.
   */
  register(path: string, options: MockEndpointOptions): void {
    this.routes.set(path, options);
  }

  /**
   * Clear all registered routes. Useful in `beforeEach` hooks to
   * reset state between tests.
   */
  clear(): void {
    this.routes.clear();
  }

  /**
   * Returns the base URL the test should point an `OllamaClient` at.
   * Only valid after {@link start} has resolved.
   */
  get baseUrl(): string {
    const address = this.server.address() as AddressInfo | null;
    const port = address?.port ?? this.port;
    return `http://127.0.0.1:${port}`;
  }

  /**
   * Start listening. Resolves once the server is ready to accept
   * connections.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        const address = this.server.address() as AddressInfo | null;
        if (address !== null) {
          this.port = address.port;
        }
        resolve();
      });
    });
  }

  /**
   * Stop listening and close all active connections. Resolves once
   * the server is fully closed (no lingering sockets). Idempotent —
   * calling `stop()` on an already-stopped server resolves cleanly
   * rather than throwing `ERR_SERVER_NOT_RUNNING`.
   */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // `server.close()` errors with ERR_SERVER_NOT_RUNNING if the
      // server isn't currently listening. Treat that as a successful
      // no-op so callers can use stop() in afterEach hooks without
      // tracking whether start() was actually called.
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    // Strip query string for route matching — Ollama's API doesn't
    // use query params for the routes we care about, and stripping
    // makes the test setup simpler.
    const path = url.split('?')[0] ?? '/';
    const route = this.routes.get(path);

    // Capture the request body for the route's onRequest callback.
    let parsedBody: unknown;
    if (req.method === 'POST' || req.method === 'PUT') {
      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk as Buffer);
      }
      const bodyText = Buffer.concat(bodyChunks).toString('utf-8');
      if (bodyText) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          parsedBody = bodyText;
        }
      }
    }

    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Route not mocked: ${path}` }));
      return;
    }

    route.onRequest?.(parsedBody);

    const status = route.status ?? 200;
    const chunks = route.chunks ?? [];
    const chunkDelayMs = route.chunkDelayMs ?? 0;
    const headers = route.headers ?? { 'content-type': 'application/x-ndjson' };

    res.writeHead(status, headers);

    if (route.dropConnectionMidStream) {
      // Emit the first chunk (if any), then destroy the socket
      // without ending the response. This simulates a network
      // drop mid-stream.
      if (chunks.length > 0) {
        if (chunkDelayMs > 0) {
          await new Promise((r) => setTimeout(r, chunkDelayMs));
        }
        res.write(chunks[0] + '\n');
      }
      res.socket?.destroy();
      return;
    }

    for (const chunk of chunks) {
      if (chunkDelayMs > 0) {
        await new Promise((r) => setTimeout(r, chunkDelayMs));
      }
      res.write(chunk + '\n');
    }
    res.end();
  }
}
