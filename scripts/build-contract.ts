#!/usr/bin/env tsx
/**
 * Compile contracts/sources + contracts/overlays → contracts/ir/ollama.ir.json.
 *
 * Thin wrapper around `generator/cli.ts normalize` so npm scripts stay short.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../generator/cli.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'normalize'], {
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
