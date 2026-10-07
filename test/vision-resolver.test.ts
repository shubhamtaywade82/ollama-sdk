import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { imageStringNeedsResolution, resolveImageInput, resolveImages } from '../src/vision.js';

/**
 * Universal vision asset resolution (src/vision.ts) — the SDK-side half of
 * Ollama's documented vision ingestion convention: SDKs accept polymorphic
 * image sources; the REST API strictly requires raw base64 strings.
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

describe('resolveImageInput', () => {
  it('passes plain base64 strings through (with surrounding whitespace trimmed)', async () => {
    const payload = 'aGVsbG8gdmlzaW9uIHdvcmxk';
    await expect(resolveImageInput(`  ${payload}\n`)).resolves.toBe(payload);
  });

  it('strips data-URI headers regardless of MIME subtype', async () => {
    const payload = 'iVBORw0KGgoAAAANSUhEUg';
    await expect(resolveImageInput(`data:image/png;base64,${payload}`)).resolves.toBe(payload);
    await expect(resolveImageInput(`data:image/jpeg;base64,  ${payload}`)).resolves.toBe(payload);
  });

  it('base64-encodes Uint8Array and Buffer inputs', async () => {
    const bytes = new TextEncoder().encode('hello vision world');
    const encoded = await resolveImageInput(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));

    const asBuffer = Buffer.from('hello buffer world');
    await expect(resolveImageInput(asBuffer)).resolves.toBe(asBuffer.toString('base64'));
  });

  it('fetches http(s) URLs and encodes the response bytes', async () => {
    const imageBytes = new TextEncoder().encode('fake-png-bytes');
    const fetchMock = vi.fn(
      async () => new Response(imageBytes as unknown as BodyInit, { status: 200 }),
    );
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(resolveImageInput('https://example.com/cat.png')).resolves.toBe(
        Buffer.from(imageBytes).toString('base64'),
      );
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/cat.png', undefined);
    } finally {
      vi.unstubAllGlobals();
      void originalFetch;
    }
  });

  it('throws a descriptive error when a URL fetch fails', async () => {
    const fetchMock = vi.fn(
      async () => new Response('nope', { status: 404, statusText: 'Not Found' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(resolveImageInput('https://example.com/missing.png')).rejects.toThrow(
        /Failed to fetch image from URL.*404/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads local files with known image extensions (Node.js)', async () => {
    const bytes = new TextEncoder().encode('local-file-image-bytes');
    const path = await tempFile('photo.png', bytes);
    await expect(resolveImageInput(path)).resolves.toBe(Buffer.from(bytes).toString('base64'));
    // Also with a directory-containing absolute path — same code path.
    await expect(resolveImageInput(path)).resolves.toBe(Buffer.from(bytes).toString('base64'));
  });

  it('falls back to passthrough when an extension-shaped string is not a readable file', async () => {
    // A base64 payload that merely happens to end in an image-like suffix:
    // the read fails and the input is returned unchanged (digest's graceful
    // fallback — the server would reject it if it really wasn't base64).
    const unreadable = '/definitely/not/a/file-ZmFrZS1iYXNlNjQ.png';
    await expect(resolveImageInput(unreadable)).resolves.toBe(unreadable);

    const payload = 'ZmFrZS1iYXNlNjQtY29udGVudA';
    await expect(resolveImageInput(`${payload}.png`)).resolves.toBe(`${payload}.png`);
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
    expect(result).toEqual(['AAAB', Buffer.from(bytes).toString('base64'), 'cGFzcw==']);
  });

  it('returns undefined for undefined input', async () => {
    await expect(resolveImages(undefined)).resolves.toBeUndefined();
  });
});

describe('chat() request pipeline integration', () => {
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
    expect(sent.messages[0]?.images).toEqual([
      'AAAC',
      Buffer.from(fileBytes).toString('base64'),
      Buffer.from(inlineBytes).toString('base64'),
    ]);
  });
});
