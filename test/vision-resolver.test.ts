import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import {
  imageStringNeedsResolution,
  resolveImageInput,
  resolveImages,
  type ImageAddress,
  type ImageFetchLike,
} from '../src/vision.js';

/**
 * Universal vision asset resolution (src/vision.ts) — the SDK-side half of
 * Ollama's vision ingestion convention: SDKs accept polymorphic image
 * sources; the REST API strictly requires raw base64 strings.
 *
 * The remote-resolution tests never touch the network: they inject a
 * `fetchImpl` (and, where a hostname needs resolving, an `addressLookup`)
 * through `ImageResolutionPolicy`, and use IP-literal hosts so the
 * private-address guard classifies synchronously without DNS.
 */

let tempDir: string | undefined;

afterAll(async () => {
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
});

async function tempFile(name: string, bytes: Uint8Array): Promise<string> {
  tempDir ??= await mkdtemp(join(tmpdir(), 'ollama-sdk-vision-'));
  const path = join(tempDir, name);
  await writeFile(path, bytes);
  return path;
}

// A routable public IP literal — the guard classifies it synchronously.
const PUBLIC_HOST = '93.184.216.34';
const PUBLIC_IMAGE_URL = `https://${PUBLIC_HOST}/cat.png`;

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** A fetch stub that never performs I/O — responses are handed in directly. */
function fetchStub(responses: Response[] | ((url: string) => Response)): ImageFetchLike {
  const queue = Array.isArray(responses) ? [...responses] : undefined;
  const fn = queue === undefined ? (responses as (url: string) => Response) : undefined;
  return vi.fn(async (url: string) => {
    if (fn !== undefined) return fn(url);
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected extra fetch: ${url}`);
    return next;
  }) as unknown as ImageFetchLike;
}

function streamResponse(chunks: readonly Uint8Array[], options?: { infinite?: boolean }): Response {
  const source = [...chunks];
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < source.length) {
        controller.enqueue(source[index] ?? new Uint8Array());
        index += 1;
      } else if (options?.infinite === true) {
        controller.enqueue(source[0] ?? new Uint8Array());
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200 });
}

function redirectResponse(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

/** A fetch stub that never settles and only rejects when the signal aborts. */
function hangingFetch(): ImageFetchLike & { signalCaught: () => AbortSignal | undefined } {
  let caught: AbortSignal | undefined;
  const fn = (_url: string, init?: { signal?: AbortSignal } | undefined): Promise<Response> => {
    caught = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('fetch aborted'));
      });
    });
  };
  return Object.assign(fn as ImageFetchLike, {
    signalCaught: () => caught,
  });
}

const publicLookup = async (): Promise<readonly ImageAddress[]> => [
  { address: PUBLIC_HOST, family: 4 },
];

describe('resolveImageInput — passthrough, data URIs, bytes', () => {
  it('passes plain base64 strings through (with surrounding whitespace trimmed)', async () => {
    const payload = 'aGVsbG8gdmlzaW9uIHdvcmxk';
    await expect(resolveImageInput(`  ${payload}\n`)).resolves.toBe(payload);
  });

  it('strips data-URI headers regardless of MIME subtype', async () => {
    const payload = 'iVBORw0KGgoAAAANSUhEUg';
    await expect(resolveImageInput(`data:image/png;base64,${payload}`)).resolves.toBe(payload);
    await expect(resolveImageInput(`data:image/jpeg;base64,  ${payload}`)).resolves.toBe(payload);
  });

  it('rejects data-URI payloads whose decoded size exceeds maxImageBytes', async () => {
    // 24 base64 chars ≈ 18 decoded bytes; cap at 8.
    await expect(
      resolveImageInput('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg', undefined, {
        maxImageBytes: 8,
      }),
    ).rejects.toMatchObject({ code: 'image_too_large' });
  });

  it('base64-encodes Uint8Array and Buffer inputs', async () => {
    const bytes = new TextEncoder().encode('hello vision world');
    const encoded = await resolveImageInput(bytes);
    expect(encoded).toBe(b64(bytes));

    const asBuffer = Buffer.from('hello buffer world');
    await expect(resolveImageInput(asBuffer)).resolves.toBe(asBuffer.toString('base64'));
  });

  it('does not size-cap direct byte inputs — the caller already holds the memory', async () => {
    const bytes = new TextEncoder().encode('twelve bytes!');
    await expect(resolveImageInput(bytes, undefined, { maxImageBytes: 4 })).resolves.toBe(
      b64(bytes),
    );
  });
});

describe('resolveImageInput — remote URLs under policy', () => {
  it('fetches with the injected fetchImpl and encodes the response bytes', async () => {
    const imageBytes = new TextEncoder().encode('fake-png-bytes');
    const fetchImpl = fetchStub([new Response(imageBytes as unknown as BodyInit, { status: 200 })]);
    await expect(resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl })).resolves.toBe(
      b64(imageBytes),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      PUBLIC_IMAGE_URL,
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('throws a descriptive error when a URL fetch fails', async () => {
    const fetchImpl = fetchStub([new Response('nope', { status: 404, statusText: 'Not Found' })]);
    await expect(
      resolveImageInput(`https://${PUBLIC_HOST}/missing.png`, undefined, { fetchImpl }),
    ).rejects.toThrow(/Failed to fetch image from URL.*404/);
  });

  it('wraps transport-level fetch failures with the underlying cause', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as ImageFetchLike;
    const rejection = await resolveImageInput(PUBLIC_IMAGE_URL, undefined, {
      fetchImpl,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(rejection).toMatchObject({ code: 'image_fetch_failed' });
    expect((rejection as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
  });

  it('enforces maxImageBytes while streaming — oversized single chunk', async () => {
    const chunk = new TextEncoder().encode('0123456789'); // 10 bytes
    const fetchImpl = fetchStub([streamResponse([chunk])]);
    await expect(
      resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl, maxImageBytes: 8 }),
    ).rejects.toMatchObject({ code: 'image_too_large' });
  });

  it('enforces maxImageBytes while streaming — infinite stream is cut off at the cap', async () => {
    const chunk = new TextEncoder().encode('12345678'); // 8 bytes per pull
    const fetchImpl = fetchStub([streamResponse([chunk], { infinite: true })]);
    await expect(
      resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl, maxImageBytes: 40 }),
    ).rejects.toMatchObject({ code: 'image_too_large' });
  });

  it('follows redirects, re-validating every hop', async () => {
    const imageBytes = new TextEncoder().encode('redirected-png');
    const seen: string[] = [];
    const fetchImpl = fetchStub((url: string) => {
      seen.push(url);
      if (url === PUBLIC_IMAGE_URL) {
        return redirectResponse(302, 'https://93.184.216.35/real.png');
      }
      return new Response(imageBytes as unknown as BodyInit, { status: 200 });
    });
    await expect(resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl })).resolves.toBe(
      b64(imageBytes),
    );
    expect(seen).toEqual([PUBLIC_IMAGE_URL, 'https://93.184.216.35/real.png']);
  });

  it('resolves relative redirect locations against the current URL', async () => {
    const imageBytes = new TextEncoder().encode('rel-redirect');
    const fetchImpl = fetchStub([
      redirectResponse(301, '/other.png'),
      new Response(imageBytes as unknown as BodyInit, { status: 200 }),
    ]);
    await expect(resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl })).resolves.toBe(
      b64(imageBytes),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `https://${PUBLIC_HOST}/other.png`,
      expect.anything(),
    );
  });

  it('blocks a redirect whose target is a private address', async () => {
    const fetchImpl = fetchStub([redirectResponse(302, 'http://10.0.0.9/priv.png')]);
    await expect(
      resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'image_private_address_blocked' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect to a non-http protocol (e.g. file://)', async () => {
    const fetchImpl = fetchStub([redirectResponse(302, 'file:///etc/passwd')]);
    await expect(
      resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'image_unsupported_protocol' });
  });

  it('enforces the redirect cap', async () => {
    const fetchImpl = fetchStub((url: string) => redirectResponse(302, `${url}x`));
    await expect(
      resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl, maxRedirects: 1 }),
    ).rejects.toMatchObject({ code: 'image_redirect_limit' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // original + 1 followed redirect
  });

  it('treats a redirect without a Location header as a failed fetch', async () => {
    const fetchImpl = fetchStub([new Response(null, { status: 302 })]);
    await expect(
      resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'image_fetch_failed' });
  });

  it('times out remote fetches that never settle', async () => {
    const fetchImpl = hangingFetch();
    await expect(
      resolveImageInput(PUBLIC_IMAGE_URL, undefined, { fetchImpl, fetchTimeoutMs: 25 }),
    ).rejects.toMatchObject({ code: 'image_fetch_timeout' });
  });

  it('aborts when the caller signal aborts mid-fetch', async () => {
    const fetchImpl = hangingFetch();
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 10);
    const rejection = await resolveImageInput(PUBLIC_IMAGE_URL, caller.signal, {
      fetchImpl,
      fetchTimeoutMs: 5_000,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(rejection).toMatchObject({ code: 'aborted' });
  });
});

describe('resolveImageInput — host allowlist', () => {
  it('permits hosts on the allowlist (exact match, case-insensitive)', async () => {
    const imageBytes = new TextEncoder().encode('allowed');
    const fetchImpl = fetchStub([new Response(imageBytes as unknown as BodyInit, { status: 200 })]);
    await expect(
      resolveImageInput(PUBLIC_IMAGE_URL, undefined, {
        fetchImpl,
        allowedImageHosts: [PUBLIC_HOST.toUpperCase()],
      }),
    ).resolves.toBe(b64(imageBytes));
  });

  it('rejects hosts not on the allowlist before any fetch', async () => {
    const fetchImpl = fetchStub([new Response(null, { status: 200 })]);
    await expect(
      resolveImageInput(PUBLIC_IMAGE_URL, undefined, {
        fetchImpl,
        allowedImageHosts: ['cdn.example.com'],
      }),
    ).rejects.toMatchObject({ code: 'image_host_not_allowed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('supports *.example.com wildcards for subdomains (not the bare domain)', async () => {
    const imageBytes = new TextEncoder().encode('wild');
    const fetchImpl = fetchStub([new Response(imageBytes as unknown as BodyInit, { status: 200 })]);
    await expect(
      resolveImageInput('https://cdn.example.com/a.png', undefined, {
        fetchImpl,
        allowedImageHosts: ['*.example.com'],
        addressLookup: publicLookup,
      }),
    ).resolves.toBe(b64(imageBytes));

    await expect(
      resolveImageInput('https://example.com/a.png', undefined, {
        fetchImpl,
        allowedImageHosts: ['*.example.com'],
        addressLookup: publicLookup,
      }),
    ).rejects.toMatchObject({ code: 'image_host_not_allowed' });
  });

  it("'*' allows any host (private ranges still guarded)", async () => {
    const fetchImpl = fetchStub([new Response(null, { status: 200 })]);
    await expect(
      resolveImageInput('http://127.0.0.1/a.png', undefined, {
        fetchImpl,
        allowedImageHosts: ['*'],
      }),
    ).rejects.toMatchObject({ code: 'image_private_address_blocked' });
  });
});

describe('resolveImageInput — SSRF guard', () => {
  const privateTargets = [
    'http://127.0.0.1:8080/a.png',
    'http://10.0.0.5/a.png',
    'http://172.16.0.1/a.png',
    'http://192.168.1.5/a.png',
    'http://169.254.169.254/latest/meta-data.png', // cloud metadata endpoint
    'http://100.64.0.1/a.png', // CGNAT
    'http://0.0.0.0/a.png',
    'http://203.0.113.5/a.png', // TEST-NET-3 (documentation)
    'http://[::1]/a.png',
    'http://[fe80::1]/a.png',
    'http://[fc00::1]/a.png',
    'http://[::ffff:127.0.0.1]/a.png', // IPv4-mapped loopback
    'http://localhost:11434/a.png',
    'http://api.internal/a.png',
    'http://printer.local/a.png',
  ];

  it.each(privateTargets)('blocks private/reserved target %s before any fetch', async (url) => {
    const fetchImpl = fetchStub([new Response(null, { status: 200 })]);
    await expect(resolveImageInput(url, undefined, { fetchImpl })).rejects.toMatchObject({
      code: 'image_private_address_blocked',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks hostnames that RESOLVE to a private address (DNS path)', async () => {
    const fetchImpl = fetchStub([new Response(null, { status: 200 })]);
    await expect(
      resolveImageInput('https://images.example.com/a.png', undefined, {
        fetchImpl,
        addressLookup: async () => [{ address: '10.0.0.9', family: 4 }],
      }),
    ).rejects.toMatchObject({ code: 'image_private_address_blocked' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks when ANY resolved address is private', async () => {
    const fetchImpl = fetchStub([new Response(null, { status: 200 })]);
    await expect(
      resolveImageInput('https://images.example.com/a.png', undefined, {
        fetchImpl,
        addressLookup: async () => [
          { address: PUBLIC_HOST, family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'image_private_address_blocked' });
  });

  it('proceeds when the hostname resolves publicly', async () => {
    const imageBytes = new TextEncoder().encode('dns-ok');
    const fetchImpl = fetchStub([new Response(imageBytes as unknown as BodyInit, { status: 200 })]);
    await expect(
      resolveImageInput('https://images.example.com/a.png', undefined, {
        fetchImpl,
        addressLookup: publicLookup,
      }),
    ).resolves.toBe(b64(imageBytes));
  });

  it('treats a DNS lookup failure as not-private (the fetch surfaces it)', async () => {
    const fetchImpl = fetchStub([
      new Response('x' as unknown as BodyInit, { status: 500, statusText: 'Boom' }),
    ]);
    await expect(
      resolveImageInput('https://nonexistent.example.com/a.png', undefined, {
        fetchImpl,
        addressLookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toMatchObject({ code: 'image_fetch_failed' });
  });

  it('allows private targets when allowPrivateNetworkAccess is set', async () => {
    const imageBytes = new TextEncoder().encode('internal-image');
    const fetchImpl = fetchStub([new Response(imageBytes as unknown as BodyInit, { status: 200 })]);
    await expect(
      resolveImageInput('http://10.0.0.5/internal.png', undefined, {
        fetchImpl,
        allowPrivateNetworkAccess: true,
      }),
    ).resolves.toBe(b64(imageBytes));
  });

  it('the error explains the SSRF rationale and the opt-out', async () => {
    const fetchImpl = fetchStub([new Response(null, { status: 200 })]);
    const rejection = await resolveImageInput('http://169.254.169.254/a.png', undefined, {
      fetchImpl,
    }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(rejection?.message).toContain('SSRF');
    expect(rejection?.message).toContain('allowPrivateNetworkAccess');
  });
});

describe('resolveImageInput — local files', () => {
  it('reads local files with known image extensions (Node.js)', async () => {
    const bytes = new TextEncoder().encode('local-file-image-bytes');
    const path = await tempFile('photo.png', bytes);
    await expect(resolveImageInput(path)).resolves.toBe(b64(bytes));
  });

  it('throws a descriptive error when an extension-shaped string is not a readable file', async () => {
    // Old behavior shipped the raw path string to the server (which can only
    // reject it as invalid base64 — the extension-matched string can never BE
    // base64, the alphabet has no '.'). See ADR 0041.
    const unreadable = '/definitely/not/a/file.png';
    await expect(resolveImageInput(unreadable)).rejects.toMatchObject({
      code: 'vision_path_read_failed',
    });
    await expect(resolveImageInput(unreadable)).rejects.toThrow(/ENOENT|no such file/i);
  });

  it('rejects a directory whose name ends in an image extension', async () => {
    tempDir ??= await mkdtemp(join(tmpdir(), 'ollama-sdk-vision-'));
    const dirPath = join(tempDir, 'dir.png');
    await mkdir(dirPath, { recursive: true });
    await expect(resolveImageInput(dirPath)).rejects.toMatchObject({
      code: 'vision_path_read_failed',
    });
  });

  it('enforces maxImageBytes on file reads (stat-based)', async () => {
    const bytes = new TextEncoder().encode('0123456789'); // 10 bytes
    const path = await tempFile('big.png', bytes);
    await expect(resolveImageInput(path, undefined, { maxImageBytes: 8 })).rejects.toMatchObject({
      code: 'image_too_large',
    });
  });

  it('refuses local reads when allowLocalFileReads is false', async () => {
    const bytes = new TextEncoder().encode('blocked-read');
    const path = await tempFile('blocked.png', bytes);
    await expect(
      resolveImageInput(path, undefined, { allowLocalFileReads: false }),
    ).rejects.toMatchObject({ code: 'vision_local_reads_disabled' });
  });
});

describe('imageStringNeedsResolution', () => {
  it('flags data URIs, URLs, and image-extension paths', () => {
    expect(imageStringNeedsResolution('data:image/png;base64,AAA')).toBe(true);
    expect(imageStringNeedsResolution('http://example.com/a.png')).toBe(true);
    expect(imageStringNeedsResolution('https://example.com/a.png')).toBe(true);
    expect(imageStringNeedsResolution('./photos/cat.jpg')).toBe(true);
    expect(imageStringNeedsResolution('logo.webp')).toBe(true);
  });

  it('does not flag plain base64 — even when it contains base64 alphabet slashes', () => {
    expect(imageStringNeedsResolution('aGVsbG8/vmlzaW9u')).toBe(false);
    expect(imageStringNeedsResolution('aGVsbG8gd29ybGQ=')).toBe(false);
  });
});

describe('resolveImages', () => {
  it('returns the same array reference when every entry is already base64', async () => {
    const images = ['AAAA', 'BBBB'];
    const result = await resolveImages(images);
    expect(result).toBe(images);
  });

  it('resolves mixed arrays in place of the polymorphic entries', async () => {
    const bytes = new TextEncoder().encode('mix');
    const result = await resolveImages(['data:image/png;base64,AAAB', bytes, 'cGFzcw==']);
    expect(result).toEqual(['AAAB', b64(bytes), 'cGFzcw==']);
  });

  it('returns undefined for undefined input', async () => {
    await expect(resolveImages(undefined)).resolves.toBeUndefined();
  });

  it('threads the policy into every entry resolution', async () => {
    const fetchImpl = fetchStub([new Response(null, { status: 200 })]);
    await expect(
      resolveImages(['https://198.51.100.7/a.png'], undefined, {
        fetchImpl,
        allowedImageHosts: [PUBLIC_HOST],
      }),
    ).rejects.toMatchObject({ code: 'image_host_not_allowed' });
  });
});

describe('chat()/generate() request pipeline integration', () => {
  it('sends data-URI-stripped, file-read, and byte-encoded images as raw base64 on the wire', async () => {
    const fileBytes = new TextEncoder().encode('from-disk');
    const path = await tempFile('disk-image.jpg', fileBytes);
    const inlineBytes = new TextEncoder().encode('inline-bytes');

    const bodies: unknown[] = [];
    const client = new OllamaClient({
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(init?.body !== undefined ? JSON.parse(String(init.body)) : undefined);
        return new Response(
          JSON.stringify({
            model: 'llava',
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: 'I see a cat.' },
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch,
    });

    await client.chat({
      model: 'llava',
      messages: [
        {
          role: 'user',
          content: 'What is in these images?',
          images: ['data:image/png;base64,AAAC', path, inlineBytes],
        },
      ],
    });

    const sent = bodies[0] as { messages: { images: string[] }[] };
    expect(sent.messages[0]?.images).toEqual(['AAAC', b64(fileBytes), b64(inlineBytes)]);
  });

  it('resolves URL images through the CLIENT-configured fetch, then sends base64', async () => {
    const imageBytes = new TextEncoder().encode('url-image-bytes');
    const fetchedUrls: string[] = [];
    const bodies: unknown[] = [];
    const client = new OllamaClient({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = url.toString();
        fetchedUrls.push(u);
        if (u === PUBLIC_IMAGE_URL) {
          return new Response(imageBytes as unknown as BodyInit, { status: 200 });
        }
        bodies.push(init?.body !== undefined ? JSON.parse(String(init.body)) : undefined);
        return new Response(
          JSON.stringify({
            model: 'llava',
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: 'ok' },
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch,
    });

    await client.chat({
      model: 'llava',
      messages: [{ role: 'user', content: 'describe', images: [PUBLIC_IMAGE_URL] }],
    });

    expect(fetchedUrls[0]).toBe(PUBLIC_IMAGE_URL);
    const sent = bodies[0] as { messages: { images: string[] }[] };
    expect(sent.messages[0]?.images).toEqual([b64(imageBytes)]);
  });

  it('applies imageResolution policy configured on the client', async () => {
    const client = new OllamaClient({
      fetch: (async () =>
        new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch,
      imageResolution: { allowedImageHosts: [PUBLIC_HOST] },
    });
    await expect(
      client.chat({
        model: 'llava',
        messages: [{ role: 'user', content: 'x', images: ['https://198.51.100.7/a.png'] }],
      }),
    ).rejects.toMatchObject({ code: 'image_host_not_allowed' });
  });

  it('generate() resolves URL images under the client policy too', async () => {
    const imageBytes = new TextEncoder().encode('gen-image');
    const bodies: unknown[] = [];
    const client = new OllamaClient({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (url.toString() === PUBLIC_IMAGE_URL) {
          return new Response(imageBytes as unknown as BodyInit, { status: 200 });
        }
        bodies.push(init?.body !== undefined ? JSON.parse(String(init.body)) : undefined);
        return new Response(
          JSON.stringify({
            model: 'llava',
            created_at: new Date().toISOString(),
            response: 'ok',
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch,
    });

    await client.generate({
      model: 'llava',
      prompt: 'describe',
      images: [PUBLIC_IMAGE_URL],
    });

    const sent = bodies[0] as { images: string[] };
    expect(sent.images).toEqual([b64(imageBytes)]);
  });
});
