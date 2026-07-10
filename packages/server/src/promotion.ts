// computeApprovalState / computePromotionState — architecture §7.1, ADR-07.
//
// STUB, clearly flagged: `@aart/governance` (S4) is the authoritative owner
// of these two pure functions (they live conceptually under architecture
// §7 Governance) — this local copy mirrors their documented contract
// exactly (§7.1's prose + §7.3's trust-mode→required-gates table) so this
// package (which owns environment/deployment records, architecture ADR-06/
// ADR-07) can build and test its own environment-promotion integration
// without a hard dependency on S4's package landing first — the same
// pattern as engine/boundary.ts's fake engine. At S9 merge time, whichever
// composition root wires environments/promotion together should import the
// real functions from `@aart/governance` instead of this module. See
// SEAMS.md.
import type { AartStore } from "@aart/store";
import type { ApprovalState, Deployment, Environment, Gates, TrustMode } from "@aart/types";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import { generateId } from "./ids.js";

export type GateKey = keyof Gates;

/** architecture §7.3's explicit mapping — the concrete resolution of "spec states defaults but not the exact required-gate set per mode." */
export const REQUIRED_GATES_BY_TRUST_MODE: Record<TrustMode, GateKey[]> = {
  dev: [],
  governed: ["validate", "humanReview"],
  strict: ["validate", "humanReview"],
  production: ["validate", "readiness", "evals", "riskReview", "humanReview"],
};

function gatesSatisfy(gates: Gates, required: GateKey[]): boolean {
  return required.every((g) => gates[g] === "passed" || gates[g] === "waived");
}

/** architecture §7.1: "a pure function computeApprovalState(gates, requiredGatesForMode) → 'draft'|'approved' (2-arg, spec §17.1-faithful — no environment parameter)... the ONLY writer of the workflow version's global approval field." (2-arg form per ADR-07's A19 fix — an earlier draft had mistakenly grown a 3rd `environment` arg, since reverted.) */
export function computeApprovalState(gates: Gates, requiredGatesForMode: GateKey[]): ApprovalState {
  return gatesSatisfy(gates, requiredGatesForMode) ? "approved" : "draft";
}

export interface PromotionRecord {
  environmentId: string;
  environmentName: string;
  promoted: boolean;
  globalApproval: ApprovalState;
  computedAt: string;
}

/** architecture §7.1/ADR-07: "a separate, distinctly-named function... computes the ADR-07 promotion record for a (workflow version, environment) pair... reads the already-computed global approval as one of its inputs... never writes the global approval field." Pure — no store access, no side effects. */
export function computePromotionState(globalApproval: ApprovalState, gates: Gates, requiredGatesForEnvironment: GateKey[], environment: Environment, clock: Clock = systemClock): PromotionRecord {
  const promoted = globalApproval === "approved" && gatesSatisfy(gates, requiredGatesForEnvironment);
  return {
    environmentId: environment.id,
    environmentName: environment.name,
    promoted,
    globalApproval,
    computedAt: clock.nowIso(),
  };
}

/**
 * This package's own convention (documented, not specified verbatim by
 * either source doc — see this task's final report): an `Environment`'s
 * required-gate set is derived from a `trustMode` field inside its loosely-
 * typed `config` bag (`Environment.config: Record<string, unknown>`,
 * architecture §5.3), reusing §7.3's trust-mode→gates table rather than
 * inventing a second, parallel gate-configuration schema. Defaults to
 * `"governed"` if `config.trustMode` is absent/invalid.
 */
export function requiredGatesForEnvironment(environment: Environment): GateKey[] {
  const trustMode = environment.config["trustMode"];
  const mode: TrustMode = trustMode === "dev" || trustMode === "governed" || trustMode === "strict" || trustMode === "production" ? trustMode : "governed";
  return REQUIRED_GATES_BY_TRUST_MODE[mode];
}

export interface PromoteToEnvironmentParams {
  workflowId: string;
  workflowVersion: string;
  environmentId: string;
  triggerConfig?: Record<string, unknown>;
}

export type PromoteToEnvironmentResult =
  | { kind: "promoted"; record: PromotionRecord; deployment: Deployment }
  | { kind: "not_promoted"; record: PromotionRecord }
  | { kind: "blocked_by_promotion_block" }
  | { kind: "workflow_not_found" }
  | { kind: "environment_not_found" };

/**
 * The caller-side integration this session's DoD names: "Environment +
 * per-environment promotion records... computePromotionState(...) tested:
 * same workflow version, promotion record promoted for staging's gate set
 * while the production promotion record for the same version is not yet
 * promoted under production's stricter set... this call never mutates the
 * workflow version's own global approval field."
 *
 * There is no dedicated store member for a "promotion record" independent
 * of a `Deployment` (neither document allocates one — architecture §7.1
 * itself says the record's "exact field shape is ADR-07's/S2's to
 * finalize"). This function treats a successful promotion as the
 * precondition for creating/refreshing the (workflowVersion, environment)
 * `Deployment` row (architecture ADR-06 — already exactly keyed the same
 * way a promotion record would be) — `computePromotionState`'s own return
 * value is the promotion record itself, computed fresh on every call
 * (never independently persisted, so it can never drift from the gate/
 * approval state it was computed from).
 *
 * The `workflows.promotion_blocked` refusal check below is REPLICATED here
 * as a defensive, correct behavior for this package's own environment
 * integration — but per the implementation plan's P41 amendment, the
 * AUTHORITATIVE test of this refusal is S4's DoD item, not this session's;
 * this package's own test coverage is scoped to the staging-vs-production
 * divergence and the never-mutates-global-approval invariant.
 */
export async function promoteWorkflowVersionToEnvironment(store: AartStore, params: PromoteToEnvironmentParams, clock: Clock = systemClock): Promise<PromoteToEnvironmentResult> {
  const workflow = await store.workflows.get(params.workflowId, params.workflowVersion);
  if (!workflow) return { kind: "workflow_not_found" };
  if (workflow.promotionBlocked) return { kind: "blocked_by_promotion_block" };

  const environment = await store.environments.get(params.environmentId);
  if (!environment) return { kind: "environment_not_found" };

  const required = requiredGatesForEnvironment(environment);
  const record = computePromotionState(workflow.approval, workflow.gates, required, environment, clock);
  if (!record.promoted) return { kind: "not_promoted", record };

  const existingForEnv = await store.deployments.list({ environmentId: params.environmentId, workflowId: params.workflowId });
  const existing = existingForEnv.find((d) => d.workflowVersion === params.workflowVersion);
  const deployment: Deployment = existing
    ? { ...existing, triggerConfig: params.triggerConfig ?? existing.triggerConfig }
    : {
        id: generateId("dep"),
        workflowId: params.workflowId,
        workflowVersion: params.workflowVersion,
        environmentId: params.environmentId,
        triggerConfig: params.triggerConfig ?? {},
        createdAt: clock.nowIso(),
      };
  await store.deployments.put(deployment);
  return { kind: "promoted", record, deployment };
}
