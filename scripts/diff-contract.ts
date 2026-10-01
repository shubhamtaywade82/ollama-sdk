#!/usr/bin/env tsx
/**
 * Diff the freshly-normalized IR against the committed
 * contracts/ir/ollama.ir.json. Exits non-zero when drift is detected,
 * so this can be used as a CI gate to catch "IR is stale" PRs.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../generator/cli.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'diff'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
