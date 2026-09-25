# ADR 0010: Ollama Compatibility Contract and Support Classification

## Status

Accepted

## Context

OpenAI and Anthropic compatibility APIs expose large provider contracts, while Ollama implements documented subsets of those contracts. A simple field-presence check is not enough: current Ollama documentation can mention a field while explicitly marking it unsupported, and the SDK also intentionally retains some compatibility or vendor-specific fields for interoperability.

The SDK also reconstructs streaming responses from typed event interfaces. Removing an event type from a public union can therefore create a breaking change even when the HTTP request/response behavior still works.

## Decision

The machine-readable docs/api-parity.json contract classifies request and response fields as:

- fields: documented and supported by Ollama.
- unsupportedFields: explicitly documented as unsupported by Ollama.
- sdkOnlyFields: retained by the SDK for compatibility/vendor behavior but not currently documented as supported by Ollama.

The executable verifier enforces those classifications against the current Ollama documentation and verifies that all tracked fields still exist in their public TypeScript interfaces.

For selected compatibility surfaces, the contract also tracks public response interfaces and streaming-event type unions. This is an implementation-surface invariant rather than a claim that Ollama documents every OpenAI streaming event.

Broad compatibility request types remain available. Strict Ollama-scoped request aliases are additionally exported so applications can opt into compile-time enforcement of the documented subset.

## Rationale

This preserves interoperability without conflating compatibility typing with actual Ollama support. It also makes upstream documentation changes actionable: a field moving from unsupported to supported must be reclassified, an SDK-only field becoming documented must be reviewed, and a removed public stream event fails the parity gate.

## Consequences

The parity manifest becomes a versioned compatibility contract that reviewers can inspect without reading executable verifier logic. The SDK carries a small amount of intentional type surface beyond the documented Ollama subset, but that surface is now explicitly classified rather than silently mixed with supported fields.

Changes to the Ollama compatibility documentation can fail CI even when runtime tests still pass, which is intentional: documentation drift is treated as a contract change requiring a deliberate update.
