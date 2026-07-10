// JSON Schema derivation — architecture ADR-01: "JSON Schema is derived...
// for every agent-facing surface (MCP tool inputs/outputs, outputSchema in
// llm.extract/llm.classify, CLI --input validation)."
//
// Zod 4 ships a native `z.toJSONSchema()` (verified against the installed
// zod@4.4.3 during this session — it correctly emits a `oneOf` with a
// `const` literal per member's discriminant for a z.discriminatedUnion,
// which is exactly the case this package's DoD requires tested:
// WaitCondition/Trigger). This module wraps it rather than depending on the
// third-party `zod-to-json-schema` package: that package still declares
// Zod-4 peer-dependency support, but Zod 4's own conversion is first-party,
// removes a dependency, and avoids any risk of drift against Zod 4's
// internal schema representation. See this task's final report for the
// fuller rationale/decision record.
import { z } from "zod";
import type { JSONSchema } from "./block.js";

export interface ToJsonSchemaOptions {
  /** Passed through to zod's `unrepresentable` option — defaults to "any" so a z.unknown()/z.custom() field degrades to an unconstrained `{}` schema instead of throwing. */
  unrepresentable?: "throw" | "any";
}

/** Derive a JSON Schema document from any Zod schema in this package. */
export function toJsonSchema(schema: z.ZodType, options: ToJsonSchemaOptions = {}): JSONSchema {
  return z.toJSONSchema(schema, { unrepresentable: options.unrepresentable ?? "any" }) as JSONSchema;
}
