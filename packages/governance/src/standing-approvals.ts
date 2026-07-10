// Standing approvals (architecture §7.5, spec §17.6).
import type { StandingApproval } from "@aart/types";
import { compareRiskTiers, type RiskTier } from "./capability.js";

export interface StandingApprovalMatchInput {
  readonly riskTier: RiskTier;
  readonly capabilityClosure: readonly string[];
  /** ISO-8601 "now" — injected rather than read internally, keeping matching pure/testable (same discipline as computePromotionState). */
  readonly now: string;
}

function isSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const supSet = new Set(superset);
  return subset.every((item) => supSet.has(item));
}

function isRiskTierName(value: string): value is RiskTier {
  return value === "Low" || value === "Low-medium" || value === "Medium" || value === "High";
}

/**
 * architecture §7.5: "at promotion-check time, if any non-expired
 * StandingApproval exists where the workflow version's closure risk tier
 * <= maxRiskTier AND the workflow's full capability closure ⊆
 * standingApproval.capabilities, humanReview is auto-set to 'passed'."
 * Returns the first matching, non-expired standing approval, or undefined.
 *
 * `StandingApproval.maxRiskTier` is `z.string()` at the @aart/types level
 * (spec §17.6 doesn't close it to an enum — see AMENDMENTS.md's sibling
 * note on capability strings for the same reasoning); a standing approval
 * whose `maxRiskTier` isn't one of the four known risk-tier names never
 * matches anything — fails closed, not open.
 */
export function findMatchingStandingApproval(
  input: StandingApprovalMatchInput,
  standingApprovals: readonly StandingApproval[],
): StandingApproval | undefined {
  return standingApprovals.find((standingApproval) => {
    if (standingApproval.expiresAt <= input.now) return false; // expired (or expiring exactly now) never matches
    if (!isRiskTierName(standingApproval.maxRiskTier)) return false;
    if (compareRiskTiers(input.riskTier, standingApproval.maxRiskTier) > 0) return false;
    return isSubset(input.capabilityClosure, standingApproval.capabilities);
  });
}
