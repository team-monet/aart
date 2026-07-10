// Semantic risk diff (architecture §7.6, spec §17.4) — "semantic diff, not
// just JSON diff": step-level classification (added/removed/modified),
// capability-closure delta (new capabilities/secrets/domains), and the
// resulting risk-tier delta.
import type { WorkflowStep } from "@aart/types";
import { compareRiskTiers, type CapabilityClosureResult, type RiskTier } from "./capability.js";

export interface StepAddedOrRemoved {
  readonly stepId: string;
  readonly uses: string;
}

export interface StepModified {
  readonly stepId: string;
  /** Human-readable descriptions of what changed on this step — e.g. `assertion text changed from "Checkout" to "Payment"`-shaped notes, per-field. */
  readonly details: readonly string[];
}

export interface SemanticRiskDiff {
  readonly added: readonly StepAddedOrRemoved[];
  readonly removed: readonly StepAddedOrRemoved[];
  readonly modified: readonly StepModified[];
  readonly capabilityChanged: boolean;
  readonly newCapabilities: readonly string[];
  readonly newSecrets: readonly string[];
  readonly newDomains: readonly string[];
  readonly riskFrom: RiskTier;
  readonly riskTo: RiskTier;
  readonly riskIncreased: boolean;
}

function deepEqual(a: unknown, b: unknown): boolean {
  // `with:`/`retry:` are always plain JSON-shaped step-authoring data
  // (never live class instances) by the time they reach this diff —
  // stringify-compare is exact and sufficient for that shape, and avoids
  // pulling in a deep-equal dependency for a leaf-simple case.
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffWithParams(from: Record<string, unknown> | undefined, to: Record<string, unknown> | undefined): string[] {
  const fromObj = from ?? {};
  const toObj = to ?? {};
  const keys = new Set([...Object.keys(fromObj), ...Object.keys(toObj)]);
  const details: string[] = [];
  for (const key of [...keys].sort()) {
    if (!deepEqual(fromObj[key], toObj[key])) {
      details.push(`${key} changed from ${JSON.stringify(fromObj[key])} to ${JSON.stringify(toObj[key])}`);
    }
  }
  return details;
}

function diffStepFields(from: WorkflowStep, to: WorkflowStep): string[] {
  const details: string[] = [];
  if (from.uses !== to.uses) details.push(`block reference changed from "${from.uses}" to "${to.uses}"`);
  if (!deepEqual(from.with, to.with)) {
    const withDetails = diffWithParams(from.with, to.with);
    details.push(...(withDetails.length > 0 ? withDetails : ["step parameters changed"]));
  }
  if (from.if !== to.if) details.push(`condition changed from ${JSON.stringify(from.if)} to ${JSON.stringify(to.if)}`);
  if (from.until !== to.until) details.push(`loop-exit condition changed from ${JSON.stringify(from.until)} to ${JSON.stringify(to.until)}`);
  if (from.then !== to.then) details.push(`"then" target changed from ${JSON.stringify(from.then)} to ${JSON.stringify(to.then)}`);
  if (from.else !== to.else) details.push(`"else" target changed from ${JSON.stringify(from.else)} to ${JSON.stringify(to.else)}`);
  if (from.next !== to.next) details.push(`"next" target changed from ${JSON.stringify(from.next)} to ${JSON.stringify(to.next)}`);
  if (!deepEqual(from.retry, to.retry)) details.push("retry policy changed");
  if (from.timeout !== to.timeout) details.push(`timeout changed from ${JSON.stringify(from.timeout)} to ${JSON.stringify(to.timeout)}`);
  if (from.idempotencyKey !== to.idempotencyKey) details.push("idempotencyKey changed");
  return details;
}

/**
 * Diffs two resolved workflow-version step lists at the step level, plus
 * their already-computed capability closures (architecture §7.6: "diff two
 * resolved Workflow definitions ... at the step level, classifying each
 * change into one of: step added / step removed / step modified / ...
 * capability closure changed / new secret reference / new external domain
 * reference"). Closures are taken as pre-computed inputs (via
 * `computeCapabilityClosure`, capability.ts) rather than re-derived here —
 * this module has no opinion on the block-catalog lookup mechanism.
 */
export function semanticRiskDiff(
  from: { steps: readonly WorkflowStep[]; capabilityClosure: CapabilityClosureResult },
  to: { steps: readonly WorkflowStep[]; capabilityClosure: CapabilityClosureResult },
): SemanticRiskDiff {
  const fromById = new Map(from.steps.map((s) => [s.id, s]));
  const toById = new Map(to.steps.map((s) => [s.id, s]));

  const added: StepAddedOrRemoved[] = [];
  const removed: StepAddedOrRemoved[] = [];
  const modified: StepModified[] = [];

  for (const [id, step] of toById) {
    if (!fromById.has(id)) added.push({ stepId: id, uses: step.uses });
  }
  for (const [id, step] of fromById) {
    if (!toById.has(id)) removed.push({ stepId: id, uses: step.uses });
  }
  for (const [id, toStep] of toById) {
    const fromStep = fromById.get(id);
    if (!fromStep) continue;
    const details = diffStepFields(fromStep, toStep);
    if (details.length > 0) modified.push({ stepId: id, details });
  }

  const fromCaps = new Set(from.capabilityClosure.capabilities);
  const newCapabilities = to.capabilityClosure.capabilities.filter((c) => !fromCaps.has(c));
  const newSecrets = newCapabilities.filter((c) => c.startsWith("secrets:")).map((c) => c.slice("secrets:".length));
  const newDomains = newCapabilities.filter((c) => c.startsWith("domain:")).map((c) => c.slice("domain:".length));

  const riskFrom = from.capabilityClosure.riskTier;
  const riskTo = to.capabilityClosure.riskTier;

  return {
    added,
    removed,
    modified,
    capabilityChanged: newCapabilities.length > 0,
    newCapabilities,
    newSecrets,
    newDomains,
    riskFrom,
    riskTo,
    riskIncreased: compareRiskTiers(riskTo, riskFrom) > 0,
  };
}

/** Renders spec §17.4's "Changes from approved vX -> draft vY" structured text format. */
export function renderSemanticRiskDiff(
  diff: SemanticRiskDiff,
  meta: { fromVersion: string; toVersion: string; requiredGates?: readonly string[] },
): string {
  const lines: string[] = [`Changes from approved v${meta.fromVersion} -> draft v${meta.toVersion}`, ""];

  if (diff.added.length > 0) {
    lines.push("Added:");
    for (const s of diff.added) lines.push(`- New step: ${s.uses} (${s.stepId})`);
    lines.push("");
  }
  if (diff.removed.length > 0) {
    lines.push("Removed:");
    for (const s of diff.removed) lines.push(`- Removed step: ${s.uses} (${s.stepId})`);
    lines.push("");
  }
  if (diff.modified.length > 0) {
    lines.push("Changed:");
    for (const m of diff.modified) for (const d of m.details) lines.push(`- [${m.stepId}] ${d}`);
    lines.push("");
  }

  if (diff.capabilityChanged || diff.riskIncreased) {
    lines.push("Risk changes:");
    for (const c of diff.newCapabilities) lines.push(`- New capability: ${c}`);
    for (const s of diff.newSecrets) lines.push(`- New secret reference: ${s}`);
    for (const d of diff.newDomains) lines.push(`- New external domain: ${d}`);
    if (diff.riskIncreased) lines.push(`- Risk increased ${diff.riskFrom} -> ${diff.riskTo}`);
    lines.push("");
  }

  if (meta.requiredGates && meta.requiredGates.length > 0) {
    lines.push("Required:");
    for (const g of meta.requiredGates) lines.push(`- ${g}`);
  }

  return lines.join("\n").trimEnd();
}
