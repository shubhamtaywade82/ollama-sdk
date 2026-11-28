export interface MinimizedFailureLog {
  errorSummary: string;
  relevantFiles: string[];
}

const ERROR_PATTERNS = [
  /FAIL\s+.+/i,
  /Error:\s+.+/i,
  /AssertionError:\s+.+/i,
  /Expected:.+/i,
  /Received:.+/i,
  /error TS\d+:.+/i,
  /failed with exit code \d+/i,
  /npm (?:error|ERR!)\s+.+/i,
  /ERESOLVE(?:\s+.+)?/i,
  /unable to resolve dependency tree/i,
  /could not resolve dependency/i,
  /peer dependency/i,
  /pnpm (?:error|ERR!)\s+.+/i,
  /yarn error\s+.+/i,
];

// Strips ANSI terminal escape sequences to save context window tokens.
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

export function minimizeFailureLogs(rawLogs: string): MinimizedFailureLog {
  const cleanLogs = stripAnsi(rawLogs);
  const matchedLines: string[] = [];
  const fileCandidates = new Set<string>();

  for (const line of cleanLogs.split('\n')) {
    const trimmed = line.trim();
    if (ERROR_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      matchedLines.push(trimmed);
    }

    // Match file paths like src/foo.ts:12:34.
    const fileMatch = trimmed.match(
      /(?:at\s+|in\s+)?([a-zA-Z0-9_\-./]+\.(?:ts|js|tsx|jsx|rb)):(\d+)/,
    );
    if (fileMatch && fileMatch[1] && !fileMatch[1].includes('node_modules')) {
      fileCandidates.add(fileMatch[1]);
    }
  }

  const errorSummary = matchedLines.slice(-30).join('\n');
  return {
    errorSummary: errorSummary.slice(0, 8_000),
    relevantFiles: Array.from(fileCandidates).slice(0, 5),
  };
}
