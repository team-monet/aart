// Risk-tier primitives (spec §31.1), extracted to their own leaf module so
// capability.ts and standing-approvals.ts can both depend on them without a
// real runtime circular import between the two (capability.ts needs
// standing-approvals.ts's matching logic for getGrantedCapabilities;
// standing-approvals.ts needs risk-tier comparison for its own match rule —
// keeping the tier primitives leaf-level avoids that cycle entirely).
export const RISK_TIERS = ["Low", "Low-medium", "Medium", "High"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

const RISK_TIER_RANK: Readonly<Record<RiskTier, number>> = { Low: 0, "Low-medium": 1, Medium: 2, High: 3 };

export function compareRiskTiers(a: RiskTier, b: RiskTier): number {
  return RISK_TIER_RANK[a] - RISK_TIER_RANK[b];
}

/** Ceiling, not average — architecture §7.4: "closure risk is a ceiling function, not an average." */
export function maxRiskTier(tiers: readonly RiskTier[]): RiskTier {
  return tiers.reduce<RiskTier>((max, t) => (compareRiskTiers(t, max) > 0 ? t : max), "Low");
}

export function isRiskTierName(value: string): value is RiskTier {
  return value === "Low" || value === "Low-medium" || value === "Medium" || value === "High";
}
