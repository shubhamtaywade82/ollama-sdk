/**
 * Live-docs fetcher and field-status extractor.
 *
 * Wave 7 port of `scripts/_legacy/parity-status.ts` +
 * `scripts/_legacy/verify-api-parity.ts` (the live-docs half), lifted
 * into `generator/parser/` so the IR-driven verifier can consume them
 * without depending on the retired legacy verifier.
 *
 * These functions hit the network (https://docs.ollama.com/...) and should
 * only be called from the verifier CLI, never from runtime code.
 */

export type DocFieldStatus = 'supported' | 'unsupported' | 'missing';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function normalizedHeadingText(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Determine whether a field is mentioned in the docs as supported, unsupported, or missing. */
export function docsFieldStatus(docs: string, aliases: readonly string[]): DocFieldStatus {
  const lines = docs.split(/\r?\n/);

  for (const field of aliases) {
    const exactSupported = lines.some(
      (line) =>
        line.includes('- [x] `' + field + '`') ||
        line.includes('* [x] `' + field + '`') ||
        line.includes('[Input] `' + field + '`') ||
        line.includes('Input] `' + field + '`'),
    );
    if (exactSupported) return 'supported';

    const exactUnsupported = lines.some(
      (line) => line.includes('- [ ] `' + field + '`') || line.includes('* [ ] `' + field + '`'),
    );
    if (exactUnsupported) return 'unsupported';
  }

  for (const line of lines) {
    if (
      aliases.some((field) => {
        const forms = [
          '`' + field + '`',
          '<code>' + field + '</code>',
          '"' + field + '":',
          "'" + field + "':",
          '| ' + field + ' |',
          '<td>' + field + '</td>',
        ];

        if (forms.some((form) => line.includes(form))) return true;

        const value = line.trim();
        if (
          value === field ||
          value.startsWith(field + ':') ||
          value.startsWith('- ' + field + ':')
        ) {
          return true;
        }

        const tokenPattern = new RegExp(
          '(?:^|[^A-Za-z0-9_])' + escapeRegExp(field) + '(?:$|[^A-Za-z0-9_])',
          'i',
        );
        return tokenPattern.test(line);
      })
    ) {
      return 'supported';
    }
  }

  return 'missing';
}

/** Check the "Supported features" section of a docs page for an alias. */
export function supportedFeatureStatus(docs: string, aliases: readonly string[]): DocFieldStatus {
  const lines = docs.split(/\r?\n/);
  const featureHeading = lines.findIndex(
    (line) => normalizedHeadingText(line) === 'supported features',
  );
  if (featureHeading < 0) return 'missing';

  for (let index = featureHeading + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const normalized = normalizedHeadingText(line);
    if (/^#{2,6}\s+/.test(line.trim())) break;
    if (
      aliases.some((alias) => {
        const escaped = escapeRegExp(alias);
        return (
          new RegExp('\\[Input\\]\\s*' + escaped + '$', 'i').test(line.trim()) ||
          new RegExp('(?:^|[^A-Za-z0-9_])' + escaped + '(?:$|[^A-Za-z0-9_])', 'i').test(normalized)
        );
      })
    ) {
      // An unchecked markdown task item (`* [ ] Logprobs`) lists the feature as
      // explicitly unsupported; only a checked or untagged item counts as support.
      return /^[-*]\s+\[\s\]/.test(line.trim()) ? 'unsupported' : 'supported';
    }
  }

  return 'missing';
}

/**
 * Prefer the live documentation section whenever it is present. The pinned snapshot is a
 * fallback for genuinely unavailable/incomplete rendered sections, not a second authority
 * that can promote a field removed from the live contract.
 */
export function firstKnownStatus(
  primary: string,
  fallback: string,
  aliases: readonly string[],
): DocFieldStatus {
  return primary.trim() !== ''
    ? docsFieldStatus(primary, aliases)
    : docsFieldStatus(fallback, aliases);
}

/** Does the docs body mention any of the aliases anywhere? */
export function docsMentionField(docs: string, aliases: readonly string[]): boolean {
  return docs.split(/\r?\n/).some((line) =>
    aliases.some((field) => {
      const forms = [
        '`' + field + '`',
        '<code>' + field + '</code>',
        '"' + field + '":',
        "'" + field + "':",
        '| ' + field + ' |',
        '<td>' + field + '</td>',
      ];
      if (forms.some((form) => line.includes(form))) return true;
      const value = line.trim();
      if (value === field || value.startsWith(field + ':') || value.startsWith('- ' + field + ':'))
        return true;
      const tokenPattern = new RegExp(
        '(?:^|[^A-Za-z0-9_])' + escapeRegExp(field) + '(?:$|[^A-Za-z0-9_])',
        'i',
      );
      return tokenPattern.test(line);
    }),
  );
}

/** Are any of the aliases explicitly marked unsupported in the docs? */
export function explicitlyUnsupported(docs: string, aliases: readonly string[]): boolean {
  return aliases.some((field) => {
    const escaped = escapeRegExp(field);
    return (
      new RegExp(escaped + '[^\\n]{0,160}(?:not supported|unsupported)', 'i').test(docs) ||
      new RegExp('(?:not supported|unsupported)[^\\n]{0,160}' + escaped, 'i').test(docs)
    );
  });
}

/** Take the leaf segment of a dotted path like `messages[].content[].cache_control`. */
export function nestedFieldName(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] ?? path;
}

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+/.exec(line.trim());
  return match ? (match[1] as string).length : 0;
}

function isEndpointCandidate(line: string, endpoint: string): boolean {
  // Mintlify markdown wraps endpoint paths in backticks (`### \`/v1/messages\``,
  // `` `POST /v1/responses` ``); compare on the bare text.
  const trimmed = line.trim().replace(/`/g, '');
  if (!trimmed || trimmed.includes('http')) return false;
  const escaped = escapeRegExp(endpoint);
  if (new RegExp('^POST\\s+' + escaped + '(?:\\s|$)', 'i').test(trimmed)) return true;
  if (!/^#{2,6}\s+/.test(trimmed)) return false;
  const heading = normalizedHeadingText(line);
  return heading === endpoint.toLowerCase() || heading.endsWith(endpoint.toLowerCase());
}

/** Extract the real API endpoint section, ignoring example headings that merely mention the path. */
export function endpointSection(docs: string, endpoint: string): string {
  const lines = docs.split(/\r?\n/);
  const candidates = lines
    .map((line, index) => (isEndpointCandidate(line, endpoint) ? index : -1))
    .filter((index) => index >= 0);
  if (candidates.length === 0) return '';
  const start = candidates[0] as number;

  // The section runs until the next heading at the same or a higher level than the
  // heading that owns the endpoint (for a bare `POST /path` line, the nearest heading
  // above it). Without this bound, a section would swallow every later endpoint on a
  // multi-endpoint page and pick up their checkbox lists.
  let ownerLevel = headingLevel(lines[start] ?? '');
  for (let index = start - 1; ownerLevel === 0 && index >= 0; index -= 1) {
    ownerLevel = headingLevel(lines[index] ?? '');
  }
  let end = lines.length;
  if (ownerLevel > 0) {
    for (let index = start + 1; index < lines.length; index += 1) {
      const level = headingLevel(lines[index] ?? '');
      if (level > 0 && level <= ownerLevel) {
        end = index;
        break;
      }
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Strip HTML down to a markdown-ish plain-text form. */
export function normalizeHtmlDocs(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level: string, content: string) =>
        '\n' + '#'.repeat(Number(level)) + ' ' + content + '\n',
    )
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

/**
 * Markdown twin of a docs.ollama.com page. Mintlify serves every page as raw
 * markdown at `<page>.md`; unlike the rendered HTML, it preserves the `[x]`/`[ ]`
 * checkbox state that distinguishes supported from explicitly unsupported fields.
 */
export function markdownDocsUrl(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.hostname !== 'docs.ollama.com') return undefined;
  if (/\.(md|mdx|ya?ml|json|txt)$/i.test(parsed.pathname)) return undefined;
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '.md';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Fetch a docs URL and return its body as markdown (preferred) or normalized plain
 * text. The markdown variant is tried first because the HTML render drops checkbox
 * state, which would make every listed field look supported.
 */
export async function fetchDocs(url: string): Promise<string> {
  const markdownUrl = markdownDocsUrl(url);
  if (markdownUrl !== undefined) {
    try {
      const response = await fetch(markdownUrl, {
        headers: { Accept: 'text/markdown, text/plain' },
        signal: AbortSignal.timeout(15_000),
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (response.ok && !contentType.includes('text/html')) {
        return await response.text();
      }
    } catch {
      // Fall through to the rendered HTML page.
    }
  }

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

/** Extract a labeled section under a heading, stopping at any of `stopLabels`. */
export function labeledSection(docs: string, label: string, stopLabels: readonly string[]): string {
  const lines = docs.split(/\r?\n/);
  const normalizedLabel = label.toLowerCase();
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) return false;
    const value = normalizedHeadingText(line);
    return (
      value === normalizedLabel ||
      value.endsWith(normalizedLabel) ||
      value.includes(normalizedLabel)
    );
  });
  if (start < 0) return '';

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const value = normalizedHeadingText(line);
    if (
      stopLabels.some(
        (stop) => value === stop.toLowerCase() || value.endsWith(stop.toLowerCase()),
      ) ||
      (/^#{2,6}\s+/.test(line.trim()) &&
        stopLabels.some((stop) => value.includes(stop.toLowerCase())))
    ) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

/** Extract the "Supported request fields" section under a given endpoint. */
export function requestFieldSection(docs: string, endpoint: string): string {
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

/** Extract the response fields section under a given endpoint. */
export function responseFieldSection(docs: string, endpoint: string): string {
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

/** Extract the streaming events section under a given endpoint. */
export function streamEventSection(docs: string, endpoint: string): string {
  const endpointDocs = endpointSection(docs, endpoint);
  if (!endpointDocs) return '';
  return labeledSection(endpointDocs, 'Streaming events', [
    'Models',
    'Not supported',
    'Partial support',
    'Notes',
  ]);
}

/** Extract the "Not supported" section under a given endpoint. */
export function unsupportedFieldSection(docs: string, endpoint: string): string {
  const stopLabels = ['Partial support', 'Models', 'Notes'];
  const endpointDocs = endpointSection(docs, endpoint);
  return (
    (endpointDocs ? labeledSection(endpointDocs, 'Not supported', stopLabels) : '') ||
    labeledSection(docs, 'Not supported', stopLabels)
  );
}
