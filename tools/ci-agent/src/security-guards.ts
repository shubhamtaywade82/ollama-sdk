import { FixProposal } from './schemas.js';

const FORBIDDEN_BASENAMES = [
  /^package(?:-lock)?\.json$/i,
  /^Gemfile(?:\.lock)?$/i,
  /^tsconfig.*\.json$/i,
  /^\.env(?:\..+)?$/i,
  /^\..+rc$/i,
  /^\.npmrc$/i,
];

const ALLOWED_DIRECTORIES = ['src', 'lib', 'test', 'tests', 'scripts'];

export function isPathAllowed(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 512) {
    return false;
  }

  // GitHub paths are POSIX paths. Reject alternate separators, absolute paths,
  // NUL bytes, and non-canonical segments before checking the allow-list.
  if (filePath.startsWith('/') || filePath.includes('\\') || filePath.includes('\0')) {
    return false;
  }

  const segments = filePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }

  const basename = segments.at(-1) ?? '';
  if (FORBIDDEN_BASENAMES.some((pattern) => pattern.test(basename))) {
    return false;
  }

  // Only allow files beneath explicitly approved source/test directories.
  // This also rejects workflows, package metadata, CI configuration, and docs.
  return ALLOWED_DIRECTORIES.includes(segments[0] ?? '');
}

export function validateFixProposal(proposal: FixProposal): { valid: boolean; reason?: string } {
  if (proposal.confidence === 'low') {
    return { valid: false, reason: 'Confidence score is too low to apply fix automatically.' };
  }

  if (proposal.files.length === 0 || proposal.files.length > 5) {
    return {
      valid: false,
      reason: `Invalid file count: ${proposal.files.length} (must be 1-5 files).`,
    };
  }

  const seenPaths = new Set<string>();
  for (const file of proposal.files) {
    if (!isPathAllowed(file.path)) {
      return { valid: false, reason: `Path not permitted for automated repair: ${file.path}` };
    }
    if (seenPaths.has(file.path)) {
      return { valid: false, reason: `Duplicate path in automated repair proposal: ${file.path}` };
    }
    seenPaths.add(file.path);

    if (file.content.length > 60_000) {
      return { valid: false, reason: `File content exceeds maximum length: ${file.path}` };
    }
  }

  return { valid: true };
}
