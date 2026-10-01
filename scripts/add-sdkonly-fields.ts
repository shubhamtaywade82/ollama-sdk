#!/usr/bin/env tsx
/**
 * Wave 7 drift-triage: add the 19 missing sdkOnlyFields declarations to the
 * overlay parity blocks, so the drift detector treats them as expected drift
 * rather than unexpected findings.
 *
 * Each field is an SDK-local field that exists in src/types.ts but is NOT in
 * the OpenAPI snapshot (contracts/sources/ollama.openapi.yaml). They're
 * either:
 *   - experimental (image-generation: width, height, steps, image, completed, total)
 *   - deprecated (modelfile, context)
 *   - documented elsewhere but missing from OpenAPI (adapters, template, system, messages)
 *
 * This is a one-shot migration. After running it, `npm run contract:drift`
 * should report 0 unexpected drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

interface SdkOnlyAddition {
  readonly overlay: 'native' | 'openai' | 'anthropic';
  /** Operation key in the overlay (e.g. `chat`). */
  readonly opKey: string;
  /** Which parity side — `request` or `response`. */
  readonly side: 'request' | 'response';
  /** Schema name in the OpenAPI (e.g. `ChatRequest`). */
  readonly schemaName: string;
  /** Fields to declare as sdkOnlyFields. */
  readonly fields: readonly string[];
}

const additions: readonly SdkOnlyAddition[] = [
  // ChatRequestOptions: width, height, steps (experimental image-gen)
  {
    overlay: 'native',
    opKey: 'chat',
    side: 'request',
    schemaName: 'ChatRequest',
    fields: ['width', 'height', 'steps'],
  },
  // GenerateRequestOptions: context, width, height, steps, template
  {
    overlay: 'native',
    opKey: 'generate',
    side: 'request',
    schemaName: 'GenerateRequest',
    fields: ['context', 'width', 'height', 'steps', 'template'],
  },
  // GenerateResponse: completed, context, image, total
  {
    overlay: 'native',
    opKey: 'generate',
    side: 'response',
    schemaName: 'GenerateResponse',
    fields: ['completed', 'context', 'image', 'total'],
  },
  // CreateRequestOptions: adapters, modelfile
  {
    overlay: 'native',
    opKey: 'create',
    side: 'request',
    schemaName: 'CreateRequest',
    fields: ['adapters', 'modelfile'],
  },
  // ShowRequestOptions: system, template
  {
    overlay: 'native',
    opKey: 'show',
    side: 'request',
    schemaName: 'ShowRequest',
    fields: ['system', 'template'],
  },
  // ShowResponse: messages, modelfile, system
  {
    overlay: 'native',
    opKey: 'show',
    side: 'response',
    schemaName: 'ShowResponse',
    fields: ['messages', 'modelfile', 'system'],
  },
];

function applyAddition(yaml: string, addition: SdkOnlyAddition): string {
  // Find the operation block: `  <opKey>:` at column 2.
  const opPattern = new RegExp(`^  ${addition.opKey}:\\s*$`, 'm');
  const opMatch = opPattern.exec(yaml);
  if (!opMatch) {
    throw new Error(`Operation ${addition.opKey} not found in ${addition.overlay}.yaml`);
  }
  // Find the next operation OR `parityBridge:` after this one (block boundary).
  const afterOp = yaml.slice(opMatch.index + opMatch[0].length);
  const nextOpMatch = /^ {2}[A-Za-z][A-Za-z0-9_]*:\s*$/m.exec(afterOp);
  const bridgeMatch = /^parityBridge:/m.exec(afterOp);
  const boundaries: number[] = [nextOpMatch?.index ?? Infinity, bridgeMatch?.index ?? Infinity];
  const blockEnd = Math.min(...boundaries.filter((v) => v !== Infinity));
  const blockEndAbs =
    opMatch.index + opMatch[0].length + (blockEnd === Infinity ? afterOp.length : blockEnd);

  // Within [opMatch.index, blockEndAbs), find `      <side>:`
  const blockSlice = yaml.slice(opMatch.index, blockEndAbs);
  const sidePattern = new RegExp(`^(      ${addition.side}:\\s*)$`, 'm');
  const sideMatch = sidePattern.exec(blockSlice);
  if (!sideMatch) {
    throw new Error(
      `${addition.side}: block not found under ${addition.opKey} in ${addition.overlay}.yaml`,
    );
  }
  const sideAbsOffset = opMatch.index + sideMatch.index + sideMatch[0].length;

  // Find the `fields:` block under this side.
  const afterSide = yaml.slice(sideAbsOffset, blockEndAbs);
  const fieldsMatch = /^ {8}fields:\s*$/m.exec(afterSide);
  if (!fieldsMatch) {
    // Maybe fields is inline like `fields: []`
    throw new Error(`fields: not found under ${addition.opKey}.${addition.side}`);
  }
  const fieldsAbs = sideAbsOffset + fieldsMatch.index;

  // Find the end of the fields list. The list items look like `          - 'field'`.
  // Skip past the `        fields:` line, then consume consecutive item lines.
  const linesAfterFields = yaml.slice(fieldsAbs).split('\n');
  let consumedLines = 1; // the `fields:` line
  while (consumedLines < linesAfterFields.length) {
    const line = linesAfterFields[consumedLines];
    if (line === undefined) break;
    if (/^ {10}- /.test(line)) {
      consumedLines += 1;
    } else {
      break;
    }
  }
  // Position in yaml right after the last fields item.
  const insertionOffset =
    fieldsAbs + linesAfterFields.slice(0, consumedLines).join('\n').length + 1; // +1 for trailing \n

  // Check if sdkOnlyFields is already there
  const blockAfter = yaml.slice(insertionOffset, insertionOffset + 200);
  if (blockAfter.includes('sdkOnlyFields:')) {
    return yaml; // idempotent
  }

  const fieldsYaml =
    `        sdkOnlyFields:\n` + addition.fields.map((f) => `          - '${f}'`).join('\n') + '\n';
  return yaml.slice(0, insertionOffset) + fieldsYaml + yaml.slice(insertionOffset);
}

function main(): void {
  const byOverlay: Record<string, SdkOnlyAddition[]> = {
    native: [],
    openai: [],
    anthropic: [],
  };
  for (const a of additions) {
    const bucket = byOverlay[a.overlay];
    if (!bucket) continue;
    bucket.push(a);
  }

  for (const overlay of ['native', 'openai', 'anthropic'] as const) {
    const path = resolve(PROJECT_ROOT, `contracts/overlays/${overlay}.yaml`);
    let yaml = readFileSync(path, 'utf8');
    const list = byOverlay[overlay];
    if (!list || list.length === 0) continue;
    for (const addition of list) {
      yaml = applyAddition(yaml, addition);
      console.log(
        `✓ ${overlay}.yaml / ${addition.opKey}.${addition.side}: added sdkOnlyFields [${addition.fields.join(', ')}]`,
      );
    }
    writeFileSync(path, yaml, 'utf8');
  }
}

main();
