#!/usr/bin/env tsx
/**
 * IR-driven parity verifier — the Wave 5 successor to `scripts/verify-api-parity.ts`.
 *
 * Instead of reading `docs/api-parity.json` directly, this verifier reads
 * the canonical IR at `contracts/ir/ollama.ir.json`, which has been compiled
 * from the overlay YAMLs (which now carry their own `parity:` blocks).
 *
 * The verifier enforces, per operation with a `parity:` block:
 *
 *   1. Every `parity.request.fields` entry exists in the hand-written
 *      interface named by `parity.request.interfaceName` in
 *      `parity.request.sourceFile`. (Catches stale manifest entries.)
 *   2. Every `parity.response.fields` entry exists in the hand-written
 *      response interface. (Same.)
 *   3. Every `parity.stream.interfaceNames` entry is referenced by the
 *      TypeScript type alias `parity.stream.unionName`. (Same.)
 *
 * What this verifier does NOT do (yet):
 *
 *   - Live docs fetching (the legacy verifier fetches docs.ollama.com).
 *     Wave 5 keeps that responsibility on the legacy verifier so we don't
 *     regress field-level coverage. The IR-driven verifier is a structural
 *     TypeScript-only check.
 *
 *   - Field-level docs-status promotion (sdkOnly → supported, etc.). That
 *     requires docs scraping which is intentionally deferred.
 *
 * The IR-driven verifier is the structural complement to the existing
 * `verify-api-parity.ts` — both run in CI until Wave 5 is complete, at
 * which point the legacy verifier is retired.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { OllamaContract } from '../generator/types.js';

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

function verifyOperation(op: OllamaContract['operations'][number]): void {
  if (!op.parity) return;
  const parity = op.parity;

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
    // The `unsupportedFields` list contains fields Ollama explicitly marks as
    // unsupported. These should still exist on the hand-written interface
    // (they're typed but ignored), so verify them too.
    assertInterfaceContainsFields(
      props,
      parity.request.interfaceName,
      parity.request.unsupportedFields,
      op.id,
      'request-unsupported',
    );
    // The `sdkOnlyFields` list is intentionally NOT checked here. These are
    // SDK-local fields that may or may not be present on the hand-written
    // interface — they're a compatibility affordance rather than a contract
    // surface. The drift detector in `generator/emitters/typescript/drift-detector.ts`
    // surfaces these as `removed` entries for follow-up review.
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
    // Same logic for response-side sdkOnlyFields — skip the hard check.
  }

  if (parity.stream) {
    // The stream union lives in the same sourceFile as the response.
    const sourceFile = parity.response?.sourceFile ?? 'src/integrations/openai.ts';
    const refs = loadTypeAliasReferences(sourceFile, parity.stream.unionName);
    assertAliasIncludesReferences(
      refs,
      parity.stream.unionName,
      parity.stream.interfaceNames,
      op.id,
    );
  }
}

function main(): void {
  const ir = JSON.parse(readFileSync(IR_PATH, 'utf8')) as OllamaContract;
  let checked = 0;
  try {
    for (const op of ir.operations) {
      if (!op.parity) continue;
      verifyOperation(op);
      checked += 1;
      console.log(
        `PASS ${op.id}: parity block valid ` +
          `(${op.parity.request?.fields.length ?? 0} req fields, ` +
          `${op.parity.response?.fields.length ?? 0} resp fields` +
          `${op.parity.stream ? `, ${op.parity.stream.interfaceNames.length} stream events` : ''})`,
      );
    }
  } catch (error) {
    console.error('\nIR-driven parity FAILED:');
    console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nIR-driven parity verified (${checked} operations with parity blocks out of ${ir.operations.length} total).`,
  );
}

main();
