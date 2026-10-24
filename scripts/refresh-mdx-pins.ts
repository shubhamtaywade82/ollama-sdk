#!/usr/bin/env tsx
/**
 * Refresh the upstream MDX documentation pins from the live
 * docs.ollama.com markdown twins, following the 2026-10-22 openapi re-pin
 * discipline (ADR 0036), the 2026-10-23 mdx provenance design (ADR 0038)
 * and the upstream drift watch (ADR 0039): verbatim content (base64 payloads
 * elided per the standing convention), header carrying the upstream source
 * SHA + fetch date, mirrored into docs-index.json so
 * test/contract/pin-consistency.test.ts can assert freshness.
 *
 * The pins are the docs-index.json sources of kind `mdx`. Each source SHA is
 * the latest upstream commit touching the source's `upstreamPath`.
 *
 * Usage:
 *   npx tsx scripts/refresh-mdx-pins.ts                  # refresh every mdx pin
 *   npx tsx scripts/refresh-mdx-pins.ts --only <id>[,…]  # refresh only these docs-index ids
 *
 * Review and commit the result.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  latestUpstreamCommit,
  readDocsIndex,
  writePinToDocsIndex,
  type UpstreamCommit,
} from './upstream-drift.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const OPENAI_PIN = 'docs/upstream/ollama-openai-compatibility.mdx';
const ANTHROPIC_PIN = 'docs/upstream/ollama-anthropic-compatibility.mdx';

interface MdxPin {
  readonly id: string;
  readonly file: string;
  readonly url: string;
  readonly upstreamPath: string;
}

function mdxPins(only: readonly string[] | undefined): MdxPin[] {
  return readDocsIndex()
    .sources.filter((source) => source.kind === 'mdx' && (!only || only.includes(source.id)))
    .map((source) => {
      if (!source.path || !source.upstream || !source.upstreamPath) {
        throw new Error(
          `docs-index mdx source "${source.id}" needs path, upstream and upstreamPath`,
        );
      }
      return {
        id: source.id,
        file: source.path,
        url: `${source.upstream}.md`,
        upstreamPath: source.upstreamPath,
      };
    });
}

function elideBase64(text: string): string {
  // Inline base64 image payloads are elided (established pin convention) —
  // they are payload bulk, not contract content.
  return text.replace(/data:(image\/[a-z+]+);base64,[A-Za-z0-9+/=]+/g, 'data:$1;base64,<elided>');
}

function header(pin: MdxPin, commit: UpstreamCommit, date: string): string {
  return [
    '<!--',
    `Pinned from ${pin.url} on ${date} (source SHA: ${commit.sha}).`,
    'Offline fallback for scripts/verify-contract-parity.ts. Fetched as markdown so the',
    '`[x]` / `[ ]` checkbox state (supported vs explicitly unsupported) is preserved.',
    `The source SHA is the last upstream commit touching ollama/ollama ${pin.upstreamPath};`,
    `the rendered twin differs from that source in site plumbing only (it prefixes the`,
    "site's llms.txt index preamble, unwraps Mintlify CodeGroup components, and appends",
    '`.md` to internal doc links) — all parse-neutral for parity verification and',
    `endpoint discovery. Refreshed to upstream ${commit.sha.slice(0, 7)} (${commit.subject}).`,
    'Inline base64 image payloads are elided.',
    '-->',
    '',
  ].join('\n');
}

async function fetchTwin(pin: MdxPin): Promise<string> {
  const response = await fetch(pin.url, {
    headers: { Accept: 'text/markdown, text/plain' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`fetch ${pin.url}: HTTP ${response.status}`);
  const twin = await response.text();
  if (!twin.includes('/v1/')) {
    throw new Error(`${pin.url}: fetched body has no /v1/ headings — wrong content served?`);
  }
  return twin;
}

async function refreshPin(pin: MdxPin, date: string): Promise<void> {
  const commit = await latestUpstreamCommit(pin.upstreamPath);
  const twin = await fetchTwin(pin);
  writeFileSync(
    resolve(PROJECT_ROOT, pin.file),
    header(pin, commit, date) + elideBase64(twin),
    'utf8',
  );
  writePinToDocsIndex(pin.id, commit.sha, date);
  console.log(`✓ ${pin.file} (pin ${commit.sha.slice(0, 7)}, ${date})`);
  console.log(
    `  base64 elided: ${(twin.match(/base64,[A-Za-z0-9+/]{40,}/g) ?? []).length} payload(s)`,
  );
}

// Standing invariants of the pinned content, checked after every refresh.
// A failure means upstream changed something the contract relies on — review
// it rather than silencing the marker.
function checkContentMarkers(): boolean {
  const openaiPin = readFileSync(resolve(PROJECT_ROOT, OPENAI_PIN), 'utf8');
  const anthropicPin = readFileSync(resolve(PROJECT_ROOT, ANTHROPIC_PIN), 'utf8');
  const markers: readonly (readonly [string, boolean])[] = [
    ['openai pin documents /v1/audio/speech', openaiPin.includes('`/v1/audio/speech`')],
    [
      'openai pin documents the speech field matrix',
      openaiPin.includes('`stream_format`') && openaiPin.includes('`Freya`'),
    ],
    ['openai pin keeps the chat completions matrix', openaiPin.includes('`reasoning_effort`')],
    [
      'anthropic pin dropped the model-recs list',
      !anthropicPin.includes('Excellent for coding tasks'),
    ],
    ['anthropic pin keeps the /v1/messages surface', anthropicPin.includes('/v1/messages')],
    [
      'no raw base64 left in either pin',
      !openaiPin.includes('base64,iVBOR') && !anthropicPin.includes('base64,iVBOR'),
    ],
  ];
  for (const [name, pass] of markers) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  return markers.every(([, pass]) => pass);
}

function parseOnly(argv: readonly string[]): string[] | undefined {
  const index = argv.indexOf('--only');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error('--only requires a comma-separated list of docs-index ids');
  return value.split(',');
}

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const pins = mdxPins(parseOnly(process.argv.slice(2)));
  if (pins.length === 0) throw new Error('No mdx pins matched --only');
  for (const pin of pins) await refreshPin(pin, date);
  if (!checkContentMarkers()) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('refresh-mdx-pins FAILED:');
  console.error(error);
  process.exitCode = 1;
});
