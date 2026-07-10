// computeApprovalState, computePromotionState — architecture §7.1, ADR-07.
// TWO functions, not one: computeApprovalState is the SOLE writer of a
// workflow version's global `approval` field; computePromotionState derives
// a per-environment promotion record and NEVER mutates global approval.
import type { ApprovalState, Gates, Workflow } from "@aart/types";
import type { GateName } from "./gates.js";

/**
 * architecture §7.1: "a pure function computeApprovalState(gates,
 * requiredGatesForMode) -> 'draft'|'approved' (2-arg, spec §17.1-faithful —
 * no `environment` parameter). This function is the ONLY writer of the
 * workflow version's global `approval` field." Deliberately narrower than
 * the full 3-state `ApprovalState` (`deprecated` is a separate, manual
 * lifecycle action this function never produces — nothing in either source
 * document routes deprecation through gate computation).
 */
export type AutoApprovalState = Extract<ApprovalState, "draft" | "approved">;

/**
 * Resolved ambiguity (documented here + AMENDMENTS.md): architecture §7.3's
 * mapping table states dev mode "requires nothing" (an EMPTY
 * requiredGatesForMode) while the same section separately states "approval
 * never auto-flips" for dev ("dev is meant for throwaway iteration, not
 * promotion"). A vacuous-truth reading of "every gate in an empty set has
 * passed" would auto-approve dev-mode workflows immediately, directly
 * contradicting "never auto-flips". Resolved by treating an EMPTY
 * `requiredGatesForMode` as never-satisfiable rather than vacuously
 * satisfied. This is the only requiredGatesForMode value any of the four
 * documented trust modes actually uses (dev's, per gates.ts's
 * REQUIRED_GATES_BY_MODE) — so in practice this rule only ever fires for
 * dev, without computeApprovalState needing a mode parameter to know it.
 */
export function computeApprovalState(gates: Gates, requiredGatesForMode: readonly GateName[]): AutoApprovalState {
  if (requiredGatesForMode.length === 0) return "draft";
  const allSatisfied = requiredGatesForMode.every((gate) => gates[gate] === "passed" || gates[gate] === "waived");
  return allSatisfied ? "approved" : "draft";
}

/**
 * ADR-07's per-environment promotion record — architecture-introduced,
 * FLAGGED DIVERGENCE from spec §17's single global approval model. Exact
 * field shape is explicitly left to "ADR-07's/S2's to finalize when
 * environment records are built" (architecture §7.1) — this shape is
 * governance's own reasonable design fill (same spirit as S0's
 * AMENDMENTS.md-documented store-method-signature gaps), published via
 * SEAMS.md for S2 to consume/extend when it wires this into real
 * Deployment/Environment records.
 */
export interface PromotionRecord {
  readonly environment: string;
  readonly promoted: boolean;
  readonly globalApproval: ApprovalState;
  readonly requiredGates: readonly GateName[];
  readonly unmetGates: readonly GateName[];
}

/**
 * architecture §7.1/ADR-07: "a separate, distinctly-named function ...
 * computes the ADR-07 promotion record for a (workflow version,
 * environment) pair ... This function is not computeApprovalState given a
 * third argument; it is a different function with a different write target
 * ... that READS the already-computed global approval as one of its
 * inputs." computeApprovalState never writes a promotion record, and this
 * function never writes the global `approval` field (it is pure — it
 * returns a new record, it never mutates `gates`/`globalApproval`/anything
 * else passed in).
 *
 * ADR-07's rationale ("a version proven in staging is not thereby proven
 * for prod... derives a promotion record from the already-computed global
 * approval value PLUS an environment's own required-gate set"): promotion
 * requires BOTH the version being globally approved AND this specific
 * environment's own (possibly stricter) required-gate subset being
 * satisfied — an environment's required set is checked independently of,
 * and in addition to, whatever gate set the global mode required.
 */
export function computePromotionState(
  globalApproval: ApprovalState,
  gates: Gates,
  requiredGatesForEnvironment: readonly GateName[],
  environment: string,
): PromotionRecord {
  const unmetGates = requiredGatesForEnvironment.filter(
    (gate) => !(gates[gate] === "passed" || gates[gate] === "waived"),
  );
  return {
    environment,
    promoted: globalApproval === "approved" && unmetGates.length === 0,
    globalApproval,
    requiredGates: [...requiredGatesForEnvironment],
    unmetGates,
  };
}

export type PromotionEvaluation =
  | { readonly blocked: true; readonly reason: "promotion_blocked"; readonly environment: string }
  | { readonly blocked: false; readonly record: PromotionRecord };

/**
 * The "promotion path" — `computePromotionState`'s caller — architecture
 * §7.1/§9.4: "MUST check that version's `workflows.promotion_blocked` flag
 * first and refuse to create or refresh a promotion record for that
 * (workflow version, environment) pair while the flag is true, regardless
 * of how the gate computation above would otherwise resolve ... a call-site
 * gate, not a new argument to the function itself." `computePromotionState`
 * keeps its own untouched 4-argument signature above; THIS function is the
 * call site the refusal logic lives on, exactly as the architecture
 * requires. S6 is the one that actually SETS `workflow.promotionBlocked`
 * (a correction outcome, architecture §9.4); S4 owns refusing to promote
 * while it's set.
 */
export function evaluatePromotionForEnvironment(params: {
  workflow: Pick<Workflow, "promotionBlocked">;
  globalApproval: ApprovalState;
  gates: Gates;
  requiredGatesForEnvironment: readonly GateName[];
  environment: string;
}): PromotionEvaluation {
  if (params.workflow.promotionBlocked === true) {
    return { blocked: true, reason: "promotion_blocked", environment: params.environment };
  }
  return {
    blocked: false,
    record: computePromotionState(params.globalApproval, params.gates, params.requiredGatesForEnvironment, params.environment),
  };
}
