// Environment-scoped promotion (architecture §7.1, ADR-07) — the pure
// approval/promotion computation lives in @aart/governance (S4, the
// authoritative owner per architecture §7); this module owns the
// environment-integration SIDE EFFECTS on top of it: resolving an
// Environment's required-gate set from its config bag, and creating/
// refreshing the (workflowVersion, environment) Deployment record once a
// promotion is eligible.
//
// S9 integration (reconciliation ledger item 2, root AMENDMENTS.md A26's
// "S9 flag"): this module used to carry its OWN local mirror of
// computeApprovalState/computePromotionState/PromotionRecord (a documented
// stub, per this file's prior header comment — the same pattern
// engine/boundary.ts's fake engine used, built so this package could
// develop/test its environment-integration logic without a hard dependency
// on S4's package landing first). Now that @aart/governance is really
// merged, this module imports the real functions directly and re-exports
// them (so `@aart/server`'s own public API surface, and this package's own
// existing test file, keep working with a straight swap, not a redesign).
// `@aart/dashboard`'s own duplicate mirror (stub-deps.ts) independently
// converged on governance's EXACT shape already (confirmed structurally
// identical during this reconciliation) — governance's shape is therefore
// ratified as the one true `PromotionRecord`, not server's former
// `environmentId`/`environmentName`/`computedAt` shape (verified nothing
// persists or asserts on those three dropped fields anywhere in this
// package: `Deployment`'s frozen schema only ever stores `environmentId`,
// never a name or a computed-at timestamp — a `PromotionRecord` is
// deliberately ephemeral, computed fresh on every call per governance's own
// design, never independently persisted).
import type { AartStore } from "@aart/store";
import {
  computeApprovalState,
  computePromotionState,
  evaluatePromotionForEnvironment,
  REQUIRED_GATES_BY_MODE,
  type GateName,
  type PromotionEvaluation,
  type PromotionRecord,
} from "@aart/governance";
import type { Deployment, Environment, TrustMode } from "@aart/types";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import { generateId } from "./ids.js";

export { computeApprovalState, computePromotionState, evaluatePromotionForEnvironment, REQUIRED_GATES_BY_MODE, type GateName, type PromotionEvaluation, type PromotionRecord };

/**
 * This package's own convention (documented, not specified verbatim by
 * either source doc — see AMENDMENTS.md/SEAMS.md): an `Environment`'s
 * required-gate set is derived from a `trustMode` field inside its loosely-
 * typed `config` bag (`Environment.config: Record<string, unknown>`,
 * architecture §5.3), reusing §7.3's trust-mode→gates table (governance's
 * real `REQUIRED_GATES_BY_MODE`) rather than inventing a second, parallel
 * gate-configuration schema. Defaults to `"governed"` if `config.trustMode`
 * is absent/invalid.
 */
export function requiredGatesForEnvironment(environment: Environment): readonly GateName[] {
  const trustMode = environment.config["trustMode"];
  const mode: TrustMode = trustMode === "dev" || trustMode === "governed" || trustMode === "strict" || trustMode === "production" ? trustMode : "governed";
  return REQUIRED_GATES_BY_MODE[mode];
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
 * way a promotion record would be) — governance's `PromotionRecord` return
 * value is the promotion record itself, computed fresh on every call
 * (never independently persisted, so it can never drift from the gate/
 * approval state it was computed from).
 *
 * The `workflows.promotion_blocked` refusal check below is checked
 * EXPLICITLY, before the environment fetch (preserving this function's
 * original error-priority ordering — `blocked_by_promotion_block` beats
 * `environment_not_found` when both apply), even though
 * `evaluatePromotionForEnvironment` (called below) ALSO performs this same
 * check internally — belt-and-suspenders, not redundant dead logic: this
 * explicit check is what fixes the ordering; the wrapper's own check is
 * defense-in-depth if this call site's own check were ever accidentally
 * removed later. Per implementation plan P41, the AUTHORITATIVE test of
 * the refusal behavior itself is S4's (`@aart/governance`'s own DoD item);
 * this package's own test coverage is scoped to the staging-vs-production
 * divergence, the never-mutates-global-approval invariant, and this
 * ordering.
 */
export async function promoteWorkflowVersionToEnvironment(store: AartStore, params: PromoteToEnvironmentParams, clock: Clock = systemClock): Promise<PromoteToEnvironmentResult> {
  const workflow = await store.workflows.get(params.workflowId, params.workflowVersion);
  if (!workflow) return { kind: "workflow_not_found" };
  if (workflow.promotionBlocked) return { kind: "blocked_by_promotion_block" };

  const environment = await store.environments.get(params.environmentId);
  if (!environment) return { kind: "environment_not_found" };

  const required = requiredGatesForEnvironment(environment);
  const evaluation: PromotionEvaluation = evaluatePromotionForEnvironment({
    workflow,
    globalApproval: workflow.approval,
    gates: workflow.gates,
    requiredGatesForEnvironment: required,
    environment: params.environmentId,
  });
  if (evaluation.blocked) return { kind: "blocked_by_promotion_block" }; // unreachable given the explicit check above; kept for exhaustiveness/defense-in-depth
  const record = evaluation.record;
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
