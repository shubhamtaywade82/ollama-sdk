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
 *      payload passed through (decoded size capped by `maxImageBytes`).
 *   2. `http://` / `https://` URLs — fetched with the configured fetch
 *      implementation (the client's own `fetch` by default, see
 *      {@link ImageResolutionPolicy.fetchImpl}), then base64-encoded. Remote
 *      resolution is governed by {@link ImageResolutionPolicy}: the response
 *      body is size-capped *while streaming*, every fetch has a timeout, and
 *      an SSRF guard rejects private/loopback/link-local targets — hostname
 *      allowlists and redirect hops included (redirects are followed manually
 *      on Node so each hop is re-validated; see ADR 0041 for the
 *      browser/edge caveat).
 *   3. Strings with a known image file extension (`.png`, `.jpg`, `.webp`,
 *      ...) — treated as a local file path and read via a *dynamically
 *      imported* `node:fs` (Node.js only), size-capped via `maxImageBytes`.
 *      A failed read throws `vision_path_read_failed` instead of silently
 *      shipping the raw path string to the server (which could only reject
 *      it — see ADR 0041). In browsers/edge runtimes, where `node:fs` does
 *      not exist, a path-shaped string throws a descriptive error instead of
 *      silently shipping garbage to the server.
 *   4. Anything else — assumed to already be raw base64 and passed through.
 *
 * `Buffer` and `Uint8Array` inputs are base64-encoded via the runtime's
 * universal base64 primitive (`Buffer` on Node, `btoa` on the web), matching
 * {@link encodeImage}. Direct byte inputs are *not* size-capped: the caller
 * already holds those bytes in memory, and the resolution cost is already
 * paid (see ADR 0041 for the threat model).
 *
 * Everything here is dependency-free and safe to import from the core client
 * bundle: the `node:fs` and `node:dns/promises` imports are dynamic and
 * guarded, so browser/edge builds never pull them in (see ADR 0006 — Edge
 * Runtime CI).
 */

import { OllamaAbortError, OllamaClientError } from './errors.js';

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

/**
 * Fetch signature accepted for remote image resolution. Deliberately a
 * structural subset of the global `fetch` (and of the client's configured
 * `fetch`), so either can be passed without adaptation.
 */
export type ImageFetchLike = (
  url: string,
  init?: { redirect?: 'manual' | 'follow'; signal?: AbortSignal } | undefined,
) => Promise<Response>;

/** One address-resolution result, mirroring `node:dns`' `LookupAddress` shape. */
export interface ImageAddress {
  readonly address: string;
  readonly family: number;
}

/**
 * Policy applied whenever a vision input needs resolution — URL fetches,
 * data-URI decoding, and local file reads. Set it once per client via
 * `OllamaClientConfig.imageResolution`, or per call through the lower-level
 * {@link resolveImages} / {@link resolveImageInput} signatures.
 *
 * Defaults are chosen so the common cases keep working while the failure
 * modes an untrusted input can trigger (oversized bodies, slow or looping
 * fetches, requests into private networks) fail closed with a clear error.
 * See ADR 0041 for the full rationale.
 */
export interface ImageResolutionPolicy {
  /**
   * Hard cap on the *decoded* image size, in bytes. Applies to remote fetch
   * bodies (enforced while streaming, before the body is buffered), to local
   * file reads (enforced via `stat` before the read), and to data-URI
   * payloads. Direct `Uint8Array`/`Buffer` inputs are not capped. Default:
   * 50 MiB.
   */
  readonly maxImageBytes?: number | undefined;
  /**
   * Timeout for the whole remote fetch — connection, redirects, and body
   * read combined. Default: 30 000 ms.
   */
  readonly fetchTimeoutMs?: number | undefined;
  /**
   * Maximum redirect hops followed for a remote image. Every hop is
   * re-validated against the host policy and the private-address guard (on
   * Node, where redirects are followed manually). Default: 5.
   */
  readonly maxRedirects?: number | undefined;
  /**
   * Allowlist of hosts remote images may be fetched from. Exact hostnames
   * (case-insensitive), `*.example.com` wildcards for subdomains, or `'*'`
   * for any host. `undefined` (default) allows any host — the
   * private-address guard still applies.
   */
  readonly allowedImageHosts?: readonly string[] | undefined;
  /**
   * Permit fetching remote images from private, loopback, link-local, or
   * otherwise reserved addresses (and from hostnames that resolve to them).
   * Default: `false` — the SSRF guard. Flip it to `true` only for clients
   * whose image URLs are trusted and genuinely live on a private network
   * (e.g. an internal image service in the same subnet as the app).
   */
  readonly allowPrivateNetworkAccess?: boolean | undefined;
  /**
   * Permit resolving local file paths (`/path/to.png`). Default: `true`
   * (the historical behavior). Set to `false` when image input is untrusted
   * and filesystem reads must not happen at all.
   */
  readonly allowLocalFileReads?: boolean | undefined;
  /**
   * Fetch implementation used for URL resolution. Defaults to the client's
   * configured `fetch` (and to the platform's global `fetch` when called
   * outside a client), so image fetches flow through whatever proxy, agent,
   * or mock the caller already installed. Bypassed never — the resolver
   * always uses this path, not a bare global, when resolving URLs.
   */
  readonly fetchImpl?: ImageFetchLike | undefined;
  /**
   * Address resolver used by the private-network guard for non-literal
   * hostnames. Defaults to `node:dns/promises` `lookup` on Node-like
   * runtimes and to a hostname-heuristics-only check elsewhere (browsers and
   * edge runtimes have no DNS API — see ADR 0041). Injectable so callers can
   * resolve through DoH, a cache, or a test double.
   */
  readonly addressLookup?:
    ((hostname: string) => Promise<readonly ImageAddress[]>) | undefined | undefined;
}

/** Default `maxImageBytes` (50 MiB) — see {@link ImageResolutionPolicy}. */
const DEFAULT_MAX_IMAGE_BYTES = 50 * 1024 * 1024;
/** Default `fetchTimeoutMs` (30 s) — see {@link ImageResolutionPolicy}. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/** Default `maxRedirects` (5) — see {@link ImageResolutionPolicy}. */
const DEFAULT_MAX_REDIRECTS = 5;

interface ResolvedImagePolicy {
  readonly maxImageBytes: number;
  readonly fetchTimeoutMs: number;
  readonly maxRedirects: number;
  readonly allowedHosts: readonly string[] | undefined;
  readonly allowPrivateNetworkAccess: boolean;
  readonly allowLocalFileReads: boolean;
  readonly fetchImpl: ImageFetchLike;
  readonly addressLookup:
    ((hostname: string) => Promise<readonly ImageAddress[] | undefined>) | undefined;
}

function resolveImagePolicy(policy: ImageResolutionPolicy | undefined): ResolvedImagePolicy {
  const p = policy ?? {};
  const fetchImpl = p.fetchImpl ?? (globalThis.fetch as ImageFetchLike | undefined);
  if (fetchImpl === undefined) {
    throw new OllamaClientError(
      'No fetch implementation available to resolve image URLs: this runtime has no global ' +
        '`fetch`. Pass `imageResolution.fetchImpl` (or construct the client with `fetch`).',
      { code: 'image_fetch_unavailable' },
    );
  }
  return {
    maxImageBytes: p.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    fetchTimeoutMs: p.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    maxRedirects: p.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    allowedHosts: p.allowedImageHosts,
    allowPrivateNetworkAccess: p.allowPrivateNetworkAccess ?? false,
    allowLocalFileReads: p.allowLocalFileReads ?? true,
    fetchImpl,
    addressLookup: p.addressLookup ?? nodeDnsLookup,
  };
}

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

/** HTTP statuses whose responses redirect and carry a `Location` header. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

/** True when the current runtime has Node.js APIs available (Node/Bun, not browser/edge). */
function hasNodeApis(): boolean {
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
 * `hasNodeApis()` guard, so edge bundles carry it as dead code. Same trick
 * below for `node:dns/promises`.
 */
const NODE_FS_MODULE = 'node:fs';
const NODE_DNS_MODULE = 'node:dns/promises';

/** Defensive header read — mock `Response` objects may degrade. */
function readHeader(res: Response, name: string): string | null {
  try {
    return typeof res.headers?.get === 'function' ? res.headers.get(name) : null;
  } catch {
    return null;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

// ─── Private-address classification (the SSRF guard's core) ────────────────

/** Parses a strict dotted-quad IPv4 literal; `undefined` for anything else. */
function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  const [a = -1, b = -1, c = -1, d = -1] = octets;
  return [a, b, c, d];
}

/**
 * IPv4 ranges refused by the SSRF guard: loopback, private, CGNAT,
 * link-local, benchmarking, documentation (TEST-NET), multicast, reserved,
 * broadcast, and the all-zero network. Anything a real public image host can
 * never live in — deliberately fail-closed.
 */
function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (CGNAT)
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && (b === 168 || b === 0 || b === 2)) return true; // 192.168/16, 192.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Parses an IPv6 literal (including `::` compression and embedded IPv4 tails). */
function parseIpv6(host: string): bigint | undefined {
  let text = host;
  const embedded = text.match(/^(.*)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded !== null) {
    const v4 = parseIpv4(embedded[2] ?? '');
    if (v4 === undefined) return undefined;
    const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    text = `${embedded[1] ?? ''}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : [];
  const groups = [...head, ...tail];
  const missing = 8 - groups.length;
  if (halves.length === 2 ? missing < 0 : groups.length !== 8) return undefined;
  const full =
    halves.length === 2 ? [...head, ...new Array<string>(missing).fill('0'), ...tail] : groups;
  let value = 0n;
  for (const group of full) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** IPv6 ranges refused by the SSRF guard — mirrors {@link isPrivateIpv4}. */
function isPrivateIpv6(value: bigint): boolean {
  if (value === 0n || value === 1n) return true; // :: (unspecified), ::1 (loopback)
  const topByte = (value >> 120n) & 0xffn;
  if (topByte >= 0xfcn && topByte <= 0xfdn) return true; // fc00::/7 ULA
  if (topByte === 0xfen) return true; // fe80::/10 link-local (+ deprecated site-local)
  if (topByte === 0xffn) return true; // ff00::/8 multicast
  // ::ffff:0:0/96 — IPv4-mapped: classify by the embedded IPv4 address.
  if (value >> 32n === 0xffffn) {
    return isPrivateIpv4(ipv4FromBits(value & 0xffffffffn));
  }
  // 64:ff9b::/96 — NAT64: classify by the embedded IPv4 address.
  if (value >> 96n === 0x64ff9bn) {
    return isPrivateIpv4(ipv4FromBits(value & 0xffffffffn));
  }
  // 2001:db8::/32 — documentation range.
  if (value >> 96n === 0x20010db8n) return true;
  return false;
}

function ipv4FromBits(bits: bigint): [number, number, number, number] {
  const a = Number((bits >> 24n) & 0xffn);
  const b = Number((bits >> 16n) & 0xffn);
  const c = Number((bits >> 8n) & 0xffn);
  const d = Number(bits & 0xffn);
  return [a, b, c, d];
}

/**
 * Synchronous private-hostname classification: `localhost`-style names, IPv4
 * and IPv6 literals, and digit-and-dot strings that are not strict IPv4
 * (partial/hex forms some resolvers coerce — fail closed). Hostnames needing
 * DNS are classified by {@link resolvesToPrivateAddress}.
 */
function hostnameIsPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.home.arpa')
  ) {
    return true;
  }
  const v4 = parseIpv4(h);
  if (v4 !== undefined) return isPrivateIpv4(v4);
  if (/^[\d.]+$/.test(h)) return true; // numeric-but-malformed: fail closed
  const v6Host = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  const v6 = parseIpv6(v6Host);
  if (v6 !== undefined) return isPrivateIpv6(v6);
  return false;
}

/**
 * Default address resolver: `node:dns/promises` `lookup` on Node-like
 * runtimes, `undefined` (heuristic-only guard) in browsers/edge.
 */
async function nodeDnsLookup(hostname: string): Promise<readonly ImageAddress[] | undefined> {
  if (!hasNodeApis()) return undefined;
  const dns = (await import(NODE_DNS_MODULE)) as typeof import('node:dns/promises');
  return dns.lookup(hostname, { all: true });
}

/** True when the hostname resolves (or literally is) a private address. */
async function resolvesToPrivateAddress(
  hostname: string,
  lookup: ((hostname: string) => Promise<readonly ImageAddress[] | undefined>) | undefined,
): Promise<boolean> {
  if (hostnameIsPrivate(hostname)) return true;
  if (lookup === undefined) return false;
  try {
    const addresses = await lookup(hostname);
    if (addresses === undefined) return false;
    return addresses.some((entry) => hostnameIsPrivate(entry.address));
  } catch {
    // DNS failure is not evidence of a private address — the fetch itself
    // will surface that error instead.
    return false;
  }
}

// ─── URL policy checks ─────────────────────────────────────────────────────

function assertHostAllowed(url: URL, allowedHosts: readonly string[] | undefined): void {
  if (allowedHosts === undefined) return;
  const hostname = url.hostname.toLowerCase();
  for (const allowed of allowedHosts) {
    const entry = allowed.toLowerCase();
    if (entry === '*' || entry === hostname) return;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // '.example.com'
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) return;
    }
  }
  throw new OllamaClientError(
    `Image host "${url.hostname}" is not in allowedImageHosts ` +
      `(${allowedHosts.join(', ')}). Add the host, or clear the allowlist to permit any host.`,
    { code: 'image_host_not_allowed' },
  );
}

function privateAddressError(target: string, url: URL): OllamaClientError {
  return new OllamaClientError(
    `Refusing to fetch image from private/reserved network address "${target}" ` +
      `("${url.toString()}"). This default blocks SSRF when image URLs come from untrusted ` +
      `input. If this fetch is intentional and the host is genuinely yours, set ` +
      `'imageResolution.allowPrivateNetworkAccess: true'.`,
    { code: 'image_private_address_blocked' },
  );
}

async function assertFetchableUrl(url: URL, policy: ResolvedImagePolicy): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OllamaClientError(
      `Image URL protocol must be http or https, got "${url.protocol}" for "${url.toString()}".`,
      { code: 'image_unsupported_protocol' },
    );
  }
  assertHostAllowed(url, policy.allowedHosts);
  if (!policy.allowPrivateNetworkAccess) {
    if (hostnameIsPrivate(url.hostname)) throw privateAddressError(url.hostname, url);
    if (await resolvesToPrivateAddress(url.hostname, policy.addressLookup)) {
      throw privateAddressError(url.hostname, url);
    }
  }
}

// ─── Remote fetch with streaming size cap, timeout, and manual redirects ──

/**
 * Reads a response body with the byte cap enforced *while streaming* — the
 * oversize error fires as soon as the limit is crossed, and the reader is
 * cancelled so the download actually stops. Falls back to `arrayBuffer()` +
 * a post-hoc length check only for exotic responses without a stream body.
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  source: string,
): Promise<Uint8Array> {
  const body = res.body;
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        if (value === undefined || value === null) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new OllamaClientError(
            `Image from "${source}" exceeds the ${maxBytes}-byte maxImageBytes limit ` +
              `(at least ${total} bytes received so far). Raise 'imageResolution.maxImageBytes' ` +
              `if images this large are expected.`,
            { code: 'image_too_large' },
          );
        }
        chunks.push(value);
      }
    } finally {
      // No-op on an exhausted stream; aborts the download on the error path.
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  const buffered = new Uint8Array(await res.arrayBuffer());
  if (buffered.byteLength > maxBytes) {
    throw new OllamaClientError(
      `Image from "${source}" exceeds the ${maxBytes}-byte maxImageBytes limit ` +
        `(${buffered.byteLength} bytes). Raise 'imageResolution.maxImageBytes' if images this ` +
        `large are expected.`,
      { code: 'image_too_large' },
    );
  }
  return buffered;
}

async function fetchUrlAsBase64(
  urlString: string,
  callerSignal: AbortSignal | undefined,
  policy: ResolvedImagePolicy,
): Promise<string> {
  // Node-like runtimes follow redirects manually so every hop is re-validated
  // against the host policy and the SSRF guard. Browser/edge fetch cannot do
  // this (`redirect: 'manual'` yields an opaque response there), so the engine
  // follows redirects itself and only the initial URL is validated — see
  // ADR 0041.
  const manualRedirects = hasNodeApis();
  const controller = new AbortController();
  let timedOut = false;
  const followCallerAbort = (): void => {
    controller.abort();
  };
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', followCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, policy.fetchTimeoutMs);
  const cleanup = (): void => {
    clearTimeout(timer);
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener('abort', followCallerAbort);
    }
  };
  try {
    let current = new URL(urlString);
    for (let redirects = 0; ; redirects++) {
      await assertFetchableUrl(current, policy);
      const res = await policy.fetchImpl(current.toString(), {
        redirect: manualRedirects ? 'manual' : 'follow',
        signal: controller.signal,
      });
      if (manualRedirects && REDIRECT_STATUSES.has(res.status)) {
        const location = readHeader(res, 'location');
        if (location === null || location === '') {
          throw new OllamaClientError(
            `Failed to fetch image from URL "${current.toString()}": HTTP ${res.status} ` +
              `${res.statusText} without a Location header.`,
            { code: 'image_fetch_failed', status: res.status },
          );
        }
        if (redirects >= policy.maxRedirects) {
          throw new OllamaClientError(
            `Image fetch from "${urlString}" exceeded maxRedirects (${policy.maxRedirects}).`,
            { code: 'image_redirect_limit' },
          );
        }
        current = new URL(location, current);
        continue;
      }
      if (!res.ok) {
        throw new OllamaClientError(
          `Failed to fetch image from URL "${current.toString()}": HTTP ${res.status} ` +
            `${res.statusText}.`,
          { code: 'image_fetch_failed', status: res.status },
        );
      }
      const bytes = await readBodyCapped(res, policy.maxImageBytes, current.toString());
      return encodeBytesBase64(bytes);
    }
  } catch (err) {
    if (err instanceof OllamaClientError) throw err;
    if (controller.signal.aborted) {
      if (timedOut) {
        throw new OllamaClientError(
          `Image fetch from URL "${urlString}" timed out after ${policy.fetchTimeoutMs} ms. ` +
            `Raise 'imageResolution.fetchTimeoutMs' if the source is legitimately slow.`,
          { code: 'image_fetch_timeout', cause: toError(err) },
        );
      }
      if (callerSignal?.aborted === true) {
        throw new OllamaAbortError(
          `Image fetch from URL "${urlString}" was aborted by the request signal.`,
          { cause: toError(err) },
        );
      }
    }
    throw new OllamaClientError(
      `Failed to fetch image from URL "${urlString}": ${errorMessage(err)}.`,
      { code: 'image_fetch_failed', cause: toError(err) },
    );
  } finally {
    cleanup();
  }
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

/** Decoded-byte estimate of a base64 payload (whitespace- and padding-aware). */
function estimateBase64Bytes(payload: string): number {
  const compact = payload.replace(/\s+/g, '');
  let padding = 0;
  if (compact.endsWith('===')) padding = 3;
  else if (compact.endsWith('==')) padding = 2;
  else if (compact.endsWith('=')) padding = 1;
  return Math.floor((compact.length * 3) / 4) - padding;
}

/**
 * Reads a local file as base64 with the byte cap enforced via `stat` before
 * the read (and re-checked after — TOCTOU is unlikely but cheap to cover).
 * The `node:fs` import is dynamic so that bundlers exclude it from
 * browser/edge builds; the function is only ever called after a
 * `hasNodeApis()` guard.
 */
async function readFileAsBase64(path: string, maxBytes: number): Promise<string> {
  const { promises: fs } = (await import(NODE_FS_MODULE)) as typeof import('node:fs');
  const stat = await fs.stat(path);
  if (!stat.isFile()) {
    throw new OllamaClientError(`Vision input "${path}" is not a regular file.`, {
      code: 'vision_path_read_failed',
    });
  }
  if (stat.size > maxBytes) {
    throw new OllamaClientError(
      `Image file "${path}" (${stat.size} bytes) exceeds the ${maxBytes}-byte maxImageBytes ` +
        `limit. Raise 'imageResolution.maxImageBytes' if images this large are expected.`,
      { code: 'image_too_large' },
    );
  }
  const data = await fs.readFile(path);
  if (data.byteLength > maxBytes) {
    throw new OllamaClientError(
      `Image file "${path}" (${data.byteLength} bytes) exceeds the ${maxBytes}-byte ` +
        `maxImageBytes limit.`,
      { code: 'image_too_large' },
    );
  }
  return data.toString('base64');
}

/**
 * Resolves any supported vision input into the raw base64 string Ollama's
 * REST API expects — no data-URI headers, no URL/path indirection left
 * behind. See the module doc for the full resolution order and
 * {@link ImageResolutionPolicy} for the trust-boundary and resource-limit
 * knobs.
 *
 * @throws {OllamaClientError} if a URL fetch fails (non-2xx, timeout,
 * oversize, redirect limit, host not allowed, private address blocked, or
 * unsupported protocol), if a local file read fails, is disabled, or is
 * oversize, or if a path-shaped string is passed in a runtime without
 * `node:fs` (browser/edge) — in that environment, read the file yourself and
 * pass the bytes.
 */
export async function resolveImageInput(
  input: VisionInput,
  signal?: AbortSignal | undefined,
  policy?: ImageResolutionPolicy | undefined,
): Promise<string> {
  if (typeof input !== 'string') {
    return encodeBytesBase64(input instanceof Uint8Array ? input : new Uint8Array(input));
  }

  const resolved = resolveImagePolicy(policy);

  // 1. Data URI: strip the `data:image/...;base64,` header, cap the payload.
  if (DATA_URI_PATTERN.test(input)) {
    const payload = input.replace(DATA_URI_PATTERN, '').trim();
    const estimated = estimateBase64Bytes(payload);
    if (estimated > resolved.maxImageBytes) {
      throw new OllamaClientError(
        `Data-URI image payload (~${estimated} bytes decoded) exceeds the ` +
          `${resolved.maxImageBytes}-byte maxImageBytes limit. Raise ` +
          `'imageResolution.maxImageBytes' if images this large are expected.`,
        { code: 'image_too_large' },
      );
    }
    return payload;
  }

  // 2. HTTP(S) URL: fetch (with policy) and encode.
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return fetchUrlAsBase64(input, signal, resolved);
  }

  // 3. Local file path: read and encode (Node.js only — dynamic import).
  if (IMAGE_FILE_EXTENSION_PATTERN.test(input)) {
    if (!hasNodeApis()) {
      throw new OllamaClientError(
        `Vision input "${input}" looks like a local file path, but this runtime has no ` +
          `Node.js \`fs\` module (browser/edge). Read the file into bytes yourself and pass ` +
          `the \`Uint8Array\`, or pass a base64 string / data URI / http(s) URL instead.`,
        { code: 'vision_path_unsupported_runtime' },
      );
    }
    if (!resolved.allowLocalFileReads) {
      throw new OllamaClientError(
        `Vision input "${input}" looks like a local file path, but local file reads are ` +
          `disabled ('imageResolution.allowLocalFileReads: false'). Pass a \`Uint8Array\`, ` +
          `a base64 string, a data URI, or an http(s) URL instead.`,
        { code: 'vision_local_reads_disabled' },
      );
    }
    try {
      return await readFileAsBase64(input, resolved.maxImageBytes);
    } catch (err) {
      if (err instanceof OllamaClientError) throw err;
      // A failed read used to fall through and ship the raw path string to
      // the server (which can only reject it as invalid base64). Throw
      // instead — the extension-matched string cannot be valid base64 anyway
      // (the base64 alphabet has no '.'), so there was never a real fallback
      // case to preserve. See ADR 0041.
      throw new OllamaClientError(
        `Failed to read vision input file "${input}": ${errorMessage(err)}. Pass the file's ` +
          `bytes as \`Uint8Array\`, a base64 string, or a data URI instead.`,
        { code: 'vision_path_read_failed', cause: toError(err) },
      );
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
  policy?: ImageResolutionPolicy | undefined,
): Promise<readonly string[] | undefined> {
  if (images === undefined) return undefined;
  if (images.every((image) => typeof image === 'string' && !imageStringNeedsResolution(image))) {
    return images as readonly string[];
  }
  return Promise.all(images.map((image) => resolveImageInput(image, signal, policy)));
}
