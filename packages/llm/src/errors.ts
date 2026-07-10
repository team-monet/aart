// Package-local error classes for @aart/llm. These extend the frozen
// `AartError` base (`@aart/types`, architecture §8) — that base class and
// its `errorClass`/`detail`/`toJSON()` contract are exported for exactly
// this kind of reuse ("every subclass carries enough structure to appear
// distinctly in StepTrace.error"). None of the ten @aart/types-defined
// AartError subclasses (ValidationError, CapabilityDeniedError, ...) map
// cleanly onto "unknown provider prefix" or "provider output failed
// outputSchema validation" — these are genuinely llm-package-specific
// failure modes, so this package defines its own subclasses of the same
// base rather than force-fitting one of the ten or inventing an unrelated
// plain Error hierarchy. This does not touch packages/types/** (no
// AMENDMENTS.md entry needed) — it's ordinary subclassing of an exported
// abstract class, the same as any consumer of @aart/types could do.
import { AartError } from "@aart/types";

/** `model` did not parse as `provider/model`, or its provider segment has no registered adapter (architecture §12.1/spec §22.4). */
export class UnknownProviderError extends AartError {
  readonly errorClass = "UnknownProviderError" as const;
}

/** A provider call requested structured (`outputSchema`) output but returned text that did not parse as JSON at all. Distinct from `LlmOutputSchemaValidationError` (valid JSON, wrong shape). */
export class LlmOutputParseError extends AartError {
  readonly errorClass = "LlmOutputParseError" as const;
}

/** A provider call's output failed validation against the resolved `outputSchema` (architecture §12.3: "each a schema-validated wrapper, never a free-form runtime LLM call"). */
export class LlmOutputSchemaValidationError extends AartError {
  readonly errorClass = "LlmOutputSchemaValidationError" as const;
}

/** A provider's HTTP API returned a non-2xx response. */
export class ProviderHttpError extends AartError {
  readonly errorClass = "ProviderHttpError" as const;
}

/** `llm.extract`/`llm.classify` were called without a resolvable `outputSchema` (promptRef/schemaRef missing, or neither an inline schema nor a ref was given) — these wrappers require one per their own convention (architecture §12.3). */
export class MissingOutputSchemaError extends AartError {
  readonly errorClass = "MissingOutputSchemaError" as const;
}

/** Neither `prompt` nor `promptRef` was set on an `LlmCallStep` — at least one is required to make an actual call. */
export class MissingPromptError extends AartError {
  readonly errorClass = "MissingPromptError" as const;
}

/** A `prompts.<name>`/`schemas.<name>` ref string didn't follow that syntax (architecture §12.2/spec §22.2). */
export class InvalidRegistryRefError extends AartError {
  readonly errorClass = "InvalidRegistryRefError" as const;
}

/** A `prompts.<name>`/`schemas.<name>` ref resolved to zero registered versions. */
export class UnresolvedRegistryRefError extends AartError {
  readonly errorClass = "UnresolvedRegistryRefError" as const;
}

/** Attempted to register a (name, version) pair that already exists with DIFFERENT content — registry entries are immutable once published (architecture §12.2: "independently versioned... a prompt can be revised without touching the workflow", which only holds if an existing version's content never silently changes under it). Re-registering the SAME content for an existing (name, version) is a no-op, not an error. */
export class RegistryVersionImmutableError extends AartError {
  readonly errorClass = "RegistryVersionImmutableError" as const;
}
