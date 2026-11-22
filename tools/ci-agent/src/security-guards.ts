import { FixProposal } from './schemas.js';

const FORBIDDEN_PATHS = [
  /^\.github\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^Gemfile(\.lock)?$/,
  /tsconfig.*\.json$/,
  /\.env(\..+)?$/,
  /^\..+rc/,
];

const ALLOWED_DIRECTORIES = [/^src\//, /^lib\//, /^test\//, /^tests\//, /^scripts\//];

export function isPathAllowed(filePath: string): boolean {
  if (FORBIDDEN_PATHS.some((regex) => regex.test(filePath))) {
    return false;
  }
  return ALLOWED_DIRECTORIES.some((regex) => regex.test(filePath));
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

  for (const file of proposal.files) {
    if (!isPathAllowed(file.path)) {
      return { valid: false, reason: `Path not permitted for automated repair: ${file.path}` };
    }
    if (file.content.length > 60_000) {
      return { valid: false, reason: `File content exceeds maximum length: ${file.path}` };
    }
  }

  return { valid: true };
}
