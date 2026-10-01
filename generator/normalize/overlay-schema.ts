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
 */
import type { CapabilitySupport, ContractStatus, HttpMethod, TransportMode } from '../types.js';

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
}

/** Top-level overlay file. */
export interface OverlayDomain {
  readonly version: number;
  readonly service: 'ollama';
  readonly domain?: 'native' | 'openai' | 'anthropic';
  readonly operations: Readonly<Record<string, OverlayOperation>>;
  /** Legacy surface id mapping (keeps the old api-parity.json bridge in sync). */
  readonly parityBridge?: Readonly<Record<string, string>>;
}
