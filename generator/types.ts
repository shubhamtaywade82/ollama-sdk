/**
 * Canonical Ollama contract IR.
 *
 * This is the single source of truth that all generators (TypeScript types,
 * MCP tool schemas, capability metadata, docs) consume. It is produced by
 * {@link ../normalize/contract-normalizer.ts} from:
 *
 *   - the upstream OpenAPI spec (structural truth: paths, methods, schemas)
 *   - overlay YAML files (behavioral truth: streaming, capabilities, env)
 *
 * The IR is intentionally a hand-written, plain-data TypeScript module so it
 * can be consumed by `generator/`, `scripts/`, and `test/` without pulling in
 * runtime SDK code. This keeps the contract layer a pure build-time concern.
 */

/** HTTP methods that Ollama exposes. */
export type HttpMethod = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';

/**
 * Truth level for an operation or feature.
 *
 * This replaces the old three-level model (`supported` / `unsupported` /
 * `sdkOnly`) with a richer vocabulary that matches how Ollama documents its
 * own surface — see ADR 0013.
 */
export type ContractStatus =
  /** Documented in the official docs/OpenAPI and supported by the SDK. */
  | 'documented'
  /** Implemented in the SDK but not yet documented by Ollama. */
  | 'undocumented'
  /** Documented and explicitly unsupported (Ollama marks it as such). */
  | 'unsupported'
  /** Documented as experimental; behavior may change between releases. */
  | 'experimental'
  /** Documented as deprecated; may be removed in a future release. */
  | 'deprecated'
  /** Supported only on Ollama >= a specific version (see {@link OperationContract.constraints.minOllamaVersion}). */
  | 'version-dependent'
  /** Supported only on certain models (see {@link OperationContract.capabilities}). */
  | 'model-dependent'
  /** Supported depending on runtime environment (local vs cloud, server config). */
  | 'runtime-dependent';

/**
 * Capability support level for an operation. Capabilities are intentionally
 * a discriminated union rather than a boolean — `model-dependent` and
 * `version-dependent` are first-class concepts in the Ollama docs and must
 * be expressible in the contract, not hidden behind runtime `if` checks.
 */
export type CapabilitySupport =
  'supported' | 'unsupported' | 'model-dependent' | 'version-dependent';

/** Wire-format used to transport request/response bodies. */
export type TransportMode = 'json' | 'ndjson' | 'sse';

/** Reference to a named schema in {@link OllamaContract.schemas}. */
export interface SchemaRef {
  readonly $ref: string;
}

/** Structural schema declaration, sourced from OpenAPI. */
export interface SchemaContract {
  readonly name: string;
  readonly source: {
    readonly openapi?: string;
    readonly overlay?: string;
  };
  readonly description?: string;
}

/** Runtime/behavioral overlay applied to a single operation. */
export interface OperationContract {
  /** Stable operation id (e.g. `chat`, `systemOne`, `openaiChatCompletions`). */
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;

  readonly request?: SchemaRef;
  readonly response?: SchemaRef;

  readonly environment: {
    readonly local: boolean;
    readonly cloud: boolean;
  };

  readonly transport: {
    readonly mode: TransportMode;
    readonly streaming: boolean;
    readonly streamingDefault?: boolean;
  };

  readonly capabilities: {
    readonly thinking?: CapabilitySupport;
    readonly tools?: CapabilitySupport;
    readonly vision?: CapabilitySupport;
    readonly structuredOutput?: CapabilitySupport;
    readonly logprobs?: CapabilitySupport;
    readonly embeddings?: CapabilitySupport;
  };

  readonly constraints?: {
    readonly minOllamaVersion?: string;
    readonly maxRequestBytes?: number;
  };

  readonly status: {
    readonly documented: boolean;
    readonly deprecated?: boolean;
    readonly experimental?: boolean;
  };

  /**
   * Contract domain this operation belongs to. Native Ollama operations live
   * in `native`; OpenAI-compatibility operations live in `openai`; Anthropic
   * compatibility operations live in `anthropic`. This drives which overlay
   * file contributes their behavioral metadata.
   */
  readonly domain: 'native' | 'openai' | 'anthropic';

  /** Free-form notes carrying the source rationale (e.g. "documented as local-only"). */
  readonly notes?: readonly string[];
}

/**
 * Backwards-compatible bridge to the legacy {@link docs/api-parity.json}
 * surface id (`native-chat`, `openai-responses`, etc.). Wave 1 keeps both
 * worlds in sync; later waves retire the legacy manifest.
 */
export interface ParitySurfaceMapping {
  readonly operationId: string;
  readonly legacySurfaceId: string;
  readonly legacyEndpoint: string;
}

/** Top-level canonical IR. */
export interface OllamaContract {
  readonly contractVersion: number;
  readonly observedOllamaVersion?: string;
  readonly generatedAt: string;
  readonly sourceHash: string;
  readonly operations: readonly OperationContract[];
  readonly schemas: readonly SchemaContract[];
  readonly parityBridge: readonly ParitySurfaceMapping[];
}

/** Result returned by the bidirectional endpoint discovery validator. */
export interface EndpointDiscoveryReport {
  readonly declared: readonly string[];
  readonly discovered: readonly string[];
  readonly missingDeclared: readonly string[];
  readonly undeclaredDiscovered: readonly string[];
}

/** Classification of a single IR diff entry, used by `scripts/diff-contract.ts`. */
export type ContractDiffKind =
  | 'add-operation'
  | 'remove-operation'
  | 'add-field'
  | 'remove-field'
  | 'change-status'
  | 'change-capability'
  | 'change-transport'
  | 'change-environment'
  | 'change-constraints'
  | 'documentation-only';

/** A single diff entry produced when comparing two IR versions. */
export interface ContractDiffEntry {
  readonly kind: ContractDiffKind;
  readonly operationId: string;
  readonly path?: string;
  readonly before?: string;
  readonly after?: string;
  /** Semver-impact classification — advisory, since Ollama is not strictly versioned. */
  readonly impact: 'major' | 'minor' | 'patch' | 'none';
}
