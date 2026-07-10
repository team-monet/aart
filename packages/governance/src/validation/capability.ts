// Class 3 — Capability validation (spec §18.3): "block requires available
// capability; capability approved; pack hash valid." Architecture §7.7:
// "a validation-time PREVIEW of what §4.6's runtime dispatch check will
// enforce — same capability data, different point in the lifecycle:
// validation tells the author 'this will need approval,' dispatch
// actually blocks execution."
import type { CapabilityClosureResult } from "../capability.js";
import type { ValidationFinding } from "./types.js";

export interface PackSealCheck {
  readonly packName: string;
  /** Computed by the caller, typically via `isPackSealBroken` (pack-approval.ts) against S7's real content-hash data — this class only checks the boolean result, same "SHAPE validation is the owning session's, this class checks the outcome" pattern deployment.ts's TriggerConfigCheck uses. */
  readonly sealBroken: boolean;
}

export interface CapabilityValidationContext {
  readonly granted: readonly string[];
  /**
   * "pack hash valid" (spec §18.3's third bullet). Optional — omitted
   * entirely when a workflow references no pack-delivered blocks, or when
   * the caller hasn't resolved pack provenance yet (e.g. this workflow
   * hasn't been mapped to which blocks came from which pack — that mapping
   * is S7's `@aart/registry` domain, not something `CapabilityClosureLookup`
   * exposes). When supplied, any pack with a broken seal is a hard error —
   * same-wave/S9 integration point once S7's real pack-provenance data
   * exists; the primitive this reads (`isPackSealBroken`) already does.
   */
  readonly packSealChecks?: readonly PackSealCheck[];
}

/**
 * Flags every capability in the ALREADY-COMPUTED `closure` not covered by
 * `context.granted` (typically produced by `getGrantedCapabilities` —
 * capability.ts — from this workflow version's own current approval
 * state/gates/standing approvals), PLUS any pack whose approval seal is
 * broken (spec §18.3's "pack hash valid," §16.2's "any edit breaks
 * approval seal"). Takes a pre-computed closure rather than computing it
 * itself: capability/input-safety/deployment validation and the approval
 * summary renderer all need the SAME closure over one `validateWorkflow`
 * call, and `computeCapabilityClosure` is the one place that's computed
 * (index.ts) — this avoids either recomputing it redundantly or
 * introducing an awkward chicken-and-egg (computing `granted`, this
 * class's own input, itself depends on the closure).
 */
export function validateCapabilities(closure: CapabilityClosureResult, context: CapabilityValidationContext): ValidationFinding[] {
  const grantedSet = new Set(context.granted);
  const ungranted = closure.capabilities.filter((c) => !grantedSet.has(c));

  const findings: ValidationFinding[] = ungranted.map((capability) => ({
    class: "capability",
    path: "execution.steps",
    message: `Capability "${capability}" is required by this workflow's closure but is not yet approved for it — this will need approval before it can run (architecture §4.6's runtime dispatch check will block it otherwise)`,
    severity: "error",
  }));

  for (const check of context.packSealChecks ?? []) {
    if (check.sealBroken) {
      findings.push({
        class: "capability",
        path: "execution.steps",
        message: `Pack "${check.packName}"'s approval seal is broken (its content hash no longer matches what was approved — spec §16.2: "any edit breaks approval seal") — it must be re-reviewed and re-approved before this workflow can use it`,
        severity: "error",
      });
    }
  }

  return findings;
}
