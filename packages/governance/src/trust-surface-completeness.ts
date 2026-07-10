// Trust-surface-completeness (ADR-17, architecture §7.8) — the single CI
// gate ADR-17 names directly: "the most common governance bug class" is a
// new field silently not reflected in what a human reviews before
// approving. Walks the REAL Workflow/WorkflowStep Zod schemas' field sets
// via shape introspection and compares them against approval-summary.ts's
// explicit, source-visible covered-field registry.
import { WorkflowSchema, WorkflowStepSchema } from "@aart/types";
import type { z } from "zod";
import { COVERED_WORKFLOW_FIELDS, COVERED_WORKFLOW_STEP_FIELDS } from "./approval-summary.js";

export interface CompletenessResult {
  readonly missing: readonly string[];
  readonly ok: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapeKeys(schema: z.ZodObject<any>): string[] {
  return Object.keys(schema.shape);
}

/**
 * Compares `schema`'s actual field set against `covered` (the
 * approval-summary renderer's declared coverage). Defaults to the REAL
 * frozen `WorkflowSchema` + the real covered-field registry — this default
 * invocation, run as an ordinary test in this package's suite, IS the
 * ADR-17 CI gate. Both `schema` and `covered` are parameterizable
 * specifically so the test-of-the-test (trust-surface-completeness.test.ts)
 * can run the SAME check against a deliberately-mutated COPY of the schema
 * without ever touching the frozen @aart/types export.
 */
export function checkWorkflowFieldCompleteness(
  schema: z.ZodObject = WorkflowSchema,
  covered: readonly string[] = COVERED_WORKFLOW_FIELDS,
): CompletenessResult {
  const coveredSet = new Set(covered);
  const missing = shapeKeys(schema).filter((field) => !coveredSet.has(field));
  return { missing, ok: missing.length === 0 };
}

export function checkWorkflowStepFieldCompleteness(
  schema: z.ZodObject = WorkflowStepSchema,
  covered: readonly string[] = COVERED_WORKFLOW_STEP_FIELDS,
): CompletenessResult {
  const coveredSet = new Set(covered);
  const missing = shapeKeys(schema).filter((field) => !coveredSet.has(field));
  return { missing, ok: missing.length === 0 };
}
