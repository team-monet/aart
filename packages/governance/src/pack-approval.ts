// Pack approval-gate wiring (spec §16.2-16.3). This session's
// consumed-frozen-interfaces line is explicit about the package boundary:
// "S4 owns the approval-gate wiring; S7 owns pack import/hashing
// mechanics" — S7 computes `PackManifest.contentHash` and handles the
// npm-distribution/import mechanics (ADR-12); this module only gates and
// records the APPROVAL decision on top of a manifest S7 already produced,
// and detects when an already-approved manifest's seal has been broken by
// a subsequent edit (spec §16.2's lifecycle: "any edit breaks approval
// seal").
import type { AartStore, Logger } from "@aart/store";
import type { PackManifest } from "@aart/types";
import { redactRecord } from "./redact.js";

export type PackApprovalStatus = "unapproved" | "approved";

export interface PackApprovalDecisionInput {
  readonly manifest: PackManifest;
  readonly decision: PackApprovalStatus;
  readonly reviewer: string;
  readonly decidedAt: string;
}

/** Pure — applies a decision to a manifest without persisting it (kept separate from the store-writing path below so callers can preview the result, and so this stays trivially unit-testable). */
export function applyPackApprovalDecision(input: PackApprovalDecisionInput): PackManifest {
  return { ...input.manifest, approvalStatus: input.decision };
}

/**
 * Records a pack approval/rejection decision — spec §16.2's "human reviews
 * capabilities/risk -> human approves" step. Routes through the redaction
 * chokepoint before persisting, same discipline as `writeApprovalDecision`
 * (approval-tasks.ts): a pack manifest's own `manifest: Record<string,
 * unknown>` field is free-form and could in principle echo back something
 * sensitive, so this is not exempted from the chokepoint any more than any
 * other persist path is (architecture §7.9).
 */
export async function writePackApprovalDecision(
  store: AartStore,
  input: PackApprovalDecisionInput,
  logger?: Logger,
  resolvedSecretRefs: ReadonlySet<string> = new Set(),
): Promise<PackManifest> {
  const updated = applyPackApprovalDecision(input);
  const redacted = redactRecord(updated, resolvedSecretRefs) as PackManifest;
  await store.packManifests.put(redacted);
  logger?.info("pack approval decision recorded", {
    pack: redacted.name,
    version: redacted.version,
    approvalStatus: redacted.approvalStatus,
  });
  return redacted;
}

/**
 * spec §16.2: "any edit breaks approval seal." S7 owns content-hash
 * computation (ADR-12); this function is the governance-owned SEAL CHECK
 * on top of it — true iff the manifest's CURRENT content hash no longer
 * matches the hash recorded at approval time, meaning the approval no
 * longer covers what's actually there and must be treated as broken
 * (unapproved again) regardless of the stored `approvalStatus` field.
 */
export function isPackSealBroken(approvedSnapshot: Pick<PackManifest, "contentHash">, current: Pick<PackManifest, "contentHash">): boolean {
  return approvedSnapshot.contentHash !== current.contentHash;
}
