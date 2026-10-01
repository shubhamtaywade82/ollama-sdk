/**
 * Generated runtime entrypoint.
 *
 * Re-exports the hand-written seam ({@link OllamaRuntime} +
 * {@link OperationDefinition}) that every generated API class depends on.
 * This is the only file in `src/generated/runtime/` that is NOT
 * auto-generated.
 */
export { OllamaRuntime, type OllamaRuntimeOptions } from './runtime.js';
export {
  type OperationDefinition,
  type InvokeRequest,
  type SchemaRef,
} from './operation-definition.js';
