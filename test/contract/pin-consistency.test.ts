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
