// Output-schema validation — architecture §12.3: "All implemented as
// explicit, schema-validated calls per §7.2's 'AART is a runtime, not an
// LLM brain' principle — never a free-form 'ask the LLM what to do'
// runtime path." A provider returning syntactically-valid JSON is not
// enough; it must also conform to the SHAPE the workflow author declared.
// Named import (not the default) — ajv ships both, and the named form
// sidesteps a CJS/ESM default-interop mismatch under this repo's
// verbatimModuleSyntax + NodeNext tsconfig (`import Ajv from "ajv"` resolves
// to the module namespace object under this combination, not the
// constructable class, and fails `tsc -b` with "This expression is not
// constructable" even though vitest's looser esbuild transform accepts it).
import { Ajv, type ErrorObject } from "ajv";
import { LlmOutputSchemaValidationError } from "./errors.js";

// `strict: false` — the schemas validated here are workflow-author-supplied
// (arbitrary JSON Schema, resolved from a `schemas.<name>` registry entry
// or written inline), not a fixed internal contract this package controls
// the shape of. Ajv's strict mode rejects several JSON-Schema-legal
// constructs (unknown keywords, some format-without-full-RFC-validator
// combinations) that a workflow author's schema may legitimately use —
// failing validation setup on those would be a worse failure mode than
// validating loosely, since the whole point of this function is to catch
// SHAPE mismatches in the LLM's output, not to police the schema author's
// JSON Schema style.
const ajv = new Ajv({ allErrors: true, strict: false });

export interface ValidateOutputContext {
  /** The full workflow-authored model id (e.g. "anthropic/claude-sonnet-5") — for error messages only. */
  model: string;
  /** The resolved schema's ref (e.g. "schemas.energy_bill", or "inline") — for error messages only. */
  ref: string;
}

/**
 * Throws `LlmOutputSchemaValidationError` if `output` doesn't conform to
 * `schema`. Pure validation — does not mutate `output`, does not coerce
 * types. Callers (the llm.* block core functions) call this after a
 * provider adapter has already JSON-parsed the raw response text; this is
 * the SECOND check ("is it valid JSON" is the adapter's own
 * `LlmOutputParseError`; "does it match the declared shape" is this one).
 */
export function validateAgainstSchema(output: unknown, schema: unknown, context: ValidateOutputContext): void {
  const validate = ajv.compile(schema as Record<string, unknown>);
  const valid = validate(output);
  if (!valid) {
    throw new LlmOutputSchemaValidationError({
      message: `LLM output failed validation against ${context.ref} (model "${context.model}"): ${ajv.errorsText(validate.errors)}`,
      detail: { errors: (validate.errors ?? []) as ErrorObject[], output, ref: context.ref, model: context.model },
    });
  }
}
