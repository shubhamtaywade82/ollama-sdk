import { describe, it, expect } from 'vitest';
import { stripAnsi, minimizeFailureLogs } from '../src/log-minimizer.js';

describe('log-minimizer', () => {
  it('strips ANSI color codes', () => {
    const colored = '\x1b[31mFAIL\x1b[0m test/calc.test.ts';
    expect(stripAnsi(colored)).toBe('FAIL test/calc.test.ts');
  });

  it('extracts error lines and file paths from failure logs', () => {
    const rawLog = `
      Running vitest...
      \x1b[31mFAIL\x1b[0m test/calc.test.ts > adds numbers
      AssertionError: expected 5 to be 4
      at src/calc.ts:25:10
      npm test failed with exit code 1
    `;
    const minimized = minimizeFailureLogs(rawLog);
    expect(minimized.errorSummary).toContain('AssertionError: expected 5 to be 4');
    expect(minimized.relevantFiles).toContain('src/calc.ts');
  });
});
