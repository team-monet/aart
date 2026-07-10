// Full validation engine — architecture §7.7, spec §18. All 5 classes run
// on every `aart_validate`/`aart validate` call, results merged.
import { WorkflowSchema, type StandingApproval, type TrustMode, type Workflow } from "@aart/types";
import { computeCapabilityClosure, getGrantedCapabilities, type CapabilityClosureLookup, type CapabilityClosureResult } from "../capability.js";
import type { GateName } from "../gates.js";
import { validateCapabilities, type PackSealCheck } from "./capability.js";
import type { DeploymentValidationContext } from "./deployment.js";
import { validateDeployment } from "./deployment.js";
import { validateInputSafety } from "./input-safety.js";
import { validateReferences } from "./reference.js";
import { validateSchema } from "./schema.js";
import { isValid, type ValidationFinding, type ValidationResult } from "./types.js";

export interface ValidationContext {
  readonly blockCatalog: CapabilityClosureLookup;
  readonly knownBlockIds: readonly string[];
  readonly aliasTable?: Readonly<Record<string, string>>;
  readonly trustMode: TrustMode;
  readonly standingApprovals?: readonly StandingApproval[];
  readonly now?: string;
  /** Class 5 (deployment) only runs when supplied — a workflow can be schema/reference/capability/input-safety-validated with no deployment target in view yet (e.g. draft authoring). */
  readonly deployment?: DeploymentValidationContext;
  /** spec §18.3's "pack hash valid" sub-check — see CapabilityValidationContext.packSealChecks (validation/capability.ts) for why this is optional and caller-supplied. */
  readonly packSealChecks?: readonly PackSealCheck[];
}

export interface FullValidationResult extends ValidationResult {
  /** The computed capability closure — exposed so a caller (e.g. the approval summary renderer) doesn't need to recompute it separately. Undefined if class 1 (schema) already failed, since a schema-invalid input has no reliable steps to walk. */
  readonly capabilityClosure?: CapabilityClosureResult;
}

/**
 * Runs all 5 validation classes and merges results. Short-circuits after
 * class 1 (schema) if it fails — classes 2-5 all need a successfully
 * parsed `Workflow` to walk; running them against an unparseable shape
 * would be meaningless, not merely redundant.
 */
export function validateWorkflow(input: unknown, context: ValidationContext): FullValidationResult {
  const schemaFindings = validateSchema(input);
  if (schemaFindings.length > 0) {
    return { valid: isValid(schemaFindings), findings: schemaFindings };
  }
  const workflow: Workflow = WorkflowSchema.parse(input);

  const referenceFindings = validateReferences(workflow, {
    blockCatalog: context.blockCatalog,
    knownBlockIds: context.knownBlockIds,
    aliasTable: context.aliasTable,
  });

  // Computed ONCE — capability/input-safety validation and the deployment
  // class below (plus, outside this function, the approval summary
  // renderer) all need the identical closure over this one validation
  // pass, not three independently-recomputed walks.
  const closure = computeCapabilityClosure(workflow.execution.steps, context.blockCatalog);
  const granted = getGrantedCapabilities({
    trustMode: context.trustMode,
    approvalState: workflow.approval,
    capabilityClosure: closure.capabilities,
    riskTier: closure.riskTier,
    standingApprovals: context.standingApprovals,
    now: context.now,
  });
  const capabilityFindings = validateCapabilities(closure, { granted, packSealChecks: context.packSealChecks });

  const inputSafetyFindings = validateInputSafety(workflow, context.blockCatalog);

  const deploymentFindings = context.deployment ? validateDeployment(workflow, closure, context.deployment) : [];

  const findings: ValidationFinding[] = [...referenceFindings, ...capabilityFindings, ...inputSafetyFindings, ...deploymentFindings];

  return { valid: isValid(findings), findings, capabilityClosure: closure };
}

export * from "./capability.js";
export * from "./deployment.js";
export { findEffectfulStepsWithoutIdempotencyKey, validateInputSafety } from "./input-safety.js";
export * from "./reference.js";
export * from "./schema.js";
export * from "./types.js";
export { computeDidYouMean, levenshteinDistance } from "./edit-distance.js";
