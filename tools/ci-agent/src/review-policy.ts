import type { DiffChunk } from './diff-parser.js';
import type { ReviewFinding } from './schemas.js';

export const MAX_REVIEW_FILES = 8;
export const MAX_REVIEW_INPUT_CHARS = 28_000;
export const MAX_FINDINGS_TOTAL = 12;
export const MAX_FINDINGS_PER_FILE = 2;

const SENSITIVE_PATH = /(^|\/)(\.github\/|security|auth|crypto|permission|token|secret|release|publish|workflow)/i;

export function isSensitiveReviewPath(path: string): boolean {
  return SENSITIVE_PATH.test(path);
}

export function selectReviewChunks(
  chunks: DiffChunk[],
  maxFiles = MAX_REVIEW_FILES,
  maxChars = MAX_REVIEW_INPUT_CHARS,
): DiffChunk[] {
  const ranked = [...chunks].sort((a, b) => {
    const riskDelta = Number(isSensitiveReviewPath(b.file)) - Number(isSensitiveReviewPath(a.file));
    return riskDelta || a.file.localeCompare(b.file);
  });
  const selected: DiffChunk[] = [];
  let usedChars = 0;
  for (const chunk of ranked) {
    if (selected.length >= maxFiles) break;
    if (chunk.diff.length > maxChars - usedChars) continue;
    selected.push(chunk);
    usedChars += chunk.diff.length;
  }
  return selected;
}

export function filterReviewFindings(
  findings: ReviewFinding[],
  chunk: DiffChunk,
  limits: { total?: number; perFile?: number } = {},
): ReviewFinding[] {
  const totalLimit = limits.total ?? MAX_FINDINGS_TOTAL;
  const perFileLimit = limits.perFile ?? MAX_FINDINGS_PER_FILE;
  const seen = new Set<string>();
  const accepted: ReviewFinding[] = [];
  for (const finding of findings) {
    if (finding.file !== chunk.file || !chunk.validLines.has(finding.line)) continue;
    if (finding.severity === 'info' || finding.confidence === 'low') continue;
    const key = `${finding.file}:${finding.line}:${finding.message.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (accepted.length >= Math.min(totalLimit, perFileLimit)) break;
    accepted.push(finding);
  }
  return accepted;
}

export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
