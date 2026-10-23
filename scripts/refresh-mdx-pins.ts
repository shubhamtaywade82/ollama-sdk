#!/usr/bin/env tsx
/**
 * Refresh the two upstream MDX documentation pins from the live
 * docs.ollama.com markdown twins, following the 2026-10-22 openapi re-pin
 * discipline (ADR 0036) and the 2026-10-23 mdx provenance design (ADR 0038):
 * verbatim content (base64 payloads elided per the standing convention),
 * header carrying the upstream source SHA + fetch date so docs-index.json
 * and test/contract/pin-consistency.test.ts can assert freshness.
 *
 * Source SHAs are the last upstream commits touching the repo MDX files:
 *   openai:     6ef847b8fef4fef0e8d48a66517887d3b2fdbe21 (2026-10-22, Phonon TTS docs)
 *   anthropic:  33a3afa604b4e5c90263f006d979bc433d39c38d (2026-10-13, model-recs link)
 *
 * Run manually when refreshing the pins; commit the result.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

interface MdxPin {
  readonly file: string;
  readonly url: string;
  readonly sourcePath: string;
  readonly sha: string;
  readonly refreshNote: string;
}

const PINS: readonly MdxPin[] = [
  {
    file: 'docs/upstream/ollama-openai-compatibility.mdx',
    url: 'https://docs.ollama.com/api/openai-compatibility.md',
    sourcePath: 'ollama/ollama docs/api/openai-compatibility.mdx',
    sha: '6ef847b8fef4fef0e8d48a66517887d3b2fdbe21',
    refreshNote:
      'The 2026-10-23 refresh picks up upstream 6ef847b8 (Phonon text-to-speech): the page gains the /v1/audio/speech section (Ollama v0.40.8+, wav/pcm, 16-bit mono 24 kHz) with its supported/unsupported request-field matrix.',
  },
  {
    file: 'docs/upstream/ollama-anthropic-compatibility.mdx',
    url: 'https://docs.ollama.com/api/anthropic-compatibility.md',
    sourcePath: 'ollama/ollama docs/api/anthropic-compatibility.mdx',
    sha: '33a3afa604b4e5c90263f006d979bc433d39c38d',
    refreshNote:
      'The 2026-10-23 refresh picks up upstream 33a3afa6 (2026-10-13, two days after the previous pin): the "Recommended local models" list is replaced by a link to the Models page; compatibility tables are unchanged.',
  },
];
const PIN_DATE = '2026-10-23';

function elideBase64(text: string): string {
  // Inline base64 image payloads are elided (established pin convention) —
  // they are payload bulk, not contract content.
  return text.replace(/data:(image\/[a-z+]+);base64,[A-Za-z0-9+/=]+/g, 'data:$1;base64,<elided>');
}

function header(pin: MdxPin): string {
  return [
    '<!--',
    `Pinned from ${pin.url} on ${PIN_DATE} (source SHA: ${pin.sha}).`,
    'Offline fallback for scripts/verify-contract-parity.ts. Fetched as markdown so the',
    '`[x]` / `[ ]` checkbox state (supported vs explicitly unsupported) is preserved.',
    `The source SHA is the last upstream commit touching ${pin.sourcePath};`,
    `the rendered twin differs from that source in site plumbing only (it prefixes the`,
    "site's llms.txt index preamble, unwraps Mintlify CodeGroup components, and appends",
    '`.md` to internal doc links) — all parse-neutral for parity verification and',
    `endpoint discovery. ${pin.refreshNote}`,
    'Inline base64 image payloads are elided.',
    '-->',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  for (const pin of PINS) {
    const response = await fetch(pin.url, {
      headers: { Accept: 'text/markdown, text/plain' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`fetch ${pin.url}: HTTP ${response.status}`);
    const twin = await response.text();
    if (!twin.includes('/v1/')) {
      throw new Error(`${pin.url}: fetched body has no /v1/ headings — wrong content served?`);
    }
    const body = elideBase64(twin);
    const outPath = resolve(PROJECT_ROOT, pin.file);
    writeFileSync(outPath, header(pin) + body, 'utf8');
    const written = readFileSync(outPath, 'utf8');
    console.log(`✓ ${pin.file} (${written.length} chars)`);
    console.log(`  header SHA: ${pin.sha} | date: ${PIN_DATE}`);
    console.log(`  base64 elided: ${(twin.match(/base64,[A-Za-z0-9+/]{40,}/g) ?? []).length} payload(s)`);
  }

  // Post-write content markers (the audit's missed drift must be IN the pin).
  const openaiPin = readFileSync(resolve(PROJECT_ROOT, PINS[0]?.file ?? ''), 'utf8');
  const anthropicPin = readFileSync(resolve(PROJECT_ROOT, PINS[1]?.file ?? ''), 'utf8');
  const markers: readonly (readonly [string, boolean])[] = [
    ['openai pin documents /v1/audio/speech', openaiPin.includes('`/v1/audio/speech`')],
    [
      'openai pin documents the speech field matrix',
      openaiPin.includes('`stream_format`') && openaiPin.includes('`Freya`'),
    ],
    ['openai pin keeps the chat completions matrix', openaiPin.includes('`reasoning_effort`')],
    ['anthropic pin dropped the model-recs list', !anthropicPin.includes('Excellent for coding tasks')],
    ['anthropic pin keeps the /v1/messages surface', anthropicPin.includes('/v1/messages')],
    [
      'no raw base64 left in either pin',
      !openaiPin.includes('base64,iVBOR') && !anthropicPin.includes('base64,iVBOR'),
    ],
  ];
  let ok = true;
  for (const [name, pass] of markers) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) ok = false;
  }
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('refresh-mdx-pins FAILED:');
  console.error(error);
  process.exitCode = 1;
});
