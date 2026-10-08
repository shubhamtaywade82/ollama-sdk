/**
 * Universal vision asset resolution — the SDK-side half of Ollama's documented
 * vision ingestion convention.
 *
 * Ollama's REST API strictly requires raw base64 strings in the `images`
 * arrays of `/api/chat` and `/api/generate` (no `data:image/...;base64,` URI
 * prefixes). The official SDKs, however, are expected to accept polymorphic
 * image sources — local file paths, web URLs, or raw byte buffers — and
 * normalize them to that wire format on the caller's behalf. This module is
 * that normalization layer for this SDK.
 *
 * Resolution order for `string` inputs:
 *
 *   1. `data:image/...;base64,` data URIs — the header is stripped, the
 *      payload passed through.
 *   2. `http://` / `https://` URLs — fetched with the platform's global
 *      `fetch`, then base64-encoded.
 *   3. Strings with a known image file extension (`.png`, `.jpg`, `.webp`,
 *      ...) — treated as a local file path and read via a *dynamically
 *      imported* `node:fs` (Node.js only). If the read fails, the string is
 *      passed through unchanged (it may have been a base64 payload that
 *      happened to end in an image-like suffix — rare, but the safe
 *      fallback). In browsers/edge runtimes, where `node:fs` does not exist,
 *      a path-shaped string throws a descriptive error instead of silently
 *      shipping garbage to the server.
 *   4. Anything else — assumed to already be raw base64 and passed through.
 *
 * `Buffer` and `Uint8Array` inputs are base64-encoded via the runtime's
 * universal base64 primitive (`Buffer` on Node, `btoa` on the web), matching
 * {@link encodeImage}.
 *
 * Everything here is dependency-free and safe to import from the core client
 * bundle: the `node:fs` import is dynamic and guarded, so browser/edge builds
 * never pull it in (see ADR 0006 — Edge Runtime CI).
 */

import { OllamaClientError } from './errors.js';

/**
 * Polymorphic vision input accepted anywhere this SDK takes an `images` entry.
 *
 * - `string` — a raw base64 payload, a `data:image/...;base64,` data URI, an
 *   `http(s)://` URL, or (on Node.js) a local file path.
 * - `Uint8Array` — raw image bytes, base64-encoded automatically. Node
 *   `Buffer` is a `Uint8Array` subclass, so buffers are accepted everywhere
 *   bytes are — without importing Node types into consumer compilations: the
 *   published declarations stay free of `@types/node` globals (audit TYP-03).
 */
export type VisionInput = string | Uint8Array;

/** Data-URI prefix, e.g. `data:image/png;base64,`. Case-insensitive on the MIME type. */
const DATA_URI_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * Known image file extensions. A string ending in one of these (and only
 * these — a plain base64 payload cannot contain a `.` before the suffix) is
 * treated as a local file path candidate. This is deliberately narrower than
 * "contains a slash", because `/` is a legal base64 alphabet character and a
 * naive contains-slash heuristic would misfire on ~any longer payload.
 */
const IMAGE_FILE_EXTENSION_PATTERN = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;

/**
 * Cheap synchronous check: does this string input require async resolution
 * (data-URI stripping, URL fetch, or file read), or is it already wire-ready
 * base64? Used to keep the hot path in `withEncodedImages` allocation-free
 * when callers pass pre-encoded strings (the overwhelmingly common case).
 */
export function imageStringNeedsResolution(input: string): boolean {
  return (
    DATA_URI_PATTERN.test(input) ||
    input.startsWith('http://') ||
    input.startsWith('https://') ||
    IMAGE_FILE_EXTENSION_PATTERN.test(input)
  );
}

/** True when the current runtime has Node.js `fs` available (Node/Bun, not browser/edge). */
function hasNodeFs(): boolean {
  return (
    typeof process !== 'undefined' &&
    process !== null &&
    typeof (process as { versions?: { node?: string } }).versions?.node === 'string'
  );
}

/**
 * `node:fs` module specifier, kept behind a variable so bundlers can't see
 * it as a literal — esbuild's browser/edge platform (and Cloudflare's and
 * Vercel's own build pipelines) refuse to resolve Node builtins at build
 * time. The dynamic import only ever executes at call time, and only after a
 * `hasNodeFs()` guard, so edge bundles carry it as dead code.
 */
const NODE_FS_MODULE = 'node:fs';

/**
 * Reads a local file as base64. The `node:fs` import is dynamic so that
 * bundlers exclude it from browser/edge builds; the function is only ever
 * called after a `hasNodeFs()` guard.
 */
async function readFileAsBase64(path: string): Promise<string> {
  const { promises: fs } = (await import(NODE_FS_MODULE)) as typeof import('node:fs');
  const data = await fs.readFile(path);
  return data.toString('base64');
}

async function fetchUrlAsBase64(url: string, signal?: AbortSignal | undefined): Promise<string> {
  const res = await fetch(url, signal !== undefined ? { signal } : undefined);
  if (!res.ok) {
    throw new OllamaClientError(
      `Failed to fetch image from URL "${url}": HTTP ${res.status} ${res.statusText}.`,
      { code: 'image_fetch_failed' },
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  return encodeBytesBase64(new Uint8Array(arrayBuffer));
}

/** Base64-encodes bytes using whichever universal primitive the runtime exposes. */
function encodeBytesBase64(bytes: Uint8Array): string {
  const bufferCtor = (
    globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } } }
  ).Buffer;
  if (bufferCtor !== undefined) return bufferCtor.from(bytes).toString('base64');

  // Web/edge path — chunked so large images don't blow the engine's
  // max call-stack/argument-count limit on String.fromCharCode.
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Resolves any supported vision input into the raw base64 string Ollama's
 * REST API expects — no data-URI headers, no URL/path indirection left
 * behind. See the module doc for the full resolution order.
 *
 * @throws {OllamaClientError} if a URL fetch fails (non-2xx), or if a
 * path-shaped string is passed in a runtime without `node:fs` (browser/edge)
 * — in that environment, read the file yourself and pass the bytes.
 */
export async function resolveImageInput(
  input: VisionInput,
  signal?: AbortSignal | undefined,
): Promise<string> {
  if (typeof input !== 'string') {
    return encodeBytesBase64(input instanceof Uint8Array ? input : new Uint8Array(input));
  }

  // 1. Data URI: strip the `data:image/...;base64,` header.
  if (DATA_URI_PATTERN.test(input)) {
    return input.replace(DATA_URI_PATTERN, '').trim();
  }

  // 2. HTTP(S) URL: fetch and encode.
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return fetchUrlAsBase64(input, signal);
  }

  // 3. Local file path: read and encode (Node.js only — dynamic import).
  if (IMAGE_FILE_EXTENSION_PATTERN.test(input)) {
    if (!hasNodeFs()) {
      throw new OllamaClientError(
        `Vision input "${input}" looks like a local file path, but this runtime has no ` +
          `Node.js \`fs\` module (browser/edge). Read the file into bytes yourself and pass ` +
          `the \`Uint8Array\`, or pass a base64 string / data URI / http(s) URL instead.`,
        { code: 'vision_path_unsupported_runtime' },
      );
    }
    try {
      return await readFileAsBase64(input);
    } catch {
      // Fall through: the string may have been a base64 payload that merely
      // ended in an image-like suffix. Pass it through untouched (digest's
      // documented graceful fallback) — if it really was a path, the server
      // will reject the invalid base64 with a clear error.
      return input;
    }
  }

  // 4. Anything else: assume raw base64.
  return input.trim();
}

/**
 * Resolves a whole `images` array in parallel. Returns the same array
 * reference (not a copy) when every entry is already wire-ready — the common
 * pre-encoded case — so callers on the hot path pay zero allocation cost.
 */
export async function resolveImages(
  images: readonly VisionInput[] | undefined,
  signal?: AbortSignal | undefined,
): Promise<readonly string[] | undefined> {
  if (images === undefined) return undefined;
  if (images.every((image) => typeof image === 'string' && !imageStringNeedsResolution(image))) {
    return images as readonly string[];
  }
  return Promise.all(images.map((image) => resolveImageInput(image, signal)));
}
