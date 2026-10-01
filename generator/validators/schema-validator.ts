/**
 * Overlay schema validator.
 *
 * Each `contracts/overlays/*.yaml` file must conform to the {@link OverlayDomain}
 * shape: a `version`, a `service: ollama` discriminator, and an `operations`
 * map where every value declares either an `openapi:` reference (pointing at
 * a path in the upstream OpenAPI spec) or an explicit `path:` + `method:`
 * (for operations like `/v1/systemone` that aren't in OpenAPI).
 *
 * This validator catches malformed overlays at build time rather than letting
 * them silently produce a broken IR.
 */
import type { OverlayDomain, OverlayOperation } from '../normalize/overlay-schema.js';

export interface OverlayValidationResult {
  readonly file: string;
  readonly errors: readonly string[];
}

function validateOperation(key: string, op: OverlayOperation): string[] {
  const errors: string[] = [];
  if (!op.openapi && !op.path) {
    errors.push(
      `Operation "${key}" must declare either \`openapi:\` or \`path:\`. ` +
        `Use \`openapi: /api/chat\` to inherit structure from the OpenAPI spec, ` +
        `or \`path: /v1/systemone\` + \`method: POST\` for endpoints not in OpenAPI.`,
    );
  }
  if (op.path && !op.method) {
    errors.push(
      `Operation "${key}" declares \`path:\` without \`method:\`. ` +
        `Explicit path declarations must also declare the HTTP method.`,
    );
  }
  if (op.runtime?.streaming === 'supported' && op.runtime?.transport === 'json') {
    errors.push(
      `Operation "${key}" declares streaming=supported but transport=json. ` +
        `Streaming operations must use ndjson or sse.`,
    );
  }
  const caps = op.capabilities;
  if (caps) {
    const validCapValues = ['supported', 'unsupported', 'model-dependent', 'version-dependent'];
    for (const [name, value] of Object.entries(caps)) {
      if (value !== undefined && !validCapValues.includes(value)) {
        errors.push(
          `Operation "${key}".capabilities.${name}="${String(value)}" is not a valid CapabilitySupport value. ` +
            `Allowed: ${validCapValues.join(' | ')}.`,
        );
      }
    }
  }
  if (op.environment) {
    for (const envKey of ['local', 'cloud'] as const) {
      const value = op.environment[envKey];
      if (value !== undefined && value !== 'supported' && value !== 'unsupported') {
        errors.push(
          `Operation "${key}".environment.${envKey}="${String(value)}" is not valid. ` +
            `Allowed: supported | unsupported.`,
        );
      }
    }
  }
  return errors;
}

/** Validate a single parsed overlay file. */
export function validateOverlay(file: string, domain: OverlayDomain): OverlayValidationResult {
  const errors: string[] = [];
  if (domain.version !== 1) {
    errors.push(`Overlay version must be 1 (got ${String(domain.version)}).`);
  }
  if (domain.service !== 'ollama') {
    errors.push(`Overlay service must be "ollama" (got "${String(domain.service)}").`);
  }
  if (!domain.operations || typeof domain.operations !== 'object') {
    errors.push('Overlay must declare an `operations:` map.');
    return { file, errors };
  }
  for (const [key, op] of Object.entries(domain.operations)) {
    errors.push(...validateOperation(key, op));
  }
  return { file, errors };
}
