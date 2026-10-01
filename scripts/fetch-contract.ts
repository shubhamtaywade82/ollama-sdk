#!/usr/bin/env tsx
/**
 * Fetch the latest upstream OpenAPI spec and write it to
 * contracts/sources/ollama.openapi.yaml.
 *
 * This is the only step in the contract pipeline that hits the network; all
 * other steps (`contract:normalize`, `contract:validate`, `contract:diff`)
 * operate on already-pinned sources. Run this manually when bumping the
 * pinned Ollama version, then commit the result.
 *
 * Usage:
 *   npm run contract:fetch                       # fetch from default URL
 *   npm run contract:fetch -- --url <URL>        # fetch from a custom URL
 *   npm run contract:fetch -- --pin <git-sha>    # record a pin SHA in the file header
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const OUTPUT_PATH = resolve(PROJECT_ROOT, 'contracts/sources/ollama.openapi.yaml');
const DEFAULT_URL = 'https://raw.githubusercontent.com/ollama/ollama/main/docs/openapi.yaml';

interface Args {
  url: string;
  pin?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') {
      const value = argv[i + 1];
      if (!value) throw new Error('--url requires a value');
      args.url = value;
      i += 1;
    } else if (arg === '--pin') {
      const value = argv[i + 1];
      if (!value) throw new Error('--pin requires a value');
      args.pin = value;
      i += 1;
    }
  }
  return args;
}

async function fetchUpstream(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return await response.text();
}

function pinHeader(url: string, pin: string | undefined, body: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const upstream = url;
  const sha = pin ?? 'unknown';
  const bodyHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return [
    `<!-- Pinned from ${upstream} (source SHA: ${sha}, content hash: ${bodyHash}) on ${today}. -->`,
    `<!-- Run \`npm run contract:fetch\` to refresh. -->`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Fetching upstream OpenAPI from ${args.url} ...`);
  const body = await fetchUpstream(args.url);
  const header = pinHeader(args.url, args.pin, body);
  writeFileSync(OUTPUT_PATH, header + body + '\n', 'utf8');
  console.log(`✓ Wrote ${OUTPUT_PATH}`);
  console.log(`  Next: npm run contract:normalize && npm run contract:diff`);
}

main().catch((error: unknown) => {
  console.error('contract:fetch FAILED:');
  console.error(error);
  process.exitCode = 1;
});
