import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

// The four git conflict-marker line shapes, assembled via repeat() so that
// THIS file never contains the literal seven-character sequences it scans
// for (a self-match would make the guard unrunnable).
//
//  - MARKER_START  `<<<<<<<` (7 '<')  — start of an unresolved conflict
//  - MARKER_SEP    `=======` (7 '=')  — the divider, exactly and only 7
//  - MARKER_BASE   `|||||||` (7 '|')  — diff3 "base" section marker
//  - MARKER_END    `>>>>>>>` (7 '>')  — end of an unresolved conflict
//
// Why this test exists: v1.22.0's PR head (9a472fa) shipped a green CI run
// carrying a stray rebase marker at CHANGELOG.md:23 — `>>>>>>> 3466a0f (...)`
// sat where a blank section separator belonged. Nothing gated it: the
// changelog is neither linted nor imported by tests, so an eight-check CI
// matrix passed over it and the marker rode all the way to the merge gate,
// where it was caught by manual review minutes before tagging (dropped in
// the ac9a385 amendment). That was the third artifact-class lesson in a row
// (ADR 0036: display artifacts; ADR 0038: piped exit codes); this test is
// the structural fix — the class can no longer reach main behind a passing
// build. It runs everywhere `npm test` runs: PR CI, the publish workflow's
// pre-publish suite, and local development.
const MARKER_START = '<'.repeat(7);
const MARKER_SEP = '='.repeat(7);
const MARKER_BASE = '|'.repeat(7);
const MARKER_END = '>'.repeat(7);

function trackedFiles(): string[] {
  // Fail closed: if git is unavailable or this is not a git checkout, the
  // exec throws and the test errors out rather than silently scanning
  // nothing. Every environment that runs the suite (dev, CI, the release
  // publish workflow's full checkout) has git and .git.
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: PROJECT_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function isText(content: string): boolean {
  // Same idea as `git grep -I`: a NUL byte means binary. Decoding a binary
  // blob as UTF-8 cannot produce a line that STARTS with a marker at a
  // newline boundary in practice, but skipping binaries keeps the scan
  // honest and cheap.
  return !content.includes('\0');
}

describe('repo hygiene: no unresolved conflict markers in tracked files', () => {
  it('every tracked text file is free of conflict markers', () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const rel of trackedFiles()) {
      let content: string;
      try {
        content = readFileSync(resolve(PROJECT_ROOT, rel), 'utf8');
      } catch {
        // Unreadable in the working tree (e.g. deleted after listing) —
        // not this test's concern; git itself would flag such states.
        continue;
      }
      if (!isText(content)) continue;
      scanned += 1;

      for (const [i, line] of content.split('\n').entries()) {
        if (
          line.startsWith(MARKER_START) ||
          line.startsWith(MARKER_END) ||
          line.startsWith(MARKER_BASE) ||
          line === MARKER_SEP
        ) {
          offenders.push(`${rel}:${i + 1}: ${line.slice(0, 80)}`);
        }
      }
    }

    // Sanity floor: the repo tracks ~560 files. If a future change makes
    // `git ls-files` return a near-empty set (submodule split, move to a
    // monorepo tool, etc.), this assertion fails loudly instead of letting
    // the guard above silently degrade into a no-op that always passes.
    expect(scanned, 'tracked text files scanned').toBeGreaterThan(400);

    expect(
      offenders,
      [
        'Unresolved conflict markers found in tracked files',
        '(left behind by a rebase or merge — resolve, then re-run):',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });
});
