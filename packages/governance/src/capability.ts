// Capability model + risk-from-closure (architecture §7.4, spec §31.0-31.1),
// the REAL CapabilityCheck implementation (architecture §4.6, ADR-09) —
// replacing S1's always-allow stub — and the granted-capabilities policy
// query architecture §4.6's dispatch pseudocode calls
// `governance.getGrantedCapabilities(workflowVersion, environment)`.
import type { BaseCapability, CapabilityCheck, StandingApproval, TrustMode, WorkflowStep } from "@aart/types";
import { findMatchingStandingApproval } from "./standing-approvals.js";

// Risk-tier primitives live in risk-tiers.ts (a leaf module standing-
// approvals.ts also depends on) and are re-exported here so every existing
// `from "./capability.js"` import site keeps working unchanged.
export { RISK_TIERS, compareRiskTiers, maxRiskTier, type RiskTier } from "./risk-tiers.js";
import { maxRiskTier, type RiskTier } from "./risk-tiers.js";

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

export interface GrantedCapabilitiesInput {
  readonly trustMode: TrustMode;
  readonly approvalState: "draft" | "approved" | "deprecated";
  readonly capabilityClosure: readonly string[];
  readonly riskTier: RiskTier;
  readonly standingApprovals?: readonly StandingApproval[];
  readonly now?: string;
}

/**
 * Resolves the `granted` set architecture §4.6's dispatch pseudocode calls
 * `governance.getGrantedCapabilities(workflowVersion, environment)`. Unlike
 * `checkCapability`/`redactRecord`/`computeApprovalState`/
 * `computePromotionState` — each given an EXACT signature by the source
 * documents — this exact function is not; its shape here is governance's
 * own design fill for a genuine gap (same spirit as S0's
 * AMENDMENTS.md-documented store-method-signature gaps). See SEAMS.md.
 *
 * `dev` mode grants the full declared closure unconditionally — dev "runs
 * with a warning" (spec §17.2); it is not capability-gated, the warning IS
 * the enforcement. Every other mode grants the full closure only if the
 * version is globally approved OR a standing approval covers it
 * (architecture §7.5); otherwise NOTHING is granted, so any step declaring
 * any capability fails the engine's `declared ⊆ granted` dispatch check —
 * fail-closed by default, matching this package's stated ethos ("an
 * under-declared capability is a security hole").
 */
export function getGrantedCapabilities(input: GrantedCapabilitiesInput): string[] {
  if (input.trustMode === "dev") return [...input.capabilityClosure];
  if (input.approvalState === "approved") return [...input.capabilityClosure];
  const now = input.now ?? new Date().toISOString();
  const match = findMatchingStandingApproval(
    { riskTier: input.riskTier, capabilityClosure: input.capabilityClosure, now },
    input.standingApprovals ?? [],
  );
  return match ? [...input.capabilityClosure] : [];
}

/**
 * Normalizes an `Environment`'s raw, loosely-typed `config["trustMode"]`
 * value (`config: z.record(z.string(), z.unknown())` — architecture gives
 * `Environment.config` no frozen sub-shape) into a real `TrustMode`.
 * Unrecognized/absent falls back to `"governed"` — spec §17.2's own stated
 * default ("Local development default: governed"), and the same fallback
 * this function's callers used inline before this was factored out.
 *
 * AMENDMENTS.md (S15, settling the S11/A42 governance-permissiveness
 * finding): this is now the ONE place "what trust mode does this
 * environment/run operate under" is resolved from a raw config value,
 * shared by every real call site that used to re-derive its own copy of
 * this ternary — `@aart/mcp`'s `getGrantedCapabilities` adapter (the
 * ACTUAL capability-dispatch enforcement, architecture §4.6) and
 * `@aart/server`'s trigger-fired `RunRecord.approvalMode` capture
 * (architecture §19.1's "captured once at trigger time" audit field) both
 * now call this instead of hand-rolling the same "unrecognized -> governed"
 * fallback twice, which is exactly the kind of silent, ungoverned default
 * that produced the A42 finding this session closes (there, the divergent
 * copy was "unrecognized/absent -> dev", not "-> governed" — see
 * capability.ts's own `getGrantedCapabilities` doc comment history / this
 * session's AMENDMENTS entry for the full story).
 */
export function normalizeEnvironmentTrustMode(raw: unknown): TrustMode {
  return raw === "dev" || raw === "governed" || raw === "strict" || raw === "production" ? raw : "governed";
}
