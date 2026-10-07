/**
 * Cross-runtime helpers with no Node.js API dependency, so they stay safe to import from
 * the core client bundle (see ADR 0006 — Edge Runtime CI).
 */

import { imageStringNeedsResolution, resolveImages, type VisionInput } from './vision.js';

/**
 * Encodes an image to a base64 string, matching the wire format Ollama's `/api/chat` and
 * `/api/generate` `images` arrays expect.
 *
 * - A `string` is assumed to already be base64-encoded and is returned unchanged. For
 *   data URIs, URLs, and local file paths use {@link resolveImageInput}, which this SDK's
 *   request pipeline applies automatically (see {@link withEncodedImages}).
 * - A `Uint8Array` (or Node `Buffer`) is base64-encoded using whichever universal primitive
 *   the runtime exposes: `Buffer` on Node.js, `btoa` on browsers/Edge runtimes. Chunked so it
 *   doesn't blow the engine's max call-stack/argument-count limits on large images.
 */
export async function encodeImage(image: VisionInput): Promise<string> {
  if (typeof image === 'string') return image;

  const bufferCtor = (
    globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } } }
  ).Buffer;
  if (bufferCtor !== undefined) return bufferCtor.from(image).toString('base64');

  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < image.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...image.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

async function encodeImages(
  images: readonly VisionInput[],
  signal?: AbortSignal | undefined,
): Promise<readonly string[]> {
  return resolveImages(images, signal) as Promise<readonly string[]>;
}

/**
 * Normalizes `req.images` to wire-ready raw base64 strings, resolving every polymorphic
 * {@link VisionInput} — data URIs (header stripped), `http(s)://` URLs (fetched), local
 * file paths (read via dynamically-imported `node:fs`, Node.js only), and raw
 * `Buffer`/`Uint8Array` bytes (base64-encoded). Returns `req` **unchanged (same reference)**
 * when every entry is already a plain base64 string (the common case), so the request
 * pipeline stays allocation-free for pre-encoded callers.
 */
export async function withEncodedImages<T extends { images?: readonly VisionInput[] | undefined }>(
  req: T,
  signal?: AbortSignal | undefined,
): Promise<T> {
  const needsResolution = req.images?.some(
    (image) => typeof image !== 'string' || imageStringNeedsResolution(image),
  );
  if (!needsResolution) return req;
  return { ...req, images: await encodeImages(req.images ?? [], signal) };
}

/**
 * Applies {@link withEncodedImages} to each message's `images` array. Returns `messages`
 * unchanged (same reference) if no message carries a non-base64-ready image.
 */
export async function withEncodedMessageImages<
  T extends { images?: readonly VisionInput[] | undefined },
>(messages: readonly T[], signal?: AbortSignal | undefined): Promise<readonly T[]> {
  const needsResolution = messages.some((message) =>
    message.images?.some((image) => typeof image !== 'string' || imageStringNeedsResolution(image)),
  );
  if (!needsResolution) return messages;
  return Promise.all(messages.map((message) => withEncodedImages(message, signal)));
}

// ─── Disposable helpers (TS 5.2+ `using` declarations) ──────────────────
//
// These wrappers turn cleanup operations into `Disposable` / `AsyncDisposable`
// values so callers can use `using` / `await using` declarations instead of
// try/finally blocks. This eliminates the "forgot to clean up in the finally
// block" bug class for timer, reader, and span lifecycles.

/** Wraps a `setTimeout` handle so `clearTimeout` runs at scope exit. */
export function disposableTimer(timer: ReturnType<typeof setTimeout>): Disposable {
  return {
    [Symbol.dispose]() {
      clearTimeout(timer);
    },
  };
}

/** Wraps a `ReadableStreamDefaultReader` so `cancel()` + `releaseLock()` run at scope exit. */
export function disposableReader<T>(reader: ReadableStreamDefaultReader<T>): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      try {
        await reader.cancel();
      } catch {
        /* stream may already be closed */
      }
      reader.releaseLock();
    },
  };
}

/** Wraps an OpenTelemetry span so `span.end()` runs at scope exit. */
export function disposableSpan(span: { end(): void }): Disposable {
  return {
    [Symbol.dispose]() {
      span.end();
    },
  };
}
