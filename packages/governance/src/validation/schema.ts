// Class 1 — Schema validation (spec §18.1): "required fields, correct
// types, supported execution types, valid steps." Architecture §7.7: "the
// Workflow Zod schema itself."
import { WorkflowSchema } from "@aart/types";
import type { ValidationFinding } from "./types.js";

export function validateSchema(workflowInput: unknown): ValidationFinding[] {
  const result = WorkflowSchema.safeParse(workflowInput);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    class: "schema" as const,
    path: issue.path.join("."),
    message: issue.message,
    severity: "error" as const,
  }));
}
