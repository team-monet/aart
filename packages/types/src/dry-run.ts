// Dry-run mode's effectful-capability vocabulary (architecture §9.5 point 1:
// "a run-level flag (RunRecord.params.dryRun: boolean)... the engine's
// dispatch path checks before invoking any block whose capability is in a
// configured 'effectful' set (email.send, command, db.write, any
// domain:<pattern>-gated external write)").
//
// S9 integration (reconciliation ledger item 7, root SEAMS.md E6): this was
// independently duplicated by two packages that each needed it before the
// other existed — @aart/evidence's own eval-suite-fixture dry-run mechanism
// (evals/dry-run.ts, S6) and @aart/engine's real RunRecord.params.dryRun
// dispatch-boundary check (S1 — previously unbuilt entirely, closed as part
// of this same reconciliation pass). SEAMS.md E6 flagged the divergence
// risk explicitly ("the two are meant to converge on the same vocabulary...
// by documented contract, not shared code... worth reconciling explicitly
// during S9's integration pass") — this file is that reconciliation: a
// single shared source of truth, matching the same "kept open, not a
// frozen enum, so a pack/custom capability isn't rejected by @aart/types
// itself" precedent BUILTIN_SCORER_KINDS (eval.ts) already established for
// an analogous "extensible vocabulary" need.
export const DEFAULT_EFFECTFUL_CAPABILITIES: readonly string[] = ["email.send", "command", "db.write"];

/** `domain:<pattern>`-gated capabilities are effectful by family, not exact string match (architecture §9.5's own list: "any domain:<pattern>-gated external write"). */
export function isEffectfulCapability(capability: string, effectfulCapabilities: readonly string[] = DEFAULT_EFFECTFUL_CAPABILITIES): boolean {
  if (effectfulCapabilities.includes(capability)) return true;
  return capability.startsWith("domain:");
}
