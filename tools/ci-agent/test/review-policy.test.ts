import { describe, expect, it } from 'vitest';
import {
  estimateInputTokens,
  filterReviewFindings,
  isSensitiveReviewPath,
  selectReviewChunks,
} from '../src/review-policy.js';
import type { DiffChunk } from '../src/diff-parser.js';
import type { ReviewFinding } from '../src/schemas.js';

function chunk(file: string, diff: string, lines: number[] = [1, 2]): DiffChunk {
  return { file, diff, validLines: new Set(lines) };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: 'src/client.ts',
    line: 1,
    severity: 'warning',
    confidence: 'high',
    message: 'Potential null dereference',
    ...overrides,
  };
}

describe('review policy', () => {
  it('prioritizes sensitive files while respecting file and input budgets', () => {
    const chunks = [
      chunk('src/a.ts', 'a'.repeat(10)),
      chunk('.github/workflows/release.yml', 'b'.repeat(10)),
      chunk('src/b.ts', 'c'.repeat(10)),
    ];
    const selected = selectReviewChunks(chunks, 2, 20);
    expect(selected.map((item) => item.file)).toEqual([
      '.github/workflows/release.yml',
      'src/a.ts',
    ]);
  });

  it('recognizes security-sensitive paths for model escalation', () => {
    expect(isSensitiveReviewPath('.github/workflows/ci.yml')).toBe(true);
    expect(isSensitiveReviewPath('src/auth/token.ts')).toBe(true);
    expect(isSensitiveReviewPath('src/client.ts')).toBe(false);
  });

  it('drops info, low-confidence, wrong-file, invalid-line, and duplicate findings', () => {
    const current = chunk('src/client.ts', 'diff');
    const results = filterReviewFindings([
      finding({ severity: 'info' }),
      finding({ confidence: 'low' }),
      finding({ file: 'src/other.ts' }),
      finding({ line: 99 }),
      finding(),
      finding(),
    ], current);
    expect(results).toHaveLength(1);
  });

  it('caps findings per file', () => {
    const current = chunk('src/client.ts', 'diff', [1, 2, 3]);
    const results = filterReviewFindings([
      finding({ line: 1 }),
      finding({ line: 2, message: 'Missing error handling' }),
      finding({ line: 3, message: 'Unexpected mutation' }),
    ], current, { total: 10, perFile: 2 });
    expect(results).toHaveLength(2);
  });

  it('estimates input tokens conservatively from prompt size', () => {
    expect(estimateInputTokens('12345678')).toBe(2);
  });
});
