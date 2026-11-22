import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff, shouldIgnoreFile } from '../src/diff-parser.js';

describe('diff-parser', () => {
  it('identifies files to ignore', () => {
    expect(shouldIgnoreFile('package-lock.json')).toBe(true);
    expect(shouldIgnoreFile('dist/index.js')).toBe(true);
    expect(shouldIgnoreFile('.git/HEAD')).toBe(true);
    expect(shouldIgnoreFile('image.png')).toBe(true);
    expect(shouldIgnoreFile('src/client.ts')).toBe(false);
  });

  it('extracts added line numbers from unified diff', () => {
    const sampleDiff = [
      'diff --git a/src/calc.ts b/src/calc.ts',
      '--- a/src/calc.ts',
      '+++ b/src/calc.ts',
      '@@ -10,2 +10,3 @@ function add(a, b) {',
      '   return a + b;',
      ' }',
      '+export const DEFAULT_VAL = 42;',
    ].join('\n');

    const chunks = parseUnifiedDiff(sampleDiff);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.file).toBe('src/calc.ts');
    expect(chunks[0]?.validLines.has(12)).toBe(true);
  });
});
