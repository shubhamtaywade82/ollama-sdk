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

  it('captures npm ERESOLVE peer dependency failures', () => {
    const rawLog = `
      npm error code ERESOLVE
      npm error ERESOLVE could not resolve
      npm error While resolving: @opentelemetry/sdk-trace-base@2.12.0
      npm error Found: @opentelemetry/api@1.10.0
      npm error Could not resolve dependency:
      npm error peer @opentelemetry/api@">=1.3.0 <1.10.0" from @opentelemetry/sdk-trace-base@2.12.0
    `;
    const minimized = minimizeFailureLogs(rawLog);
    expect(minimized.errorSummary).toContain('ERESOLVE');
    expect(minimized.errorSummary).toContain('@opentelemetry/api@1.10.0');
    expect(minimized.errorSummary).toContain('<1.10.0');
  });

  it('does not treat non-actionable informational output as a failure', () => {
    const minimized = minimizeFailureLogs('added 248 packages and audited 249 packages');
    expect(minimized.errorSummary).toBe('');
  });
});
