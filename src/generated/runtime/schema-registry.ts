/**
 * Schema registry — maps operationId → request/response Zod schemas.
 *
 * The runtime consults this registry to validate request bodies before
 * sending and response payloads after receiving. This is the runtime
 * enforcement layer described in ADR 0019 (Zod schema generation) and
 * ADR 0020 (runtime validation wiring).
 *
 * The registry is hand-written (not generated) because:
 *   1. Not every operation has a request schema (GET/HEAD have no body).
 *   2. Not every operation has a response schema (DELETE returns 204).
 *   3. The map is small (21 operations) and changes only when overlays
 *      add new operations — at which point the generator should remind
 *      the maintainer to update this file via the contract validator.
 *
 * When `validateRequests: true` is set on `OllamaRuntime` and an
 * operation has no registered request schema, the runtime skips
 * validation (it doesn't fail — the contract just doesn't have a
 * schema for that operation yet).
 */
import type { z } from 'zod';
import { ChatRequestSchema } from '../models/ChatRequest.schema.js';
import { GenerateRequestSchema } from '../models/GenerateRequest.schema.js';
import { EmbedRequestSchema } from '../models/EmbedRequest.schema.js';
import { CreateRequestSchema } from '../models/CreateRequest.schema.js';
import { CopyRequestSchema } from '../models/CopyRequest.schema.js';
import { DeleteRequestSchema } from '../models/DeleteRequest.schema.js';
import { PullRequestSchema } from '../models/PullRequest.schema.js';
import { PushRequestSchema } from '../models/PushRequest.schema.js';
import { ShowRequestSchema } from '../models/ShowRequest.schema.js';

/**
 * Map from operationId → request schema. Response schemas are intentionally
 * NOT registered here — see ADR 0020 for the rationale (response validation
 * would break on legitimate forward-compat extensions to the wire format).
 */
export const requestSchemas: Readonly<Record<string, z.ZodType>> = {
  chat: ChatRequestSchema,
  generate: GenerateRequestSchema,
  embed: EmbedRequestSchema,
  create: CreateRequestSchema,
  copy: CopyRequestSchema,
  delete: DeleteRequestSchema,
  pull: PullRequestSchema,
  push: PushRequestSchema,
  show: ShowRequestSchema,
  // Operations without a registered request schema (blobs, ps, tags,
  // version, systemOne, openai*, anthropic*) skip validation. This is
  // deliberate — the OpenAPI spec doesn't define request bodies for
  // GET/HEAD operations, and the compat-surface request schemas (OpenAI,
  // Anthropic) are richer than what the IR currently models.
};

/** Look up a request schema by operationId. Returns `undefined` if no schema exists. */
export function getRequestSchema(operationId: string): z.ZodType | undefined {
  return requestSchemas[operationId];
}
