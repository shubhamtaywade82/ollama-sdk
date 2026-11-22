export interface DiffChunk {
  file: string;
  diff: string;
  validLines: Set<number>;
}

const IGNORED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'gemfile.lock']);

const IGNORED_EXTENSIONS = new Set([
  '.lock',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.pdf',
  '.map',
  '.min.js',
  '.min.css',
]);

export function shouldIgnoreFile(filePath: string): boolean {
  if (filePath.startsWith('.git/') || filePath.startsWith('dist/')) return true;
  const normalized = filePath.toLowerCase();
  const fileName = normalized.split('/').pop() ?? normalized;
  if (IGNORED_FILES.has(fileName)) return true;
  const ext = fileName.slice(fileName.lastIndexOf('.'));
  return IGNORED_EXTENSIONS.has(ext);
}

export function parseUnifiedDiff(rawDiff: string): DiffChunk[] {
  const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);
  const chunks: DiffChunk[] = [];

  for (const section of fileSections) {
    const fileMatch = section.match(/^a\/(.*?)\s+b\/(.*?)$/m);
    if (!fileMatch) continue;

    const filePath = fileMatch[2] ?? fileMatch[1];
    if (shouldIgnoreFile(filePath)) continue;

    const validLines = extractAddedLineNumbers(section);
    if (validLines.size === 0) continue;

    chunks.push({
      file: filePath,
      diff: section.slice(0, 8000), // Cap hunk size to avoid context exhaustion
      validLines,
    });
  }

  return chunks;
}

function extractAddedLineNumbers(section: string): Set<number> {
  const lines = new Set<number>();
  let currentNewLine = 0;
  let inHunk = false;

  for (const rawLine of section.split('\n')) {
    const hunkHeader = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader && hunkHeader[1]) {
      currentNewLine = parseInt(hunkHeader[1], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      lines.add(currentNewLine);
      currentNewLine += 1;
    } else if (rawLine.startsWith(' ')) {
      currentNewLine += 1;
    }
  }

  return lines;
}
