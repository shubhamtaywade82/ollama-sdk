import { afterEach, describe, expect, it, vi } from 'vitest';
import { findUpstreamDrift } from '../../scripts/upstream-drift.js';
import { applyCuratedDeviations, rewriteCuratedHeader } from '../../scripts/fetch-contract.js';

/**
 * ADR 0039: the weekly upstream watch. Drift is decided by commit ancestry
 * (GitHub compare), and a re-pin must re-apply every curated deviation or
 * prove upstream adopted it — never drop one silently.
 */
const PINNED = 'a'.repeat(40);
const LATEST = 'b'.repeat(40);
const SOURCE = {
  id: 'openapi',
  upstreamPath: 'docs/openapi.yaml',
  pinnedSha: PINNED,
  pinnedAt: '2026-10-22',
};

function githubCommit(sha: string, message: string): object {
  return {
    sha,
    html_url: `https://github.com/ollama/ollama/commit/${sha}`,
    commit: { message, committer: { date: '2026-10-23T00:00:00Z' } },
  };
}

function stubGitHub(compareStatus: string): void {
  vi.stubGlobal('fetch', async (url: string) => {
    const body = url.includes('/compare/')
      ? { status: compareStatus, base_commit: githubCommit(PINNED, 'pinned') }
      : [githubCommit(LATEST, 'docs: add endpoint\n\nbody'), githubCommit(PINNED, 'pinned')];
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe('findUpstreamDrift', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('should report drift with the new commits when upstream is ahead of the pin', async () => {
    stubGitHub('ahead');
    const [drift] = await findUpstreamDrift([SOURCE]);
    expect(drift?.latest.sha).toBe(LATEST);
    expect(drift?.commits.map((commit) => commit.sha)).toEqual([LATEST]);
    expect(drift?.commits[0]?.subject).toBe('docs: add endpoint');
  });

  it.each(['identical', 'behind'])(
    'should report no drift when compare status is %s',
    async (status) => {
      stubGitHub(status);
      expect(await findUpstreamDrift([SOURCE])).toEqual([]);
    },
  );

  it('should skip sources without an upstreamPath', async () => {
    stubGitHub('ahead');
    expect(await findUpstreamDrift([{ id: 'native-docs' }])).toEqual([]);
  });
});

describe('applyCuratedDeviations', () => {
  const upstream =
    'details:\n            families:\n              type: array\n            items: {}\n';
  const curated =
    "details:\n            families:\n              type:\n                - array\n                - 'null'\n            items: {}\n";

  it('should re-apply the families deviation to the upstream body', () => {
    expect(applyCuratedDeviations(upstream)).toBe(curated);
  });

  it('should leave the body unchanged when upstream already adopted the deviation', () => {
    expect(applyCuratedDeviations(curated)).toBe(curated);
  });

  it('should throw when the deviation anchor is gone', () => {
    expect(() => applyCuratedDeviations('details: {}\n')).toThrow(/families/);
  });
});

describe('rewriteCuratedHeader', () => {
  const header = `#  Pinned from ollama/ollama/docs/openapi.yaml@main on 2026-10-22 (source SHA: ${PINNED}). Narrative.`;

  it('should rewrite the pin anchor that pin-consistency.test.ts parses and append a refresh note', () => {
    const commit = { sha: LATEST, subject: 'docs: add endpoint', date: '', url: '' };
    const rewritten = rewriteCuratedHeader(header, '2026-10-24', LATEST, [commit]);
    expect(rewritten).toMatch(
      new RegExp(`on 2026-10-24 \\(source SHA: ${LATEST}\\)\\. Narrative\\.`),
    );
    expect(rewritten).toContain(
      `The 2026-10-24 auto-refresh (source SHA: ${LATEST}) brings in: bbbbbbb (docs: add endpoint).`,
    );
  });

  it('should throw when the header has no pin anchor', () => {
    expect(() => rewriteCuratedHeader('# no anchor', '2026-10-24', LATEST, [])).toThrow(/anchor/);
  });
});
