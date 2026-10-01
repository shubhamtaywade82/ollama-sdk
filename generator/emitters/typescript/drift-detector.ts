/**
 * Generated-vs-hand-written type drift detector.
 *
 * Compares the property sets of generated models (from the IR) against the
 * existing hand-written `src/types.ts` interfaces, and reports:
 *
 *   - `added`: properties present in the generated model but missing from the
 *     hand-written interface. These are candidates for migration into
 *     `src/types.ts` (or for replacing the hand-written type entirely in a
 *     later wave).
 *   - `removed`: properties present in the hand-written interface but missing
 *     from the generated model. These are candidates for adding to the IR
 *     (typically via an overlay augmenting the OpenAPI spec) or for removal
 *     from `src/types.ts` if they are no longer part of the Ollama API.
 *   - `matched`: properties present in both with the same name.
 *
 * Property *types* are intentionally not compared here — the hand-written
 * types use richer unions (e.g. `string | Uint8Array` for images) that the
 * OpenAPI spec cannot express. A future iteration may compare structural
 * compatibility.
 *
 * The mapping between IR schema names and `src/types.ts` interface names is
 * provided by {@link LEGACY_TYPE_MAP}. This is a hand-maintained mapping
 * because the two naming conventions differ (IR uses OpenAPI names like
 * `ChatRequest`; the hand-written types use `ChatRequestOptions`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { SchemaContract } from '../../types.js';

/** Maps an OpenAPI schema name to the hand-written interface name in src/types.ts. */
const LEGACY_TYPE_MAP: Readonly<Record<string, string>> = {
  ChatRequest: 'ChatRequestOptions',
  ChatResponse: 'ChatResponse',
  GenerateRequest: 'GenerateRequestOptions',
  GenerateResponse: 'GenerateResponse',
  EmbedRequest: 'EmbedRequestOptions',
  EmbedResponse: 'EmbedResponse',
  CreateRequest: 'CreateRequestOptions',
  CopyRequest: 'CopyRequestOptions',
  DeleteRequest: 'DeleteRequestOptions',
  PullRequest: 'PullRequestOptions',
  PushRequest: 'PushRequestOptions',
  ShowRequest: 'ShowRequestOptions',
  ShowResponse: 'ShowResponse',
  ListResponse: 'ListResponse',
};

/** A single drift entry for one property. */
export interface TypeDriftEntry {
  readonly schemaName: string;
  readonly legacyInterface: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly matched: readonly string[];
}

/** Result of running the drift detector across all mapped schemas. */
export interface TypeDriftResult {
  readonly entries: readonly TypeDriftEntry[];
  readonly totalAdded: number;
  readonly totalRemoved: number;
  readonly totalMatched: number;
}

function extractInterfaceProperties(sourceFile: ts.SourceFile, interfaceName: string): Set<string> {
  const result = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    if (statement.name.text !== interfaceName) continue;
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
        result.add(member.name.text);
      }
    }
    // Don't break — if there are duplicate declarations (rare), we want every member.
  }
  return result;
}

function schemaPropertyNames(schema: SchemaContract): Set<string> {
  const props = schema.definition?.properties ?? {};
  return new Set(Object.keys(props));
}

/** Run the drift detector. */
export function detectTypeDrift(
  projectRoot: string,
  schemas: readonly SchemaContract[],
): TypeDriftResult {
  const legacyPath = resolve(projectRoot, 'src/types.ts');
  const legacySource = readFileSync(legacyPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    legacyPath,
    legacySource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const byName = new Map(schemas.map((s) => [s.name, s] as const));
  const entries: TypeDriftEntry[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalMatched = 0;

  for (const [schemaName, legacyInterface] of Object.entries(LEGACY_TYPE_MAP)) {
    const schema = byName.get(schemaName);
    if (!schema) continue;
    const legacyProps = extractInterfaceProperties(sourceFile, legacyInterface);
    if (legacyProps.size === 0) continue; // Skip unmapped or missing interfaces.

    const generatedProps = schemaPropertyNames(schema);
    const added = [...generatedProps].filter((p) => !legacyProps.has(p)).sort();
    const removed = [...legacyProps].filter((p) => !generatedProps.has(p)).sort();
    const matched = [...generatedProps].filter((p) => legacyProps.has(p)).sort();

    totalAdded += added.length;
    totalRemoved += removed.length;
    totalMatched += matched.length;

    entries.push({
      schemaName,
      legacyInterface,
      added,
      removed,
      matched,
    });
  }

  return { entries, totalAdded, totalRemoved, totalMatched };
}

/** Format a drift result as a human-readable string. */
export function formatDriftReport(result: TypeDriftResult): string {
  const lines: string[] = [];
  lines.push(
    `Type drift report: ${result.entries.length} schemas compared, ` +
      `${result.totalMatched} matched, ${result.totalAdded} added, ${result.totalRemoved} removed`,
  );
  for (const entry of result.entries) {
    if (entry.added.length === 0 && entry.removed.length === 0) continue;
    lines.push(`  ${entry.schemaName} vs ${entry.legacyInterface}:`);
    for (const p of entry.added) lines.push(`    + ${p}`);
    for (const p of entry.removed) lines.push(`    - ${p}`);
  }
  return lines.join('\n');
}
