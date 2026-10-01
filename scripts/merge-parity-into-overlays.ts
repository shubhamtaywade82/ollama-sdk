#!/usr/bin/env tsx
/**
 * Wave 5 migration: append `parity:` blocks to each overlay YAML file
 * based on the legacy `docs/api-parity.json` manifest. The blocks are
 * inserted under each operation's existing block.
 *
 * This is a one-time migration. After running this, the overlays carry
 * their own parity data and `docs/api-parity.json` can be retired.
 *
 * Usage:
 *   npx tsx scripts/merge-parity-into-overlays.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
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

function yamlStringArray(arr: readonly string[] | undefined, level: number): string {
  if (!arr || arr.length === 0) return '[]';
  const pad = ' '.repeat(level);
  return '\n' + arr.map((s) => `${pad}- ${JSON.stringify(s)}`).join('\n');
}

function yamlStringMap(
  map: Readonly<Record<string, readonly string[]>> | undefined,
  level: number,
): string {
  if (!map || Object.keys(map).length === 0) return '{}';
  const pad = ' '.repeat(level);
  return (
    '\n' +
    Object.entries(map)
      .map(
        ([k, v]) => `${pad}${JSON.stringify(k)}: [${v.map((s) => JSON.stringify(s)).join(', ')}]`,
      )
      .join('\n')
  );
}

function emitParityBlock(surface: Surface): string {
  // Indented at 4 spaces (operation body), parity: key at 4 spaces,
  // sub-keys at 6, leaves at 8+.
  const lines: string[] = [];
  lines.push(`    parity:`);
  lines.push(`      legacySurfaceId: ${JSON.stringify(surface.id)}`);
  lines.push(`      docsUrl: ${JSON.stringify(surface.docsUrl)}`);
  if (surface.fallbackDocsFile) {
    lines.push(`      fallbackDocsFile: ${JSON.stringify(surface.fallbackDocsFile)}`);
  }
  // Request
  lines.push(`      request:`);
  if (surface.sourceFile && surface.interfaceName) {
    lines.push(`        interfaceName: ${JSON.stringify(surface.interfaceName)}`);
    lines.push(`        sourceFile: ${JSON.stringify(surface.sourceFile)}`);
  }
  lines.push(`        fields:${yamlStringArray(surface.fields, 10)}`);
  if (surface.unsupportedFields && surface.unsupportedFields.length > 0) {
    lines.push(`        unsupportedFields:${yamlStringArray(surface.unsupportedFields, 10)}`);
  }
  if (surface.sdkOnlyFields && surface.sdkOnlyFields.length > 0) {
    lines.push(`        sdkOnlyFields:${yamlStringArray(surface.sdkOnlyFields, 10)}`);
  }
  if (surface.nestedUnsupportedFields && surface.nestedUnsupportedFields.length > 0) {
    lines.push(
      `        nestedUnsupportedFields:${yamlStringArray(surface.nestedUnsupportedFields, 10)}`,
    );
  }
  if (surface.docAliases && Object.keys(surface.docAliases).length > 0) {
    lines.push(`        docAliases:${yamlStringMap(surface.docAliases, 10)}`);
  }
  if (surface.featureAliases && Object.keys(surface.featureAliases).length > 0) {
    lines.push(`        featureAliases:${yamlStringMap(surface.featureAliases, 10)}`);
  }
  if (surface.response) {
    lines.push(`      response:`);
    lines.push(`        interfaceName: ${JSON.stringify(surface.response.interfaceName)}`);
    lines.push(`        sourceFile: ${JSON.stringify(surface.response.sourceFile)}`);
    lines.push(`        fields:${yamlStringArray(surface.response.fields, 10)}`);
    if (surface.response.sdkOnlyFields && surface.response.sdkOnlyFields.length > 0) {
      lines.push(`        sdkOnlyFields:${yamlStringArray(surface.response.sdkOnlyFields, 10)}`);
    }
  }
  if (surface.stream) {
    lines.push(`      stream:`);
    lines.push(`        unionName: ${JSON.stringify(surface.stream.unionName)}`);
    lines.push(`        interfaceNames:${yamlStringArray(surface.stream.interfaceNames, 10)}`);
    if (surface.stream.eventTypes && surface.stream.eventTypes.length > 0) {
      lines.push(`        eventTypes:${yamlStringArray(surface.stream.eventTypes, 10)}`);
    }
  }
  return lines.join('\n');
}

/** Find the position immediately after an operation's block in a YAML file. */
function findOperationInsertionPoint(
  yaml: string,
  opKey: string,
): { start: number; end: number } | undefined {
  // Match `  <opKey>:` at the start of a line, then find the end of the block
  // (next operation at the same indent level, or `parityBridge:`/EOF).
  const opPattern = new RegExp(
    `^  ${opKey.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\s*$`,
    'm',
  );
  const opMatch = opPattern.exec(yaml);
  if (!opMatch) return undefined;
  const start = opMatch.index + opMatch[0].length;

  // Find the next sibling: either `  <otherOp>:` at column 2, or
  // `parityBridge:` at column 0, or EOF.
  const nextSibling = /^ {2}[A-Za-z][A-Za-z0-9_]*:\s*$/gm;
  nextSibling.lastIndex = start;
  let end = yaml.length;
  let m: RegExpExecArray | null;
  while ((m = nextSibling.exec(yaml)) !== null) {
    if (m.index > start) {
      end = m.index;
      break;
    }
  }
  // Also check for parityBridge: at column 0
  const bridgeMatch = /^parityBridge:/m.exec(yaml);
  if (bridgeMatch && bridgeMatch.index > start && bridgeMatch.index < end) {
    end = bridgeMatch.index;
  }
  return { start, end };
}

function main(): void {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    surfaces: readonly Surface[];
  };

  // Map legacy surface ids to overlay operation keys. The native overlay uses
  // short names (`chat`, `generate`); the openai and anthropic overlays use
  // longer PascalCase-ish keys (`openaiChatCompletions`, `anthropicMessages`)
  // because the shorter names (`chat`, `messages`) collide with native names.
  const overlayKeyMap: Record<string, Record<string, string>> = {
    native: {
      'native-chat': 'chat',
      'native-generate': 'generate',
      'native-embed': 'embed',
      'native-create': 'create',
      'native-delete': 'delete',
      'native-push': 'push',
      'native-pull': 'pull',
      'native-copy': 'copy',
      'native-show': 'show',
      'native-tags': 'tags',
      'native-ps': 'ps',
      'native-version': 'version',
    },
    openai: {
      'openai-chat': 'openaiChatCompletions',
      'openai-completions': 'openaiCompletions',
      'openai-embeddings': 'openaiEmbeddings',
      'openai-responses': 'openaiResponses',
    },
    anthropic: {
      'anthropic-messages': 'anthropicMessages',
    },
  };

  for (const overlayFile of ['native', 'openai', 'anthropic'] as const) {
    const overlayPath = resolve(PROJECT_ROOT, `contracts/overlays/${overlayFile}.yaml`);
    let yaml = readFileSync(overlayPath, 'utf8');

    const keyMap = overlayKeyMap[overlayFile];
    if (!keyMap) continue;
    for (const surface of manifest.surfaces) {
      const key = keyMap[surface.id];
      if (!key) continue;

      const insertion = findOperationInsertionPoint(yaml, key);
      if (!insertion) {
        console.warn(`WARN: operation ${key} not found in ${overlayFile}.yaml — skipping`);
        continue;
      }

      const block = yaml.slice(insertion.start, insertion.end);
      if (block.includes('parity:')) {
        console.log(`✓ ${overlayFile}.yaml / ${key}: parity already present, skipping`);
        continue;
      }

      const parityBlock = '\n' + emitParityBlock(surface) + '\n';
      yaml = yaml.slice(0, insertion.end) + parityBlock + yaml.slice(insertion.end);
      console.log(`✓ ${overlayFile}.yaml / ${key}: parity appended`);
    }

    writeFileSync(overlayPath, yaml, 'utf8');
    console.log(`Wrote ${overlayPath}\n`);
  }
}

main();
