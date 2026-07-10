// validate.ts — see types.ts's ValidateFn doc comment for the S4 seam this
// is standing in for.
import { WorkflowSchema } from "@aart/types";
import type { ValidateFn, ValidateResult } from "./types.js";

/**
 * A lightweight REFERENCE validator — NOT the real `aart_validate` (spec
 * §18's full 5-class validation engine, owned by @aart/governance/S4).
 * Checks: the candidate parses against the canonical WorkflowSchema (spec
 * §14.1, S0-frozen) — spec §18.1's schema-validation class — and every
 * step's `uses` appears in a caller-supplied `knownBlocks` catalog, a
 * structural stand-in for §18.2's reference-validation class. Does NOT
 * implement capability validation, input-safety validation, or deployment
 * validation (spec §18.3-18.5) — those depend on @aart/governance's real
 * policy/capability model, out of this package's scope. See SEAMS.md.
 */
export function createReferenceValidator(knownBlocks: readonly string[]): ValidateFn {
  return (workflow: unknown): ValidateResult => {
    const parsed = WorkflowSchema.safeParse(workflow);
    if (!parsed.success) {
      return { valid: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
    }
    const errors: string[] = [];
    for (const step of parsed.data.execution.steps) {
      if (!knownBlocks.includes(step.uses)) {
        errors.push(`step "${step.id}" references unknown block "${step.uses}"`);
      }
    }
    return { valid: errors.length === 0, errors };
  };
}
