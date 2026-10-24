#!/usr/bin/env tsx
/**
 * Re-pin the upstream OpenAPI spec (ADR 0039).
 *
 * Writes two files:
 *   - docs/upstream/ollama-openapi.yaml — the verbatim upstream body.
 *   - contracts/sources/ollama.openapi.yaml — the contract source: the
 *     curated narrative header (pin date/SHA rewritten, a refresh note
 *     appended) over the upstream body with CURATED_DEVIATIONS re-applied.
 * and records the new pin in contracts/sources/docs-index.json.
 *
 * This is the only step in the contract pipeline that hits the network; all
 * other steps operate on already-pinned sources. Run it when bumping the
 * pinned Ollama version (or let the upstream-watch workflow do it), then
 * review and commit the result.
 *
 * Usage:
 *   npm run contract:fetch                    # pin the latest upstream commit touching the spec
 *   npm run contract:fetch -- --ref <sha>     # pin a specific upstream commit
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  findUpstreamDrift,
  latestUpstreamCommit,
  readDocsIndex,
  writePinToDocsIndex,
  type UpstreamCommit,
} from './upstream-drift.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const CONTRACT_PATH = resolve(PROJECT_ROOT, 'contracts/sources/ollama.openapi.yaml');
const VERBATIM_PATH = resolve(PROJECT_ROOT, 'docs/upstream/ollama-openapi.yaml');
const UPSTREAM_PATH = 'docs/openapi.yaml';
const PIN_HEADER_PATTERN = /on \d{4}-\d{2}-\d{2} \(source SHA: [0-9a-f]{40}\)/;

interface CuratedDeviation {
  readonly name: string;
  readonly find: string;
  readonly replace: string;
}

// Every intentional difference between the contract source and upstream.
// A re-pin must re-apply each one or prove upstream adopted it — never drop
// one silently.
export const CURATED_DEVIATIONS: readonly CuratedDeviation[] = [
  {
    // The server serializes a nil Go slice as JSON null for models without
    // family metadata; a strict array schema would reject real /api/tags responses.
    name: 'ModelSummary.details.families accepts null',
    find: '            families:\n              type: array\n',
    replace:
      "            families:\n              type:\n                - array\n                - 'null'\n",
  },
];

function occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

/** Upstream body → contract body with every curated deviation applied (throws if one cannot be). */
export function applyCuratedDeviations(
  body: string,
  deviations: readonly CuratedDeviation[] = CURATED_DEVIATIONS,
): string {
  let patched = body;
  for (const deviation of deviations) {
    const findCount = occurrences(patched, deviation.find);
    if (findCount === 1) {
      patched = patched.replace(deviation.find, deviation.replace);
    } else if (findCount === 0 && occurrences(patched, deviation.replace) === 1) {
      console.log(`  deviation retired (upstream adopted it): ${deviation.name}`);
    } else {
      throw new Error(
        `Cannot re-apply curated deviation "${deviation.name}": anchor found ${findCount} time(s). Update CURATED_DEVIATIONS.`,
      );
    }
  }
  return patched;
}

function refreshNote(date: string, sha: string, commits: readonly UpstreamCommit[]): string {
  const brought = commits.length
    ? commits.map((commit) => `${commit.sha.slice(0, 7)} (${commit.subject})`).join('; ')
    : `no upstream commits touching ${UPSTREAM_PATH} since the previous pin`;
  return ` The ${date} auto-refresh (source SHA: ${sha}) brings in: ${brought}.`;
}

/** Curated header line with the pin date/SHA rewritten and a refresh note appended. */
export function rewriteCuratedHeader(
  headerLine: string,
  date: string,
  sha: string,
  commits: readonly UpstreamCommit[],
): string {
  if (!PIN_HEADER_PATTERN.test(headerLine)) {
    throw new Error('Curated openapi header line has no "on <date> (source SHA: <sha>)" anchor');
  }
  return (
    headerLine.replace(PIN_HEADER_PATTERN, `on ${date} (source SHA: ${sha})`) +
    refreshNote(date, sha, commits)
  );
}

function verbatimHeader(url: string, sha: string, body: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const bodyHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  // YAML comments (`#`), NOT HTML comments: the file is parsed as YAML, and
  // an HTML comment containing `key: value` pairs hard-fails the parser.
  return [
    `# Pinned from ${url} (source SHA: ${sha}, content hash: ${bodyHash}) on ${today}.`,
    `# Run \`npm run contract:fetch\` to refresh.`,
    '',
  ].join('\n');
}

async function fetchUpstream(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return await response.text();
}

function parseRef(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--ref');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || !/^[0-9a-f]{40}$/.test(value))
    throw new Error('--ref requires a 40-hex commit SHA');
  return value;
}

async function commitsUpTo(sha: string): Promise<readonly UpstreamCommit[]> {
  const openapiSource = readDocsIndex().sources.find((source) => source.id === 'openapi');
  if (!openapiSource) throw new Error('docs-index.json has no openapi source');
  const [drift] = await findUpstreamDrift([openapiSource]);
  const commits = drift?.commits ?? [];
  const refIndex = commits.findIndex((commit) => commit.sha === sha);
  return refIndex === -1 ? commits : commits.slice(refIndex);
}

async function main(): Promise<void> {
  const sha = parseRef(process.argv.slice(2)) ?? (await latestUpstreamCommit(UPSTREAM_PATH)).sha;
  const today = new Date().toISOString().slice(0, 10);
  const url = `https://raw.githubusercontent.com/ollama/ollama/${sha}/${UPSTREAM_PATH}`;
  console.log(`Fetching upstream OpenAPI from ${url} ...`);
  const body = await fetchUpstream(url);
  writeFileSync(VERBATIM_PATH, verbatimHeader(url, sha, body) + body + '\n', 'utf8');
  console.log(`✓ Wrote ${VERBATIM_PATH}`);

  const [curatedHeader = ''] = readFileSync(CONTRACT_PATH, 'utf8').split('\n');
  const header = rewriteCuratedHeader(curatedHeader, today, sha, await commitsUpTo(sha));
  writeFileSync(CONTRACT_PATH, `${header}\n${applyCuratedDeviations(body)}\n`, 'utf8');
  writePinToDocsIndex('openapi', sha, today);
  console.log(`✓ Wrote ${CONTRACT_PATH} and docs-index.json (pin ${sha.slice(0, 7)}, ${today})`);
  console.log(
    `  Next: npm run contract:normalize && npm run contract:generate, then edit the header narrative`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('contract:fetch FAILED:');
    console.error(error);
    process.exitCode = 1;
  });
}
