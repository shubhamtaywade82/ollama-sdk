import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const OPENAPI_PATH = resolve(PROJECT_ROOT, 'contracts/sources/ollama.openapi.yaml');
const DOCS_INDEX_PATH = resolve(PROJECT_ROOT, 'contracts/sources/docs-index.json');

/**
 * ADR 0036: the docs-index `pinnedSha` used to record the upstream file's
 * git BLOB sha and silently lagged the actual pin (it said 2a9ffe39 — the
 * 2026-10-15 blob — while the pinned spec had already moved to the
 * 2026-10-16 d9b8601 refresh; nothing consumed the field, so no test
 * caught it). Since the 2026-10-22 refresh the field records the upstream
 * main COMMIT sha from the pin header's first line, and this test asserts
 * the two stay in lockstep — a stale index can never again hide behind a
 * passing build.
 *
 * (Verification lesson baked into this test's approach: the assertions read
 * the raw file and match structurally, never visually — terminal output
 * pipelines can strip ANSI-like bracket sequences such as the `[m` inside
 * `[model]`, which once made a perfectly clean spec LOOK corrupted.)
 */
describe('pin consistency: docs-index.json matches the pinned OpenAPI header', () => {
  const openapiText = readFileSync(OPENAPI_PATH, 'utf8');
  const firstLine = openapiText.split('\n')[0] ?? '';
  const index = JSON.parse(readFileSync(DOCS_INDEX_PATH, 'utf8')) as {
    sources: ReadonlyArray<{
      id: string;
      kind: string;
      path: string | null;
      upstream: string;
      pinnedSha?: string;
      pinnedAt?: string;
    }>;
  };
  const openapiEntry = index.sources.find((s) => s.id === 'openapi');

  it('the pinned OpenAPI header carries a commit sha and pin date', () => {
    expect(firstLine).toMatch(/source SHA: [0-9a-f]{40}\)/);
    expect(firstLine).toMatch(/on \d{4}-\d{2}-\d{2} \(source SHA:/);
  });

  it('docs-index records the openapi source with pinnedSha and pinnedAt', () => {
    expect(openapiEntry).toBeDefined();
    expect(openapiEntry?.pinnedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(openapiEntry?.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('docs-index pinnedSha equals the commit sha in the pin header', () => {
    const headerSha = firstLine.match(/source SHA: ([0-9a-f]{40})\)/)?.[1];
    expect(openapiEntry?.pinnedSha).toBe(headerSha);
  });

  it('docs-index pinnedAt equals the pin date in the pin header', () => {
    const headerDate = firstLine.match(/on (\d{4}-\d{2}-\d{2}) \(source SHA:/)?.[1];
    expect(openapiEntry?.pinnedAt).toBe(headerDate);
  });

  it('every docs-index source with a path exists on disk', () => {
    for (const source of index.sources) {
      if (source.path === null) continue;
      const path = resolve(PROJECT_ROOT, source.path);
      expect(existsSync(path), `docs-index path missing: ${source.path}`).toBe(true);
    }
  });

  it('the pin header documents the current refresh (2026-10-22, 36a6e99)', () => {
    // The first line is re-dated on every refresh; the refresh history is
    // appended in the same header. The latest refresh must mention the
    // upstream features it brought in — a cheap guard against a refresh
    // note that does not match the pinned content.
    expect(openapiText).toContain('The 2026-10-22 refresh');
    expect(openapiText).toContain('group_by=model');
    expect(openapiText).toContain('template_source');
  });
});

describe('pin consistency: mdx pins match docs-index.json (since 2026-10-23)', () => {
  // ADR 0037: the two compatibility MDX pins used to carry no provenance at
  // all — the openai pin sat 11 days stale while upstream added the whole
  // /v1/audio/speech section, and the anthropic pin missed the 2026-10-13
  // model-recs removal, all behind a passing build. The same discipline the
  // openapi pin got in ADR 0036 now applies here: the header records the
  // last upstream commit touching the repo's docs/api/*.mdx source and the
  // refresh date, and docs-index must agree.
  const index = JSON.parse(readFileSync(DOCS_INDEX_PATH, 'utf8')) as {
    sources: ReadonlyArray<{
      id: string;
      kind: string;
      path: string | null;
      upstream: string;
      pinnedSha?: string;
      pinnedAt?: string;
    }>;
  };
  const mdxSources = index.sources.filter((s) => s.kind === 'mdx');

  interface MdxPinHeader {
    url: string;
    date: string;
    sha: string;
  }

  function readPinHeader(path: string): MdxPinHeader | undefined {
    const text = readFileSync(resolve(PROJECT_ROOT, path), 'utf8');
    const match = text.match(/Pinned from (\S+) on (\d{4}-\d{2}-\d{2}) \(source SHA: ([0-9a-f]{40})\)\./);
    if (!match) return undefined;
    return { url: match[1] ?? '', date: match[2] ?? '', sha: match[3] ?? '' };
  }

  it('docs-index records pinnedSha and pinnedAt for every mdx source', () => {
    expect(mdxSources.length).toBe(2);
    for (const source of mdxSources) {
      expect(source.pinnedSha, `${source.id} pinnedSha`).toMatch(/^[0-9a-f]{40}$/);
      expect(source.pinnedAt, `${source.id} pinnedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('each mdx pin header carries the same sha and date as docs-index', () => {
    for (const source of mdxSources) {
      if (source.path === null) continue;
      const header = readPinHeader(source.path);
      expect(header, `${source.id} pin has a parseable header line`).toBeDefined();
      expect(header?.sha).toBe(source.pinnedSha);
      expect(header?.date).toBe(source.pinnedAt);
    }
  });

  it('the openai pin documents the 2026-10-23 refresh (/v1/audio/speech)', () => {
    const openaiPin = readFileSync(
      resolve(PROJECT_ROOT, 'docs/upstream/ollama-openai-compatibility.mdx'),
      'utf8',
    );
    // The refresh marker for upstream 6ef847b8 (Phonon TTS docs): the audio
    // section with its supported/unsupported field matrix must be IN the pin.
    expect(openaiPin).toContain('`/v1/audio/speech`');
    expect(openaiPin).toContain('`stream_format`');
    expect(openaiPin).toContain('`instructions`');
  });

  it('the anthropic pin reflects the 2026-10-13 upstream edit (model-recs list retired)', () => {
    const anthropicPin = readFileSync(
      resolve(PROJECT_ROOT, 'docs/upstream/ollama-anthropic-compatibility.mdx'),
      'utf8',
    );
    // Upstream 33a3afa6 replaced the "Recommended local models" list with a
    // Models-page link. The pin must not still carry the retired list.
    expect(anthropicPin).not.toContain('Excellent for coding tasks');
    // The compat surface itself is unchanged.
    expect(anthropicPin).toContain('/v1/messages');
  });

  it('no raw base64 image payloads remain in the mdx pins', () => {
    for (const source of mdxSources) {
      if (source.path === null) continue;
      const text = readFileSync(resolve(PROJECT_ROOT, source.path), 'utf8');
      expect(text, `${source.id} pin elides base64`).not.toMatch(/base64,[A-Za-z0-9+/]{40,}/);
    }
  });
});
