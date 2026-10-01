/**
 * Compatibility validator.
 *
 * Lightweight cross-overlay sanity checks that catch inconsistencies the
 * structural validators don't:
 *
 *   - No two overlays may declare the same operation id or the same path.
 *   - Operations claiming `transport: ndjson` must have `streaming: supported`.
 *   - Operations in the `openai` domain must live under `/v1/...` paths.
 *   - Operations in the `anthropic` domain must live under `/v1/messages` paths.
 *
 * This is intentionally minimal — it complements, not replaces, the
 * schema validator and the endpoint discovery validator.
 */
import type { OperationContract } from '../types.js';

export interface CompatibilityResult {
  readonly errors: readonly string[];
}

function startsWith(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix);
}

/** Validate the merged operations list for cross-overlay consistency. */
export function validateCompatibility(
  operations: readonly OperationContract[],
): CompatibilityResult {
  const errors: string[] = [];

  const seenIds = new Map<string, string>();
  const seenPaths = new Map<string, string>();

  for (const op of operations) {
    const prevId = seenIds.get(op.id);
    if (prevId !== undefined) {
      errors.push(
        `Duplicate operation id "${op.id}" (paths ${prevId} and ${op.path}). ` +
          `Each operation id must be unique across all overlays.`,
      );
    } else {
      seenIds.set(op.id, op.path);
    }

    const pathKey = `${op.method} ${op.path}`;
    const prevPath = seenPaths.get(pathKey);
    if (prevPath !== undefined) {
      errors.push(
        `Duplicate path "${pathKey}" declared by operations "${prevPath}" and "${op.id}".`,
      );
    } else {
      seenPaths.set(pathKey, op.id);
    }

    if (op.transport.mode === 'ndjson' && !op.transport.streaming) {
      errors.push(
        `Operation "${op.id}" declares transport=ndjson but streaming=false. ` +
          `ndjson is a streaming transport; declare streaming=supported.`,
      );
    }

    if (op.domain === 'openai' && !startsWith(op.path, '/v1/')) {
      errors.push(
        `Operation "${op.id}" is in domain=openai but path "${op.path}" does not start with /v1/. ` +
          `OpenAI compatibility operations must live under /v1/...`,
      );
    }
    if (op.domain === 'anthropic' && !startsWith(op.path, '/v1/messages')) {
      errors.push(
        `Operation "${op.id}" is in domain=anthropic but path "${op.path}" is not /v1/messages. ` +
          `Anthropic compatibility is currently scoped to /v1/messages.`,
      );
    }
  }

  return { errors };
}
