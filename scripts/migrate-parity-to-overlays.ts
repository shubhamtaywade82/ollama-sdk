#!/usr/bin/env tsx
/**
 * One-shot migration helper: reads `docs/api-parity.json` and emits
 * `parity:` blocks for each overlay file. Output is written to stdout
 * so it can be inspected and pasted into the overlay YAMLs manually.
 *
 * Usage:
 *   npx tsx scripts/migrate-parity-to-overlays.ts
 *
 * This is a one-time Wave 5 migration tool. After the overlay YAMLs
 * carry `parity:` blocks, the legacy manifest can be retired.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(PROJECT_ROOT, 'docs/api-parity.json');

interface Surface {
  readonly id: string;
  readonly docsUrl: string;
  readonly fallbackDocsFile?: string;
  readonly sourceFile?: string;
  readonly interfaceName?: string;
  readonly endpoint: string;
  readonly fields: readonly string[];
  readonly unsupportedFields?: readonly string[];
  readonly sdkOnlyFields?: readonly string[];
  readonly nestedUnsupportedFields?: readonly string[];
  readonly docAliases?: Readonly<Record<string, readonly string[]>>;
  readonly featureAliases?: Readonly<Record<string, readonly string[]>>;
  readonly response?: {
    readonly sourceFile: string;
    readonly interfaceName: string;
    readonly fields: readonly string[];
    readonly sdkOnlyFields?: readonly string[];
  };
  readonly stream?: {
    readonly sourceFile: string;
    readonly unionName: string;
    readonly interfaceNames: readonly string[];
    readonly eventTypes?: readonly string[];
  };
}

function yamlStringArray(arr: readonly string[] | undefined, indent: string): string {
  if (!arr || arr.length === 0) return '[]';
  return arr.map((s) => `${indent}- ${JSON.stringify(s)}`).join('\n');
}

function yamlStringMap(
  map: Readonly<Record<string, readonly string[]>> | undefined,
  indent: string,
): string {
  if (!map || Object.keys(map).length === 0) return '{}';
  return Object.entries(map)
    .map(
      ([k, v]) => `${indent}${JSON.stringify(k)}: [${v.map((s) => JSON.stringify(s)).join(', ')}]`,
    )
    .join('\n');
}

function emitParityBlock(surface: Surface): string {
  const lines: string[] = [];
  lines.push(`    parity:`);
  lines.push(`      legacySurfaceId: ${JSON.stringify(surface.id)}`);
  lines.push(`      docsUrl: ${JSON.stringify(surface.docsUrl)}`);
  if (surface.fallbackDocsFile) {
    lines.push(`      fallbackDocsFile: ${JSON.stringify(surface.fallbackDocsFile)}`);
  }
  lines.push(`      request:`);
  if (surface.sourceFile && surface.interfaceName) {
    lines.push(`        interfaceName: ${JSON.stringify(surface.interfaceName)}`);
    lines.push(`        sourceFile: ${JSON.stringify(surface.sourceFile)}`);
  }
  lines.push(`        fields:`);
  lines.push(yamlStringArray(surface.fields, '          '));
  if (surface.unsupportedFields && surface.unsupportedFields.length > 0) {
    lines.push(`        unsupportedFields:`);
    lines.push(yamlStringArray(surface.unsupportedFields, '          '));
  }
  if (surface.sdkOnlyFields && surface.sdkOnlyFields.length > 0) {
    lines.push(`        sdkOnlyFields:`);
    lines.push(yamlStringArray(surface.sdkOnlyFields, '          '));
  }
  if (surface.nestedUnsupportedFields && surface.nestedUnsupportedFields.length > 0) {
    lines.push(`        nestedUnsupportedFields:`);
    lines.push(yamlStringArray(surface.nestedUnsupportedFields, '          '));
  }
  if (surface.docAliases && Object.keys(surface.docAliases).length > 0) {
    lines.push(`        docAliases:`);
    lines.push(yamlStringMap(surface.docAliases, '          '));
  }
  if (surface.featureAliases && Object.keys(surface.featureAliases).length > 0) {
    lines.push(`        featureAliases:`);
    lines.push(yamlStringMap(surface.featureAliases, '          '));
  }
  if (surface.response) {
    lines.push(`      response:`);
    lines.push(`        interfaceName: ${JSON.stringify(surface.response.interfaceName)}`);
    lines.push(`        sourceFile: ${JSON.stringify(surface.response.sourceFile)}`);
    lines.push(`        fields:`);
    lines.push(yamlStringArray(surface.response.fields, '          '));
    if (surface.response.sdkOnlyFields && surface.response.sdkOnlyFields.length > 0) {
      lines.push(`        sdkOnlyFields:`);
      lines.push(yamlStringArray(surface.response.sdkOnlyFields, '          '));
    }
  }
  if (surface.stream) {
    lines.push(`      stream:`);
    lines.push(`        unionName: ${JSON.stringify(surface.stream.unionName)}`);
    lines.push(`        interfaceNames:`);
    lines.push(yamlStringArray(surface.stream.interfaceNames, '          '));
    if (surface.stream.eventTypes && surface.stream.eventTypes.length > 0) {
      lines.push(`        eventTypes:`);
      lines.push(yamlStringArray(surface.stream.eventTypes, '          '));
    }
  }
  return lines.join('\n');
}

function main(): void {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    surfaces: readonly Surface[];
  };

  // Group surfaces by their overlay file (native.yaml / openai.yaml / anthropic.yaml).
  const byOverlay: Record<string, { key: string; surface: Surface }[]> = {
    native: [],
    openai: [],
    anthropic: [],
  };

  for (const surface of manifest.surfaces) {
    const id = surface.id;
    let overlay: 'native' | 'openai' | 'anthropic';
    let key: string;
    if (id.startsWith('native-')) {
      overlay = 'native';
      key = id.replace('native-', '');
    } else if (id.startsWith('openai-')) {
      overlay = 'openai';
      key = id.replace('openai-', '');
    } else if (id.startsWith('anthropic-')) {
      overlay = 'anthropic';
      key = id.replace('anthropic-', '');
    } else {
      continue;
    }
    const bucket = byOverlay[overlay];
    if (!bucket) continue;
    bucket.push({ key, surface });
  }

  for (const overlay of ['native', 'openai', 'anthropic'] as const) {
    console.log(`\n# === ${overlay}.yaml additions ===\n`);
    const entries = byOverlay[overlay];
    if (!entries) continue;
    for (const { key, surface } of entries) {
      console.log(`# Appended under operations.${key}:`);
      console.log(emitParityBlock(surface));
      console.log('');
    }
  }
}

main();
