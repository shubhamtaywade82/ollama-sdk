export type AutoFixer = 'prettier' | 'eslint';

/**
 * Prettier exits 2 for parse diagnostics; ESLint exits 1 when violations remain.
 * Those are inputs for the repair agent, not setup failures. All other non-zero
 * statuses (including command/config errors) fail closed.
 */
export function shouldContinueAfterAutoFix(fixer: AutoFixer, exitCode: number | null): boolean {
  if (exitCode === 0) return true;
  if (fixer === 'prettier') return exitCode === 2;
  return exitCode === 1;
}
