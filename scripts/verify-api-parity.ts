/**
 * Verifies that the SDK still covers the API surface documented by Ollama.
 *
 * The contract is intentionally kept in docs/api-parity.json so reviewers can see the
 * compatibility scope independently from the executable verifier.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import {
  docsMentionField,
  explicitlyUnsupported,
  firstKnownStatus,
  nestedFieldName,
  endpointSection,
} from './parity-status.js';

interface FieldSectionContract {
  readonly sourceFile: string;
  readonly interfaceName: string;
  readonly fields: readonly string[];
  readonly unsupportedFields?: readonly string[];
  readonly sdkOnlyFields?: readonly string[];
  readonly nestedUnsupportedFields?: readonly string[];
  readonly docAliases?: Readonly<Record<string, readonly string[]>>;
}

interface StreamContract {
  readonly sourceFile: string;
  readonly unionName: string;
  readonly interfaceNames: readonly string[];
  readonly eventTypes?: readonly string[];
}

interface SurfaceContract {
  readonly id: string;
  readonly docsUrl: string;
  readonly fallbackDocsUrl?: string;
  readonly fallbackDocsFile?: string;
  readonly sourceFile?: string;
  readonly interfaceName?: string;
  readonly endpoint: string;
  readonly fields: readonly string[];
  readonly unsupportedFields?: readonly string[];
  readonly sdkOnlyFields?: readonly string[];
  readonly nestedUnsupportedFields?: readonly string[];
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
function normalizeHtmlDocs(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, content: string) => '\n' + '#'.repeat(Number(level)) + ' ' + content + '\n')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, content: string) => '`' + content + '`')
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, content: string) => '\n- ' + content)
    .replace(/<br\s*\/>/gi, '\n')
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_match, content: string) => '\n' + content + '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function fetchDocs(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: 'text/html, text/markdown, text/plain, */*' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  return contentType.includes('text/html') ? normalizeHtmlDocs(body) : body;
}
function normalizedHeadingText(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function labeledSection(docs: string, label: string, stopLabels: readonly string[]): string {
  const lines = docs.split(/\r?\n/);
  const normalizedLabel = label.toLowerCase();
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) return false;
    const value = normalizedHeadingText(line);
    return value === normalizedLabel || value.endsWith(normalizedLabel) || value.includes(normalizedLabel);
  });
  if (start < 0) return '';

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const value = normalizedHeadingText(line);
    if (
      stopLabels.some((stop) => value === stop.toLowerCase() || value.endsWith(stop.toLowerCase())) ||
      (/^#{2,6}\s+/.test(line.trim()) && stopLabels.some((stop) => value.includes(stop.toLowerCase())))
    ) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}
function requestFieldSection(docs: string, endpoint: string): string {
  const endpointDocs = endpointSection(docs, endpoint);
  if (!endpointDocs) return '';

  const lines = endpointDocs.split(/\r?\n/);
  const label = 'supported request fields';
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('#') && normalizedHeadingText(line).includes(label);
  });
  if (start < 0) return '';

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^#{2,6}\s+/.test(line.trim())) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

function responseFieldSection(docs: string, endpoint: string): string {
  const endpointDocs = endpointSection(docs, endpoint);
  if (!endpointDocs) return '';
  return (
    labeledSection(endpointDocs, 'Supported response fields', [
      'Streaming events',
      'Not supported',
      'Partial support',
      'Models',
      'Notes',
    ]) ||
    labeledSection(endpointDocs, 'Response', [
      'Streaming events',
      'Not supported',
      'Partial support',
      'Models',
      'Notes',
    ])
  );
}

function streamEventSection(docs: string, endpoint: string): string {
  const endpointDocs = endpointSection(docs, endpoint);
  if (!endpointDocs) return '';
  return labeledSection(endpointDocs, 'Streaming events', [
    'Models',
    'Not supported',
    'Partial support',
    'Notes',
  ]);
}

function unsupportedFieldSection(docs: string, endpoint: string): string {
  const endpointDocs = endpointSection(docs, endpoint);
  if (!endpointDocs) return '';
  return labeledSection(endpointDocs, 'Not supported', [
    'Partial support',
    'Models',
    'Notes',
  ]);
}

function assertContract(
  contract: SurfaceContract,
  docs: string,
  fallbackDocs: string,
  properties: Set<string>,
): void {
  if (!docs.includes(contract.endpoint) && !fallbackDocs.includes(contract.endpoint)) {
    throw new Error(
      `[${contract.id}] Documented endpoint ${contract.endpoint} is missing from ${contract.docsUrl}`,
    );
  }

  if (!contract.interfaceName || !contract.sourceFile) return;

  const requestTracked = [
    ...contract.fields,
    ...(contract.unsupportedFields ?? []),
  ];
  const missingSource = requestTracked.filter((field) => !properties.has(field));
  if (missingSource.length > 0) {
    throw new Error(
      `[${contract.id}] ${contract.interfaceName} is missing tracked request field(s): ${missingSource.join(', ')}`,
    );
  }

  const requestFields = requestFieldSection(docs, contract.endpoint);
  const fallbackRequestFields =
    requestFieldSection(fallbackDocs, contract.endpoint) || fallbackDocs;
  const missingDocs = contract.fields.filter((field) => {
    const aliases = contract.docAliases?.[field] ?? [field];
    return firstKnownStatus(
      requestFields,
      fallbackRequestFields || fallbackDocs,
      aliases,
    ) !== 'supported';
  });

  if (missingDocs.length > 0) {
    throw new Error(
      `[${contract.id}] Supported field(s) are missing or marked unsupported by Ollama: ${missingDocs.join(', ')}`,
    );
  }

  const unsupportedSection = unsupportedFieldSection(docs, contract.endpoint);
  const fallbackUnsupportedSection = unsupportedFieldSection(fallbackDocs, contract.endpoint);
  const unsupportedEvidence = unsupportedSection || fallbackUnsupportedSection;
  const unsupportedDocs = (contract.unsupportedFields ?? []).filter((field) => {
    const aliases = contract.docAliases?.[field] ?? [field];
    return (
      !docsMentionField(unsupportedEvidence, aliases) &&
      !explicitlyUnsupported(unsupportedEvidence, aliases) &&
      !explicitlyUnsupported(docs, aliases)
    );
  });

  if (unsupportedDocs.length > 0) {
    throw new Error(
      `[${contract.id}] Explicitly unsupported field(s) changed status in Ollama docs: ${unsupportedDocs.join(', ')}`,
    );
  }
  const nestedUnsupported = contract.nestedUnsupportedFields ?? [];
  const nestedEvidence = unsupportedSection || fallbackUnsupportedSection;
  const invalidNestedUnsupported = nestedUnsupported.filter((path) => {
    const leaf = nestedFieldName(path);
    return (
      !docsMentionField(nestedEvidence, [leaf]) &&
      !explicitlyUnsupported(nestedEvidence, [leaf]) &&
      !explicitlyUnsupported(docs, [leaf])
    );
  });
  if (invalidNestedUnsupported.length > 0) {
    throw new Error(
      `[${contract.id}] Nested unsupported field(s) lack explicit Ollama unsupported evidence: ${invalidNestedUnsupported.join(', ')}`,
    );
  }

  const sdkOnlyEvidence = requestFields || fallbackRequestFields;
  const sdkOnlyDocs = (contract.sdkOnlyFields ?? []).filter((field) => {
    const aliases = contract.docAliases?.[field] ?? [field];
    return aliases.some((alias) =>
      sdkOnlyEvidence.includes('[Input] `' + alias + '`'),
    );
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
    const fallbackResponseSection =
      responseFieldSection(fallbackDocs, contract.endpoint) || fallbackDocs;
    const missingResponseDocs = contract.response.fields.filter((field) => {
      const aliases = contract.response?.docAliases?.[field] ?? [field];
      return firstKnownStatus(
        responseSection,
        fallbackResponseSection || fallbackDocs,
        aliases,
      ) !== 'supported';
    });
    if (missingResponseDocs.length > 0) {
      throw new Error(
        `[${contract.id}] Response field(s) are missing or marked unsupported by Ollama: ${missingResponseDocs.join(', ')}`,
      );
    }

    const unsupportedResponseEvidence =
      unsupportedFieldSection(docs, contract.endpoint) ||
      unsupportedFieldSection(fallbackDocs, contract.endpoint);
    const unsupportedResponseDocs = (contract.response.unsupportedFields ?? []).filter((field) => {
      const aliases = contract.response?.docAliases?.[field] ?? [field];
      return (
        !docsMentionField(unsupportedResponseEvidence, aliases) &&
        !explicitlyUnsupported(unsupportedResponseEvidence, aliases) &&
        !explicitlyUnsupported(docs, aliases)
      );
    });
    if (unsupportedResponseDocs.length > 0) {
      throw new Error(
        `[${contract.id}] Explicitly unsupported response field(s) changed status in Ollama docs: ${unsupportedResponseDocs.join(', ')}`,
      );
    }

    const sdkOnlyResponseDocs = (contract.response.sdkOnlyFields ?? []).filter((field) => {
      const aliases = contract.response?.docAliases?.[field] ?? [field];
      return firstKnownStatus(
        responseSection,
        fallbackResponseSection || fallbackDocs,
        aliases,
      ) !== 'missing';
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

    if (contract.stream.eventTypes && contract.stream.eventTypes.length > 0) {
      const eventDocs = streamEventSection(docs, contract.endpoint);
      const fallbackEventDocs =
        streamEventSection(fallbackDocs, contract.endpoint) || fallbackDocs;
      const missingDocumentedEvents = contract.stream.eventTypes.filter((eventType) => {
        return firstKnownStatus(
          eventDocs,
          fallbackEventDocs || fallbackDocs,
          [eventType],
        ) !== 'supported';
      });
      if (missingDocumentedEvents.length > 0) {
        throw new Error(
          `[${contract.id}] Documented stream event type(s) are missing from the SDK contract or Ollama docs: ${missingDocumentedEvents.join(', ')}`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  if (manifest.version !== 4) {
    throw new Error(`Unsupported parity manifest version: ${String(manifest.version)}`);
  }

  const docsCache = new Map<string, string>();

  for (const contract of manifest.surfaces) {
    let fallbackDocs = '';
    if (contract.fallbackDocsFile !== undefined) {
      fallbackDocs = readFileSync(
        resolve(ROOT, contract.fallbackDocsFile),
        'utf8',
      );
    } else if (contract.fallbackDocsUrl !== undefined) {
      fallbackDocs = docsCache.get(contract.fallbackDocsUrl) ?? '';
      if (!fallbackDocs) {
        fallbackDocs = await fetchDocs(contract.fallbackDocsUrl);
        docsCache.set(contract.fallbackDocsUrl, fallbackDocs);
      }
    }

    let docs = docsCache.get(contract.docsUrl);
    if (docs === undefined) {
      try {
        docs = await fetchDocs(contract.docsUrl);
        docsCache.set(contract.docsUrl, docs);
      } catch (error) {
        if (!fallbackDocs) throw error;
        console.warn(
          `WARN ${contract.id}: live docs unavailable; using pinned fallback`,
        );
        docs = fallbackDocs;
      }
    }

    const sourceProps =
      contract.interfaceName && contract.sourceFile
        ? sourceProperties(contract.sourceFile, contract.interfaceName)
        : new Set<string>();

    assertContract(contract, docs, fallbackDocs, sourceProps);

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
