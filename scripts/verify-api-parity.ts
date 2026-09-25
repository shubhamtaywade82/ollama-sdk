/**
 * Verifies that the SDK still covers the API surface documented by Ollama.
 *
 * The contract is intentionally kept in docs/api-parity.json so reviewers can see the
 * compatibility scope independently from the executable verifier.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

interface FieldSectionContract {
  readonly sourceFile: string;
  readonly interfaceName: string;
  readonly fields: readonly string[];
  readonly unsupportedFields?: readonly string[];
  readonly sdkOnlyFields?: readonly string[];
  readonly docAliases?: Readonly<Record<string, readonly string[]>>;
}

interface StreamContract {
  readonly sourceFile: string;
  readonly unionName: string;
  readonly interfaceNames: readonly string[];
}

interface SurfaceContract {
  readonly id: string;
  readonly docsUrl: string;
  readonly sourceFile?: string;
  readonly interfaceName?: string;
  readonly endpoint: string;
  readonly fields: readonly string[];
  readonly unsupportedFields?: readonly string[];
  readonly sdkOnlyFields?: readonly string[];
  readonly docAliases?: Readonly<Record<string, readonly string[]>>;
  readonly response?: FieldSectionContract;
  readonly stream?: StreamContract;
}

interface ParityManifest {
  readonly version: number;
  readonly source: string;
  readonly surfaces: readonly SurfaceContract[];
}

const ROOT = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(
  readFileSync(resolve(ROOT, 'docs/api-parity.json'), 'utf8'),
) as ParityManifest;

function sourceProperties(sourceFile: string, interfaceName: string): Set<string> {
  const sourcePath = resolve(ROOT, sourceFile);
  const source = readFileSync(sourcePath, 'utf8');
  const file = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue;
    return new Set(
      statement.members.flatMap((member) => {
        if (!ts.isPropertySignature(member) || !member.name) return [];
        if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
          return [member.name.text];
        }
        return [];
      }),
    );
  }

  throw new Error(`Interface ${interfaceName} was not found in ${sourceFile}`);
}

function sourceTypeReferences(sourceFile: string, typeAliasName: string): Set<string> {
  const sourcePath = resolve(ROOT, sourceFile);
  const source = readFileSync(sourcePath, 'utf8');
  const file = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of file.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== typeAliasName) continue;
    if (!ts.isUnionTypeNode(statement.type)) return new Set();
    return new Set(
      statement.type.types.flatMap((member) =>
        ts.isTypeReferenceNode(member) && ts.isIdentifier(member.typeName)
          ? [member.typeName.text]
          : [],
      ),
    );
  }

  throw new Error(`Type alias ${typeAliasName} was not found in ${sourceFile}`);
}
async function fetchDocs(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: 'text/plain, text/markdown, */*' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

function requestFieldSection(docs: string, endpoint: string): string {
  const endpointIndex = docs.indexOf(endpoint);
  if (endpointIndex < 0) return '';

  const tail = docs.slice(endpointIndex);
  const heading = tail.match(/^#### (Supported request fields|Body)\s*$/m);
  if (!heading || heading.index === undefined) return tail;

  const section = tail.slice(heading.index + heading[0].length);
  const nextHeading = section.search(/^####? /m);
  return nextHeading >= 0 ? section.slice(0, nextHeading) : section;
}
function responseFieldSection(docs: string, endpoint: string): string {
  const endpointIndex = docs.indexOf(endpoint);
  if (endpointIndex < 0) return '';

  const tail = docs.slice(endpointIndex);
  const heading = tail.match(/^#### Supported response fields\s*$/m);
  if (!heading || heading.index === undefined) return '';

  const section = tail.slice(heading.index + heading[0].length);
  const nextHeading = section.search(/^####? /m);
  return nextHeading >= 0 ? section.slice(0, nextHeading) : section;
}

type DocFieldStatus = 'supported' | 'unsupported' | 'missing';

function docsFieldStatus(docs: string, aliases: readonly string[]): DocFieldStatus {
  for (const line of docs.split(/\r?\n/)) {
    const matches = aliases.some((field) => {
      const forms = [
        '`' + field + '`',
        '"' + field + '":',
        "'" + field + "':",
        '| ' + field + ' |',
        '<td>' + field + '</td>',
      ];
      if (forms.some((form) => line.includes(form))) return true;
      const value = line.trim();
      return value === field || value.startsWith(field + ':') || value.startsWith('- ' + field + ':');
    });
    if (!matches) continue;

    if (/\[\s*\]/.test(line)) return 'unsupported';
    if (/\[\s*x\s*\]/i.test(line)) return 'supported';
    return 'supported';
  }
  return 'missing';
}
function assertContract(
  contract: SurfaceContract,
  docs: string,
  properties: Set<string>,
): void {
  if (!docs.includes(contract.endpoint)) {
    throw new Error(
      `[${contract.id}] Documented endpoint ${contract.endpoint} is missing from ${contract.docsUrl}`,
    );
  }

  if (!contract.interfaceName || !contract.sourceFile) return;

  const requestTracked = [
    ...contract.fields,
    ...(contract.unsupportedFields ?? []),
    ...(contract.sdkOnlyFields ?? []),
  ];
  const missingSource = requestTracked.filter((field) => !properties.has(field));
  if (missingSource.length > 0) {
    throw new Error(
      `[${contract.id}] ${contract.interfaceName} is missing tracked request field(s): ${missingSource.join(', ')}`,
    );
  }

  const requestFields = requestFieldSection(docs, contract.endpoint);
  const missingDocs = contract.fields.filter((field) => {
    const aliases = contract.docAliases?.[field] ?? [field];
    return docsFieldStatus(requestFields, aliases) !== 'supported';
  });

  if (missingDocs.length > 0) {
    throw new Error(
      `[${contract.id}] Supported field(s) are missing or marked unsupported by Ollama: ${missingDocs.join(', ')}`,
    );
  }

  const unsupportedDocs = (contract.unsupportedFields ?? []).filter((field) => {
    const aliases = contract.docAliases?.[field] ?? [field];
    return docsFieldStatus(requestFields, aliases) !== 'unsupported';
  });

  if (unsupportedDocs.length > 0) {
    throw new Error(
      `[${contract.id}] Explicitly unsupported field(s) changed status in Ollama docs: ${unsupportedDocs.join(', ')}`,
    );
  }

  const sdkOnlyDocs = (contract.sdkOnlyFields ?? []).filter((field) => {
    const aliases = contract.docAliases?.[field] ?? [field];
    return docsFieldStatus(requestFields, aliases) !== 'missing';
  });

  if (sdkOnlyDocs.length > 0) {
    throw new Error(
      `[${contract.id}] SDK-only field(s) are now documented by Ollama and need reclassification: ${sdkOnlyDocs.join(', ')}`,
    );
  }

  if (contract.response) {
    const responseProps = sourceProperties(
      contract.response.sourceFile,
      contract.response.interfaceName,
    );
    const responseTracked = [
      ...contract.response.fields,
      ...(contract.response.unsupportedFields ?? []),
      ...(contract.response.sdkOnlyFields ?? []),
    ];
    const missingResponseSource = responseTracked.filter((field) => !responseProps.has(field));
    if (missingResponseSource.length > 0) {
      throw new Error(
        `[${contract.id}] ${contract.response.interfaceName} is missing response field(s): ${missingResponseSource.join(', ')}`,
      );
    }

    const responseSection = responseFieldSection(docs, contract.endpoint);
    const missingResponseDocs = contract.response.fields.filter((field) => {
      const aliases = contract.response?.docAliases?.[field] ?? [field];
      return docsFieldStatus(responseSection, aliases) !== 'supported';
    });
    if (missingResponseDocs.length > 0) {
      throw new Error(
        `[${contract.id}] Response field(s) are missing or marked unsupported by Ollama: ${missingResponseDocs.join(', ')}`,
      );
    }

    const unsupportedResponseDocs = (contract.response.unsupportedFields ?? []).filter((field) => {
      const aliases = contract.response?.docAliases?.[field] ?? [field];
      return docsFieldStatus(responseSection, aliases) !== 'unsupported';
    });
    if (unsupportedResponseDocs.length > 0) {
      throw new Error(
        `[${contract.id}] Explicitly unsupported response field(s) changed status in Ollama docs: ${unsupportedResponseDocs.join(', ')}`,
      );
    }

    const sdkOnlyResponseDocs = (contract.response.sdkOnlyFields ?? []).filter((field) => {
      const aliases = contract.response?.docAliases?.[field] ?? [field];
      return docsFieldStatus(responseSection, aliases) !== 'missing';
    });
    if (sdkOnlyResponseDocs.length > 0) {
      throw new Error(
        `[${contract.id}] SDK-only response field(s) are now documented by Ollama and need reclassification: ${sdkOnlyResponseDocs.join(', ')}`,
      );
    }
  }

  if (contract.stream) {
    const refs = sourceTypeReferences(contract.stream.sourceFile, contract.stream.unionName);
    const missingEventTypes = contract.stream.interfaceNames.filter((name) => !refs.has(name));
    if (missingEventTypes.length > 0) {
      throw new Error(
        `[${contract.id}] ${contract.stream.unionName} is missing stream event type(s): ${missingEventTypes.join(', ')}`,
      );
    }
  }
}

async function main(): Promise<void> {
  if (manifest.version !== 3) {
    throw new Error(`Unsupported parity manifest version: ${String(manifest.version)}`);
  }

  const docsCache = new Map<string, string>();

  for (const contract of manifest.surfaces) {
    let docs = docsCache.get(contract.docsUrl);
    if (docs === undefined) {
      docs = await fetchDocs(contract.docsUrl);
      docsCache.set(contract.docsUrl, docs);
    }

    const sourceProps =
      contract.interfaceName && contract.sourceFile
        ? sourceProperties(contract.sourceFile, contract.interfaceName)
        : new Set<string>();

    assertContract(contract, docs, sourceProps);

    console.log(
      `PASS ${contract.id}: ${contract.endpoint}${contract.interfaceName ? ` -> ${contract.interfaceName}` : ''} (${contract.fields.length + (contract.unsupportedFields?.length ?? 0) + (contract.sdkOnlyFields?.length ?? 0) + (contract.response?.fields.length ?? 0)} tracked fields)`,
    );
  }

  console.log(
    `\nOllama API parity contract passed (${manifest.surfaces.length} surfaces, manifest v${manifest.version}).`,
  );
}

main().catch((error: unknown) => {
  console.error('\nOllama API parity FAILED:');
  console.error(error);
  process.exitCode = 1;
});
