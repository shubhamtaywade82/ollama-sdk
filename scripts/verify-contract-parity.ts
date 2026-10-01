#!/usr/bin/env tsx
/**
 * IR-driven parity verifier — the Wave 7 successor to `verify-api-parity.ts`.
 *
 * Replaces BOTH halves of the legacy verifier:
 *   1. The structural TypeScript half (was: `api-parity.json` ↔ `src/types.ts`)
 *   2. The live-docs half (was: `api-parity.json` ↔ docs.ollama.com)
 *
 * Now reads the canonical IR at `contracts/ir/ollama.ir.json` (which has
 * been compiled from overlay YAMLs that now carry their own `parity:`
 * blocks including `docsUrl`, `fallbackDocsFile`, and `docAliases`).
 *
 * For every operation with a `parity:` block, this verifier asserts:
 *
 *   STRUCTURAL (no network):
 *   1. Every `parity.request.fields` entry exists on the hand-written
 *      TypeScript interface named by `parity.request.interfaceName`.
 *   2. Same for `parity.response.fields`.
 *   3. Same for `parity.request.unsupportedFields` (these must be on the
 *      interface too — they're typed but ignored).
 *   4. Every `parity.stream.interfaceNames` entry is referenced by the
 *      TypeScript type alias `parity.stream.unionName`.
 *
 *   LIVE DOCS (network — cached within a single run):
 *   5. The endpoint documented by `parity.docsUrl` mentions the path.
 *   6. Every `parity.request.fields` entry is documented as supported.
 *   7. Every `parity.request.unsupportedFields` entry is explicitly marked
 *      unsupported by the docs.
 *   8. Every `parity.response.fields` entry is documented as supported.
 *   9. Every `parity.stream.eventTypes` entry is documented as supported.
 *
 * `sdkOnlyFields` are intentionally NOT checked against the docs — they're
 * an SDK-local affordance that may or may not appear in the docs.
 *
 * When the live docs are unreachable, the verifier falls back to the
 * pinned `fallbackDocsFile` (a committed snapshot under `docs/upstream/`).
 *
 * Run with `--skip-live-docs` to skip network calls (structural-only).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { OllamaContract } from '../generator/types.js';
import {
  fetchDocs,
  requestFieldSection,
  responseFieldSection,
  streamEventSection,
  unsupportedFieldSection,
  firstKnownStatus,
  docsMentionField,
  explicitlyUnsupported,
  nestedFieldName,
  supportedFeatureStatus,
} from '../generator/parser/docs-fetcher.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const IR_PATH = resolve(PROJECT_ROOT, 'contracts/ir/ollama.ir.json');

interface PropertySource {
  readonly sourceFile: string;
  readonly interfaceName: string;
  readonly properties: Set<string>;
}

function loadInterfaceProperties(sourceFile: string, interfaceName: string): PropertySource {
  const absolute = resolve(PROJECT_ROOT, sourceFile);
  const source = readFileSync(absolute, 'utf8');
  const file = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const properties = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue;
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
        properties.add(member.name.text);
      }
    }
  }
  return { sourceFile, interfaceName, properties };
}

function loadTypeAliasReferences(sourceFile: string, aliasName: string): Set<string> {
  const absolute = resolve(PROJECT_ROOT, sourceFile);
  const source = readFileSync(absolute, 'utf8');
  const file = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of file.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== aliasName) continue;
    if (!ts.isUnionTypeNode(statement.type)) return new Set();
    return new Set(
      statement.type.types.flatMap((member) =>
        ts.isTypeReferenceNode(member) && ts.isIdentifier(member.typeName)
          ? [member.typeName.text]
          : [],
      ),
    );
  }
  return new Set();
}

function assertInterfaceContainsFields(
  props: Set<string>,
  interfaceName: string,
  fields: readonly string[],
  opId: string,
  side: 'request' | 'response' | 'request-unsupported' | 'response-sdkOnly',
): void {
  const missing = fields.filter((f) => !props.has(f));
  if (missing.length > 0) {
    throw new Error(
      `[${opId}] ${interfaceName} (${side}) is missing tracked field(s): ${missing.join(', ')}`,
    );
  }
}

function assertAliasIncludesReferences(
  refs: Set<string>,
  aliasName: string,
  interfaceNames: readonly string[],
  opId: string,
): void {
  const missing = interfaceNames.filter((n) => !refs.has(n));
  if (missing.length > 0) {
    throw new Error(
      `[${opId}] ${aliasName} (stream union) is missing event type(s): ${missing.join(', ')}`,
    );
  }
}

interface VerifyOptions {
  readonly skipLiveDocs?: boolean;
}

function verifyOperation(
  op: OllamaContract['operations'][number],
  docsCache: Map<string, string>,
  options: VerifyOptions,
): Promise<void> | void {
  if (!op.parity) return;
  const parity = op.parity;

  // STRUCTURAL — always run, no network.
  if (parity.request?.interfaceName && parity.request.sourceFile) {
    const props = loadInterfaceProperties(
      parity.request.sourceFile,
      parity.request.interfaceName,
    ).properties;
    assertInterfaceContainsFields(
      props,
      parity.request.interfaceName,
      parity.request.fields,
      op.id,
      'request',
    );
    assertInterfaceContainsFields(
      props,
      parity.request.interfaceName,
      parity.request.unsupportedFields,
      op.id,
      'request-unsupported',
    );
  }

  if (parity.response?.interfaceName && parity.response.sourceFile) {
    const props = loadInterfaceProperties(
      parity.response.sourceFile,
      parity.response.interfaceName,
    ).properties;
    assertInterfaceContainsFields(
      props,
      parity.response.interfaceName,
      parity.response.fields,
      op.id,
      'response',
    );
  }

  if (parity.stream) {
    const sourceFile = parity.response?.sourceFile ?? 'src/integrations/openai.ts';
    const refs = loadTypeAliasReferences(sourceFile, parity.stream.unionName);
    assertAliasIncludesReferences(
      refs,
      parity.stream.unionName,
      parity.stream.interfaceNames,
      op.id,
    );
  }

  if (options.skipLiveDocs) return;
  if (!parity.docsUrl) return;

  // LIVE DOCS — async, cached per docsUrl.
  return verifyOperationLiveDocs(op, docsCache);
}

async function verifyOperationLiveDocs(
  op: OllamaContract['operations'][number],
  docsCache: Map<string, string>,
): Promise<void> {
  const parity = op.parity!;

  let docs = docsCache.get(parity.docsUrl!);
  if (docs === undefined) {
    try {
      docs = await fetchDocs(parity.docsUrl!);
      docsCache.set(parity.docsUrl!, docs);
    } catch (error) {
      if (!parity.fallbackDocsFile) throw error;
      console.warn(`WARN ${op.id}: live docs unreachable; using pinned fallback`);
      docs = '';
    }
  }

  let fallbackDocs = '';
  if (parity.fallbackDocsFile) {
    fallbackDocs = readFileSync(resolve(PROJECT_ROOT, parity.fallbackDocsFile), 'utf8');
    if (!docs) docs = fallbackDocs;
  }

  // The endpoint must be mentioned.
  if (!docs!.includes(op.path) && !fallbackDocs.includes(op.path)) {
    throw new Error(`[${op.id}] Documented endpoint ${op.path} is missing from ${parity.docsUrl}`);
  }

  // Request fields must be documented as supported.
  if (parity.request) {
    const requestFields = requestFieldSection(docs!, op.path);
    const fallbackRequestFields = requestFieldSection(fallbackDocs, op.path) || fallbackDocs;
    const missingDocs = parity.request.fields.filter((field) => {
      const aliases = parity.request!.docAliases?.[field] ?? [field];
      const requestStatus = firstKnownStatus(
        requestFields,
        fallbackRequestFields || fallbackDocs,
        aliases,
      );
      if (requestStatus === 'supported') return false;

      const featureAliases = parity.request!.featureAliases?.[field] ?? [];
      if (featureAliasCheck(docs!, featureAliases)) return false;
      if (featureAliasCheck(fallbackDocs, featureAliases)) return false;
      return true;
    });
    if (missingDocs.length > 0) {
      throw new Error(
        `[${op.id}] Supported request field(s) are missing or marked unsupported by Ollama: ${missingDocs.join(', ')}`,
      );
    }

    // Unsupported fields must be explicitly marked as such.
    const unsupportedSection = unsupportedFieldSection(docs!, op.path);
    const fallbackUnsupportedSection = unsupportedFieldSection(fallbackDocs, op.path);
    const unsupportedEvidence = unsupportedSection || fallbackUnsupportedSection;
    const invalidUnsupported = parity.request.unsupportedFields.filter((field) => {
      const aliases = parity.request!.docAliases?.[field] ?? [field];
      return (
        !docsMentionField(unsupportedEvidence, aliases) &&
        !explicitlyUnsupported(unsupportedEvidence, aliases) &&
        !explicitlyUnsupported(docs!, aliases)
      );
    });
    if (invalidUnsupported.length > 0) {
      throw new Error(
        `[${op.id}] Explicitly unsupported request field(s) changed status in Ollama docs: ${invalidUnsupported.join(', ')}`,
      );
    }

    // Nested unsupported fields must have evidence.
    const nestedUnsupported = parity.request.nestedUnsupportedFields;
    const nestedEvidence = unsupportedSection || fallbackUnsupportedSection;
    const invalidNested = nestedUnsupported.filter((path) => {
      const leaf = nestedFieldName(path);
      return (
        !docsMentionField(nestedEvidence, [leaf]) &&
        !explicitlyUnsupported(nestedEvidence, [leaf]) &&
        !explicitlyUnsupported(docs!, [leaf])
      );
    });
    if (invalidNested.length > 0) {
      throw new Error(
        `[${op.id}] Nested unsupported field(s) lack explicit Ollama unsupported evidence: ${invalidNested.join(', ')}`,
      );
    }
  }

  // Response fields.
  if (parity.response) {
    const responseSection = responseFieldSection(docs!, op.path);
    const fallbackResponseSection = responseFieldSection(fallbackDocs, op.path) || fallbackDocs;
    const missingResponseDocs = parity.response.fields.filter((field) => {
      const aliases = parity.response!.docAliases?.[field] ?? [field];
      return (
        firstKnownStatus(responseSection, fallbackResponseSection || fallbackDocs, aliases) !==
        'supported'
      );
    });
    if (missingResponseDocs.length > 0) {
      throw new Error(
        `[${op.id}] Response field(s) are missing or marked unsupported by Ollama: ${missingResponseDocs.join(', ')}`,
      );
    }
  }

  // Streaming event types.
  if (parity.stream?.eventTypes && parity.stream.eventTypes.length > 0) {
    const eventDocs = streamEventSection(docs!, op.path);
    const fallbackEventDocs = streamEventSection(fallbackDocs, op.path) || fallbackDocs;
    const missingDocumentedEvents = parity.stream.eventTypes.filter((eventType) => {
      return (
        firstKnownStatus(eventDocs, fallbackEventDocs || fallbackDocs, [eventType]) !== 'supported'
      );
    });
    if (missingDocumentedEvents.length > 0) {
      throw new Error(
        `[${op.id}] Documented stream event type(s) are missing from the SDK contract or Ollama docs: ${missingDocumentedEvents.join(', ')}`,
      );
    }
  }
}

function featureAliasCheck(docs: string, aliases: readonly string[]): boolean {
  if (aliases.length === 0) return false;
  return supportedFeatureStatus(docs, aliases) === 'supported';
}

async function main(): Promise<void> {
  const skipLiveDocs = process.argv.includes('--skip-live-docs');
  const ir = JSON.parse(readFileSync(IR_PATH, 'utf8')) as OllamaContract;
  const docsCache = new Map<string, string>();
  let checked = 0;
  let liveDocsChecked = 0;

  try {
    for (const op of ir.operations) {
      if (!op.parity) continue;
      const result = verifyOperation(op, docsCache, { skipLiveDocs });
      if (result instanceof Promise) {
        await result;
        liveDocsChecked += 1;
      }
      checked += 1;
      console.log(`PASS ${op.id}: parity block valid`);
    }
  } catch (error) {
    console.error('\nIR-driven parity FAILED:');
    console.error(error);
    process.exitCode = 1;
    return;
  }

  const mode = skipLiveDocs ? 'structural-only' : 'structural + live-docs';
  console.log(
    `\nIR-driven parity verified (${checked} operations, ${mode}` +
      (skipLiveDocs ? '' : `, ${liveDocsChecked} fetched live docs)`) +
      `).`,
  );
}

main();
