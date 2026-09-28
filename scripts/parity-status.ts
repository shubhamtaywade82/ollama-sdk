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

export function nestedFieldName(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] ?? path;
}
