// Class 3 — Capability validation (spec §18.3): "block requires available
// capability; capability approved; pack hash valid." Architecture §7.7:
// "a validation-time PREVIEW of what §4.6's runtime dispatch check will
// enforce — same capability data, different point in the lifecycle:
// validation tells the author 'this will need approval,' dispatch
// actually blocks execution."
import type { CapabilityClosureResult } from "../capability.js";
import type { ValidationFinding } from "./types.js";

export interface CapabilityValidationContext {
  readonly granted: readonly string[];
}

/**
 * Flags every capability in the ALREADY-COMPUTED `closure` not covered by
 * `context.granted` (typically produced by `getGrantedCapabilities` —
 * capability.ts — from this workflow version's own current approval
 * state/gates/standing approvals). Takes a pre-computed closure rather
 * than computing it itself: capability/input-safety/deployment validation
 * and the approval summary renderer all need the SAME closure over one
 * `validateWorkflow` call, and `computeCapabilityClosure` is the one place
 * that's computed (index.ts) — this avoids either recomputing it
 * redundantly or introducing an awkward chicken-and-egg (computing
 * `granted`, this class's own input, itself depends on the closure).
 */
export function validateCapabilities(closure: CapabilityClosureResult, context: CapabilityValidationContext): ValidationFinding[] {
  const grantedSet = new Set(context.granted);
  const ungranted = closure.capabilities.filter((c) => !grantedSet.has(c));

  return ungranted.map((capability) => ({
    class: "capability",
    path: "execution.steps",
    message: `Capability "${capability}" is required by this workflow's closure but is not yet approved for it — this will need approval before it can run (architecture §4.6's runtime dispatch check will block it otherwise)`,
    severity: "error",
  }));
}
