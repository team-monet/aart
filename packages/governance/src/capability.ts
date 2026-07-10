// Capability model + risk-from-closure (architecture §7.4, spec §31.0-31.1)
// and the REAL CapabilityCheck implementation (architecture §4.6, ADR-09) —
// replacing S1's always-allow stub.
import type { BaseCapability, CapabilityCheck, WorkflowStep } from "@aart/types";

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

/**
 * spec §31.1's risk table, verbatim, PLUS two governance-owned
 * interpolations for capabilities §31.0's own taxonomy names but §31.1's
 * table never assigns a risk row to: `queue` and `db.read`. Both are
 * genuine gaps in the source table (not a contradiction — a silent
 * omission), so a defensible, documented reading was required to make
 * closure computation total over the real taxonomy. See AMENDMENTS.md.
 *
 * Interpolation rationale: the table's own file.read (Low-medium) / file.write
 * (Medium) pair establishes a one-tier "read is safer than write" delta
 * within the same resource family. Applying that same delta:
 *   - db.read: one tier below db.write's High -> Medium.
 *   - queue: an external-system interaction with side-effect potential
 *     comparable to http/browser/llm (all Medium), not merely local like
 *     file.read -> Medium.
 * `human.approval`'s "no capability required -> Low" row needs no entry
 * here — it has no capability to look up in the first place.
 */
const BASE_CAPABILITY_RISK: Readonly<Partial<Record<BaseCapability, RiskTier>>> = {
  "file.read": "Low-medium",
  "file.write": "Medium",
  http: "Medium",
  browser: "Medium",
  llm: "Medium",
  queue: "Medium", // interpolated — see AMENDMENTS.md
  "db.read": "Medium", // interpolated — see AMENDMENTS.md
  "email.send": "High",
  command: "High",
  "db.write": "High",
};

/**
 * `secrets:<NAME>` and `domain:<pattern>` are parameterized families (spec
 * §31.0), both High per §31.1's table. Any capability string OUTSIDE the
 * documented taxonomy entirely (a pack-declared capability, a typo, a
 * future addition) conservatively defaults to High — an under-declared
 * capability is a security hole (this session's own DoD framing); an
 * UNRECOGNIZED capability is treated as High rather than silently Low, so
 * closure risk fails closed, never open, on anything this module doesn't
 * recognize.
 */
export function riskForCapability(capability: string): RiskTier {
  if (capability.startsWith("secrets:") || capability.startsWith("domain:")) return "High";
  return BASE_CAPABILITY_RISK[capability as BaseCapability] ?? "High";
}

/**
 * The block-catalog lookup this module's closure walk needs. Neither S3's
 * real `@aart/blocks-core` catalog nor S1's engine-owned block-resolution
 * mechanism exists in this Wave-1 worktree yet (concurrent sibling
 * sessions) — this interface is what a real catalog implements, and what
 * this package's own tests supply a fixture for (per this session's DoD:
 * "this test necessarily depends on S3's block catalog existing or a
 * fixture catalog stub").
 */
export interface CapabilityClosureLookup {
  resolve(blockId: string): CapabilityClosureNode | undefined;
}

export type CapabilityClosureNode =
  | { readonly kind: "block"; readonly capabilities: readonly string[] }
  | { readonly kind: "workflow"; readonly steps: readonly WorkflowStep[] };

export interface CapabilityClosureResult {
  /** Deduped, sorted union of every capability declared by every reachable block. */
  readonly capabilities: readonly string[];
  readonly riskTier: RiskTier;
  /** Block ids the lookup couldn't resolve — surfaced, not silently dropped (reference validation, a different validation class, is what actually rejects these). */
  readonly unresolved: readonly string[];
}

/**
 * architecture §7.4: "walk every step in the resolved definition tree
 * (workflow + all referenced workflow-blocks, transitively — a
 * workflow-type block can itself contain steps using further blocks),
 * union every declared capability across every reachable block, then map
 * that union through the §31.1 risk table, taking the MAXIMUM risk tier
 * present in the closure as the workflow-version's overall risk tier."
 */
export function computeCapabilityClosure(
  steps: readonly WorkflowStep[],
  lookup: CapabilityClosureLookup,
): CapabilityClosureResult {
  const capabilities = new Set<string>();
  const unresolved = new Set<string>();
  const visitedBlocks = new Set<string>(); // cycle guard against a maliciously/accidentally self-referential block composition

  function walkSteps(stepList: readonly WorkflowStep[]): void {
    for (const step of stepList) walkBlock(step.uses);
  }

  function walkBlock(blockId: string): void {
    if (visitedBlocks.has(blockId)) return;
    visitedBlocks.add(blockId);
    const node = lookup.resolve(blockId);
    if (!node) {
      unresolved.add(blockId);
      return;
    }
    if (node.kind === "block") {
      for (const cap of node.capabilities) capabilities.add(cap);
    } else {
      walkSteps(node.steps);
    }
  }

  walkSteps(steps);
  const capabilityList = [...capabilities].sort();
  return {
    capabilities: capabilityList,
    riskTier: capabilityList.length === 0 ? "Low" : maxRiskTier(capabilityList.map(riskForCapability)),
    unresolved: [...unresolved].sort(),
  };
}

/**
 * The REAL CapabilityCheck implementation (architecture §4.6/ADR-09),
 * replacing S1's always-allow engine-side stub. `declared ⊆ granted`,
 * computed from the dependency closure — never from a block's own
 * self-declared claim about what it needs beyond its manifest.capabilities
 * (which IS `declared` here; the closure/risk computation above is what
 * feeds `granted`, never the reverse).
 */
export const checkCapability: CapabilityCheck = (declared, granted) => {
  const grantedSet = new Set(granted);
  return declared.every((capability) => grantedSet.has(capability));
};
