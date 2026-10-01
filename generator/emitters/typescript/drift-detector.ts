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
 *     from the generated model. By default these are flagged as drift, but
 *     the {@link TypeDriftOptions.allowRemoved} set lets callers declare
 *     "these fields are intentionally SDK-only and not in the OpenAPI spec"
 *     — typically used by the IR's `parity.sdkOnlyFields` blocks so the
 *     drift detector doesn't report them.
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
import type { OperationContract, SchemaContract } from '../../types.js';

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
  /** Properties on the hand-written type that are missing from the OpenAPI spec. */
  readonly removed: readonly string[];
  /** Subset of `removed` that is explicitly allowed (declared as sdkOnlyFields in the overlay). */
  readonly allowedRemoved: readonly string[];
  /** `removed` entries that are NOT explicitly allowed — these are real drift. */
  readonly unexpectedRemoved: readonly string[];
  readonly matched: readonly string[];
}

/** Result of running the drift detector across all mapped schemas. */
export interface TypeDriftResult {
  readonly entries: readonly TypeDriftEntry[];
  readonly totalAdded: number;
  /** All `removed` entries (intentional + unexpected). */
  readonly totalRemoved: number;
  /** `removed` entries that were explicitly allowed via sdkOnlyFields. */
  readonly totalAllowedRemoved: number;
  /** `removed` entries that are NOT allowed — these are real drift findings. */
  readonly totalUnexpectedRemoved: number;
  readonly totalMatched: number;
}

/** Options for {@link detectTypeDrift}. */
export interface TypeDriftOptions {
  /**
   * Set of `<schemaName>.<side>.<fieldName>` triples that are intentionally
   * absent from the OpenAPI spec but present in the hand-written type.
   * Typically derived from the IR's `parity.<side>.sdkOnlyFields` blocks.
   *
   * Example: `{ "ChatRequest.request.width", "GenerateResponse.response.context" }`
   */
  readonly allowRemoved?: ReadonlySet<string>;
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
  operations: readonly OperationContract[] = [],
  options: TypeDriftOptions = {},
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

  // If `allowRemoved` wasn't provided, derive it from the IR operations'
  // parity blocks. This is the default behavior — when callers don't pass
  // an explicit allowlist, the IR's `sdkOnlyFields` declarations are used.
  const allowRemoved = options.allowRemoved ?? deriveAllowRemoved(operations);

  const byName = new Map(schemas.map((s) => [s.name, s] as const));
  const entries: TypeDriftEntry[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalAllowedRemoved = 0;
  let totalUnexpectedRemoved = 0;
  let totalMatched = 0;

  for (const [schemaName, legacyInterface] of Object.entries(LEGACY_TYPE_MAP)) {
    const schema = byName.get(schemaName);
    if (!schema) continue;
    const legacyProps = extractInterfaceProperties(sourceFile, legacyInterface);
    if (legacyProps.size === 0) continue;

    const generatedProps = schemaPropertyNames(schema);
    const added = [...generatedProps].filter((p) => !legacyProps.has(p)).sort();
    const removed = [...legacyProps].filter((p) => !generatedProps.has(p)).sort();
    const matched = [...generatedProps].filter((p) => legacyProps.has(p)).sort();

    // Partition `removed` into allowed (declared as sdkOnlyFields) and unexpected.
    const allowedRemoved: string[] = [];
    const unexpectedRemoved: string[] = [];
    for (const field of removed) {
      const reqKey = `${schemaName}.request.${field}`;
      const resKey = `${schemaName}.response.${field}`;
      if (allowRemoved.has(reqKey) || allowRemoved.has(resKey)) {
        allowedRemoved.push(field);
      } else {
        unexpectedRemoved.push(field);
      }
    }

    totalAdded += added.length;
    totalRemoved += removed.length;
    totalAllowedRemoved += allowedRemoved.length;
    totalUnexpectedRemoved += unexpectedRemoved.length;
    totalMatched += matched.length;

    entries.push({
      schemaName,
      legacyInterface,
      added,
      removed,
      allowedRemoved,
      unexpectedRemoved,
      matched,
    });
  }

  return {
    entries,
    totalAdded,
    totalRemoved,
    totalAllowedRemoved,
    totalUnexpectedRemoved,
    totalMatched,
  };
}

/**
 * Derive the default `allowRemoved` set from the IR's `parity.sdkOnlyFields`
 * declarations. This is the automatic mechanism: when an overlay declares a
 * field as `sdkOnlyFields`, the drift detector treats it as expected drift
 * (not a finding).
 */
function deriveAllowRemoved(operations: readonly OperationContract[]): Set<string> {
  const set = new Set<string>();
  for (const op of operations) {
    if (!op.parity) continue;
    const reqSchemas: { schema: string; fields: readonly string[] }[] = [];
    if (op.parity.request?.interfaceName) {
      // Look up the OpenAPI schema name from the operation's request ref.
      const ref = op.request?.$ref ?? '';
      const match = /#\/schemas\/(.+)$/.exec(ref) ?? /#\/components\/schemas\/(.+)$/.exec(ref);
      if (match?.[1]) {
        reqSchemas.push({
          schema: match[1],
          fields: op.parity.request.sdkOnlyFields,
        });
      }
    }
    if (op.parity.response?.interfaceName) {
      const ref = op.response?.$ref ?? '';
      const match = /#\/schemas\/(.+)$/.exec(ref) ?? /#\/components\/schemas\/(.+)$/.exec(ref);
      if (match?.[1]) {
        reqSchemas.push({
          schema: match[1],
          fields: op.parity.response.sdkOnlyFields,
        });
      }
    }
    for (const { schema, fields } of reqSchemas) {
      for (const field of fields) {
        set.add(`${schema}.request.${field}`);
        set.add(`${schema}.response.${field}`);
      }
    }
  }
  return set;
}

/** Format a drift result as a human-readable string. */
export function formatDriftReport(result: TypeDriftResult): string {
  const lines: string[] = [];
  lines.push(
    `Type drift report: ${result.entries.length} schemas compared, ` +
      `${result.totalMatched} matched, ${result.totalAdded} added, ` +
      `${result.totalRemoved} removed (${result.totalAllowedRemoved} expected, ` +
      `${result.totalUnexpectedRemoved} unexpected)`,
  );
  for (const entry of result.entries) {
    if (entry.added.length === 0 && entry.unexpectedRemoved.length === 0) continue;
    lines.push(`  ${entry.schemaName} vs ${entry.legacyInterface}:`);
    for (const p of entry.added) lines.push(`    + ${p}`);
    for (const p of entry.unexpectedRemoved) lines.push(`    - ${p}  (unexpected)`);
    // Show allowed-removed inline as confirmation that they're acknowledged.
    for (const p of entry.allowedRemoved) lines.push(`    ~ ${p}  (declared sdkOnly)`);
  }
  return lines.join('\n');
}
