#!/usr/bin/env tsx
/**
 * Validate the contract system:
 *   1. Every overlay file conforms to the overlay schema.
 *   2. Cross-overlay compatibility is consistent (no duplicate ids/paths,
 *      domain/path consistency).
 *   3. Bidirectional endpoint discovery: every declared operation is
 *      discoverable in the docs, AND every discovered endpoint is declared
 *      in the contract. This is the new gate that catches the
 *      `/v1/systemone`-class bug.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../generator/cli.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'validate'], {
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
