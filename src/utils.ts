/**
 * Cross-runtime helpers with no Node.js API dependency, so they stay safe to import from
 * the core client bundle (see ADR 0006 — Edge Runtime CI).
 */

/**
 * Encodes an image to a base64 string, matching the wire format Ollama's `/api/chat` and
 * `/api/generate` `images` arrays expect.
 *
 * - A `string` is assumed to already be base64-encoded and is returned unchanged.
 * - A `Uint8Array` is base64-encoded using whichever universal primitive the runtime
 *   exposes: `Buffer` on Node.js, `btoa` on browsers/Edge runtimes. Chunked so it doesn't
 *   blow the engine's max call-stack/argument-count limits on large images.
 */
export async function encodeImage(image: Uint8Array | string): Promise<string> {
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
  images: readonly (string | Uint8Array)[] | undefined,
): Promise<readonly string[] | undefined> {
  if (images === undefined) return undefined;
  return Promise.all(images.map((image) => encodeImage(image)));
}

/**
 * Returns `req` unchanged if `req.images` has no `Uint8Array` entries (the common case),
 * otherwise a shallow copy with `images` base64-encoded. Keeps `chat`/`generate` request
 * bodies wire-compatible without requiring callers to pre-encode raw image bytes.
 */
export async function withEncodedImages<
  T extends { images?: readonly (string | Uint8Array)[] | undefined },
>(req: T): Promise<T> {
  if (!req.images?.some((image) => image instanceof Uint8Array)) return req;
  return { ...req, images: await encodeImages(req.images) };
}

/**
 * Applies {@link withEncodedImages} to each message's `images` array. Returns `messages`
 * unchanged (same reference) if no message carries a `Uint8Array` image.
 */
export async function withEncodedMessageImages<
  T extends { images?: readonly (string | Uint8Array)[] | undefined },
>(messages: readonly T[]): Promise<readonly T[]> {
  if (!messages.some((message) => message.images?.some((image) => image instanceof Uint8Array)))
    return messages;
  return Promise.all(messages.map((message) => withEncodedImages(message)));
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
