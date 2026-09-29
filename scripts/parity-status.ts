export type DocFieldStatus = 'supported' | 'unsupported' | 'missing';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\\]\\]/g, '\\$&');
}

export function docsFieldStatus(
  docs: string,
  aliases: readonly string[],
): DocFieldStatus {
  const lines = docs.split(/\r?\n/);

  for (const field of aliases) {
    const exactSupported = lines.some((line) =>
      line.includes('- [x] `' + field + '`') ||
      line.includes('* [x] `' + field + '`') ||
      line.includes('[Input] `' + field + '`') ||
      line.includes('Input] `' + field + '`'),
    );
    if (exactSupported) return 'supported';

    const exactUnsupported = lines.some((line) =>
      line.includes('- [ ] `' + field + '`') ||
      line.includes('* [ ] `' + field + '`'),
    );
    if (exactUnsupported) return 'unsupported';
  }

  for (const line of lines) {
    if (aliases.some((field) => {
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
    })) {
      return 'supported';
    }
  }

  return 'missing';
}

export function supportedFeatureStatus(
  docs: string,
  aliases: readonly string[],
): DocFieldStatus {
  const lines = docs.split(/\r?\n/);
  const featureHeading = lines.findIndex(
    (line) => normalizedHeadingText(line) === 'supported features',
  );
  if (featureHeading < 0) return 'missing';

  for (let index = featureHeading + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const normalized = normalizedHeadingText(line);
    if (/^#{2,6}\s+/.test(line.trim())) break;
    if (aliases.some((alias) => {
      const escaped = escapeRegExp(alias);
      return (
        new RegExp('\\[Input\\]\\s*' + escaped + '$', 'i').test(line.trim()) ||
        new RegExp(
          '(?:^|[^A-Za-z0-9_])' + escaped + '(?:$|[^A-Za-z0-9_])',
          'i',
        ).test(normalized)
      );
    })) {
      return 'supported';
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

export function docsMentionField(
  docs: string,
  aliases: readonly string[],
): boolean {
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
      if (
        value === field ||
        value.startsWith(field + ':') ||
        value.startsWith('- ' + field + ':')
      ) return true;
      const tokenPattern = new RegExp(
        '(?:^|[^A-Za-z0-9_])' + escapeRegExp(field) + '(?:$|[^A-Za-z0-9_])',
        'i',
      );
      return tokenPattern.test(line);
    }),
  );
}

export function explicitlyUnsupported(
  docs: string,
  aliases: readonly string[],
): boolean {
  return aliases.some((field) => {
    const escaped = escapeRegExp(field);
    return (
      new RegExp(escaped + '[^\\n]{0,160}(?:not supported|unsupported)', 'i').test(docs) ||
      new RegExp('(?:not supported|unsupported)[^\\n]{0,160}' + escaped, 'i').test(docs)
    );
  });
}

function normalizedHeadingText(line: string): string {
  return line.trim().replace(/^#{1,6}\s+/, '').replace(/\s+/g, ' ').toLowerCase();
}

function isEndpointCandidate(line: string, endpoint: string): boolean {
  const trimmed = line.trim();
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
  const end = candidates.find((index) => index > start);
  return lines.slice(start, end ?? lines.length).join('\n');
}
export function nestedFieldName(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] ?? path;
}
