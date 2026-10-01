#!/usr/bin/env tsx
/**
 * Print a drift report between generated types and src/types.ts.
 * Pass --strict to exit non-zero when drift is detected.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../generator/cli.ts');
const args = ['--import', 'tsx', CLI, 'drift', ...process.argv.slice(2)];
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
