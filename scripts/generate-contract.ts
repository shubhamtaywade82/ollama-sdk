#!/usr/bin/env tsx
/**
 * Generate TypeScript types + API classes + metadata from the canonical IR.
 * Thin wrapper around `generator/cli.ts generate`.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../generator/cli.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'generate'], {
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
