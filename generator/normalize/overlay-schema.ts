/**
 * Overlay YAML schema.
 *
 * Overlays augment the structural OpenAPI spec with behavioral truth that
 * OpenAPI cannot express: streaming defaults, local-vs-cloud support,
 * model-dependent capabilities, version constraints, request size limits.
 *
 * Each overlay file declares one {@link OverlayDomain}. The normalizer
 * merges them with the OpenAPI structural operations to produce the
 * canonical IR at {@link contracts/ir/ollama.ir.json}.
 *
 * Wave 5 added `parity` blocks carrying field-level compatibility metadata
 * that the legacy `docs/api-parity.json` manifest used to track. The
 * IR-driven verifier (`scripts/verify-contract-parity.ts`) consumes these
 * blocks instead of the legacy manifest.
 */
import type { CapabilitySupport, ContractStatus, HttpMethod, TransportMode } from '../types.js';

/** A field-level parity entry for one side (request or response) of an operation. */
export interface FieldParity {
  /** Documented and supported by Ollama. */
  readonly fields?: readonly string[];
  /** Explicitly documented as unsupported by Ollama. */
  readonly unsupportedFields?: readonly string[];
  /** Retained by the SDK for compat/vendor reasons but not documented by Ollama. */
  readonly sdkOnlyFields?: readonly string[];
  /** Nested paths like `messages[].content[].cache_control` that are unsupported. */
  readonly nestedUnsupportedFields?: readonly string[];
  /** Aliases used in docs (e.g. `encoding_format` may be doc'd as "encoding format"). */
  readonly docAliases?: Readonly<Record<string, readonly string[]>>;
  /** Aliases used in feature sections (e.g. `logprobs` appears as "Logprobs" heading). */
  readonly featureAliases?: Readonly<Record<string, readonly string[]>>;
  /** The TypeScript interface name (in src/types.ts) that this parity block tracks. */
  readonly interfaceName?: string;
  /** The source file (relative to repo root) where the interface lives. */
  readonly sourceFile?: string;
}

/** Streaming-event union parity metadata. */
export interface StreamParity {
  /** The TypeScript type alias name for the stream event union. */
  readonly unionName: string;
  /** The interface names that comprise the union. */
  readonly interfaceNames: readonly string[];
  /** The wire-level event type strings (e.g. `message_start`). */
  readonly eventTypes?: readonly string[];
}

/** Parity metadata attached to an operation. */
export interface OperationParity {
  /** Legacy surface id (e.g. `native-chat`) — kept for backwards-compat bridge. */
  readonly legacySurfaceId?: string;
  /** URL of the official docs page that documents this operation. */
  readonly docsUrl?: string;
  /** Pinned fallback docs file (MDX or OpenAPI snapshot). */
  readonly fallbackDocsFile?: string;
  /** Request-side field parity. */
  readonly request?: FieldParity;
  /** Response-side field parity. */
  readonly response?: FieldParity;
  /** Streaming-event parity. */
  readonly stream?: StreamParity;
}

/** A single operation's behavioral overlay. */
export interface OverlayOperation {
  /** OpenAPI path this overlay applies to (e.g. `/api/chat`). */
  readonly openapi?: string;
  /** Explicit operation id (for operations not in OpenAPI, like `/v1/systemone`). */
  readonly id?: string;
  readonly method?: HttpMethod;
  /** Override or declare the path (used by operations absent from OpenAPI). */
  readonly path?: string;
  readonly domain?: 'native' | 'openai' | 'anthropic';
  readonly runtime?: {
    readonly streaming?: 'supported' | 'unsupported';
    readonly streamingDefault?: boolean;
    readonly transport?: TransportMode;
  };
  readonly environment?: {
    readonly local?: 'supported' | 'unsupported';
    readonly cloud?: 'supported' | 'unsupported';
  };
  readonly capabilities?: {
    readonly thinking?: CapabilitySupport;
    readonly tools?: CapabilitySupport;
    readonly vision?: CapabilitySupport;
    readonly structuredOutput?: CapabilitySupport;
    readonly logprobs?: CapabilitySupport;
    readonly embeddings?: CapabilitySupport;
  };
  readonly compatibility?: {
    readonly minVersion?: string;
  };
  readonly limits?: {
    readonly maxRequestBytes?: number;
  };
  readonly status?: {
    readonly documented?: boolean;
    readonly deprecated?: boolean;
    readonly experimental?: boolean;
    readonly classification?: ContractStatus;
  };
  readonly notes?: readonly string[];
  /**
   * Field-level parity metadata. Wave 5: migrated here from
   * `docs/api-parity.json`. When present, the IR-driven verifier consults
   * this block instead of the legacy manifest.
   */
  readonly parity?: OperationParity;
  /**
   * Wave 12 (P0 #4): inline request/response schema names. Used by
   * operations whose schemas are declared via the parent overlay's
   * `schemas:` block (rather than sourced from OpenAPI). When set, the
   * normalizer attaches `{ $ref: '#/schemas/<name>' }` to the operation's
   * `request`/`response` fields, which makes the generator emit typed
   * request/response shapes for the operation.
   */
  readonly requestSchema?: string;
  readonly responseSchema?: string;
}

/** Top-level overlay file. */
export interface OverlayDomain {
  readonly version: number;
  readonly service: 'ollama';
  readonly domain?: 'native' | 'openai' | 'anthropic';
  readonly operations: Readonly<Record<string, OverlayOperation>>;
  /** Legacy surface id mapping (keeps the old api-parity.json bridge in sync). */
  readonly parityBridge?: Readonly<Record<string, string>>;
  /**
   * Wave 12 (P0 #4): overlay-declared inline schemas. Used for operations
   * whose request/response shapes are documented by Ollama but absent
   * from the pinned OpenAPI snapshot (e.g. System One). Each entry is a
   * named JSON Schema definition that the normalizer merges into the IR's
   * `schemas` array alongside the OpenAPI-sourced schemas.
   *
   * The overlay is the authoritative source for these schemas — they
   * reflect what the docs say, not what the (incomplete) OpenAPI snapshot
   * happens to contain.
   */
  readonly schemas?: Readonly<Record<string, import('../types.js').JsonSchemaNode>>;
}
