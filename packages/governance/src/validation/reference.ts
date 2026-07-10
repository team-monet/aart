// Class 2 — Reference validation (spec §18.2): "referenced blocks exist,
// versions exist, no direct self-reference, cycles must declare exit
// guards (maxIterations/until); unguarded cycles are validation errors."
import type { Workflow, WorkflowStep } from "@aart/types";
import type { CapabilityClosureLookup } from "../capability.js";
import { computeDidYouMean } from "./edit-distance.js";
import type { ValidationFinding } from "./types.js";

export interface ReferenceValidationContext {
  readonly blockCatalog: CapabilityClosureLookup;
  /** The full set of known block ids, for didYouMean edit-distance suggestions — NOT necessarily the same enumeration order/shape blockCatalog.resolve() needs, so kept separate rather than assumed derivable from the lookup interface. */
  readonly knownBlockIds: readonly string[];
  readonly aliasTable?: Readonly<Record<string, string>>;
}

/**
 * Resolved ambiguity (documented here, not AMENDMENTS.md — this is
 * validation-logic judgment within this package's own scope, not a change
 * to any frozen interface): spec §18.2 lists "no direct self-reference"
 * and "cycles must declare exit guards" as two SEPARATE bullets. Neither
 * source document's worked example (architecture §18.2's own
 * redacted-legacy-b renewal-cycle fixture) demonstrates a true self-loop
 * (`rescan.next` targets `recheck_wait`, a DIFFERENT earlier step,
 * not itself) — so nothing shows a guarded self-loop being accepted.
 * Treated as two independent rules: `step.next === step.id` is ALWAYS an
 * error regardless of any guard; any OTHER back-edge (targeting a
 * different step at or before its own array index) requires the
 * DECLARING step (not the target) to carry `maxIterations`/`until` — per
 * the worked example, where `rescan` (the step WITH `next`) is the
 * one that declares the guard, not `recheck_wait` (the earlier target).
 */
export function validateReferences(workflow: Pick<Workflow, "execution">, context: ReferenceValidationContext): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const steps = workflow.execution.steps;
  const stepIndexById = new Map(steps.map((s, i) => [s.id, i]));

  steps.forEach((step, index) => {
    validateBlockReference(step, index, context, findings);
    validateStepTargetReference(step, "then", step.then, stepIndexById, findings);
    validateStepTargetReference(step, "else", step.else, stepIndexById, findings);
    validateNextReference(step, index, stepIndexById, findings);
  });

  return findings;
}

function validateBlockReference(
  step: WorkflowStep,
  index: number,
  context: ReferenceValidationContext,
  findings: ValidationFinding[],
): void {
  const resolved = context.blockCatalog.resolve(step.uses);
  if (resolved) return;
  const didYouMean = computeDidYouMean(step.uses, context.knownBlockIds, context.aliasTable);
  findings.push({
    class: "reference",
    path: `steps[${index}].uses`,
    message: `Unknown block "${step.uses}"`,
    ...(didYouMean ? { didYouMean, correctedSnippet: `uses: ${didYouMean}` } : {}),
    severity: "error",
  });
}

function validateStepTargetReference(
  step: WorkflowStep,
  field: "then" | "else",
  target: string | undefined,
  stepIndexById: ReadonlyMap<string, number>,
  findings: ValidationFinding[],
): void {
  if (target === undefined) return;
  if (stepIndexById.has(target)) return;
  findings.push({
    class: "reference",
    path: `steps[?].${field}`.replace("?", step.id),
    message: `Step "${step.id}"'s "${field}" target "${target}" does not exist in this workflow`,
    severity: "error",
  });
}

function validateNextReference(
  step: WorkflowStep,
  index: number,
  stepIndexById: ReadonlyMap<string, number>,
  findings: ValidationFinding[],
): void {
  if (step.next === undefined) return;

  if (step.next === step.id) {
    findings.push({
      class: "reference",
      path: `steps[${index}].next`,
      message: `Step "${step.id}" cannot directly reference itself via "next" (spec §18.2: no direct self-reference)`,
      severity: "error",
    });
    return;
  }

  const targetIndex = stepIndexById.get(step.next);
  if (targetIndex === undefined) {
    findings.push({
      class: "reference",
      path: `steps[${index}].next`,
      message: `Step "${step.id}"'s "next" target "${step.next}" does not exist in this workflow`,
      severity: "error",
    });
    return;
  }

  const isBackEdge = targetIndex <= index;
  if (!isBackEdge) return;

  const hasGuard = step.maxIterations !== undefined || step.until !== undefined;
  if (!hasGuard) {
    findings.push({
      class: "reference",
      path: `steps[${index}].next`,
      message: `Step "${step.id}" declares a back-edge to "${step.next}" without "maxIterations" or "until" — unguarded cycles are validation errors (spec §18.2)`,
      correctedSnippet: `maxIterations: 10`,
      severity: "error",
    });
  }
}
