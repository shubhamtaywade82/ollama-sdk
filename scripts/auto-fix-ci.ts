import { spawnSync } from 'node:child_process';
import { shouldContinueAfterAutoFix, type AutoFixer } from './auto-fix-ci-policy.js';

const directories = [
  'src',
  'test',
  'tools',
  'scripts',
  'examples',
  'lab',
  'bench',
  'generator',
  'docs',
];

function runFixer(fixer: AutoFixer, args: string[]): void {
  const result = spawnSync(fixer, args, { stdio: 'inherit', shell: false });

  if (result.error) {
    throw new Error(`Unable to execute ${fixer}: ${result.error.message}`);
  }

  if (!shouldContinueAfterAutoFix(fixer, result.status)) {
    throw new Error(`${fixer} failed unexpectedly (exit code ${String(result.status)}).`);
  }

  if (result.status !== 0) {
    console.warn(
      `[auto-fix] ${fixer} left diagnostics that require repair-agent attention (exit ${result.status}).`,
    );
  }
}

try {
  runFixer('prettier', ['--write', ...directories]);
  runFixer('eslint', [...directories, '--fix']);
} catch (error) {
  console.error('[auto-fix] deterministic remediation could not complete:', error);
  process.exitCode = 1;
}
