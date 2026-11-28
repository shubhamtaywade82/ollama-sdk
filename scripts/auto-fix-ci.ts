import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldContinueAfterAutoFix, type AutoFixer } from './auto-fix-ci-policy.js';

const directories = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'docs-site',
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

const localTools: Record<AutoFixer, string> = {
  prettier: resolve('node_modules/prettier/bin/prettier.cjs'),
  eslint: resolve('node_modules/eslint/bin/eslint.js'),
};

function runFixer(fixer: AutoFixer, args: string[]): void {
  const executable = localTools[fixer];
  if (!existsSync(executable)) {
    throw new Error(`${fixer} is not installed. Run npm ci before auto-fixing.`);
  }

  const result = spawnSync(process.execPath, [executable, ...args], {
    stdio: 'inherit',
    shell: false,
  });

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
  runFixer('eslint', ['.', '--fix']);
} catch (error) {
  console.error('[auto-fix] deterministic remediation could not complete:', error);
  process.exitCode = 1;
}
