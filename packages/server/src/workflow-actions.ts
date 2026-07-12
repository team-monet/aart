// approveOrDeprecateWorkflow — the "Approve / Deprecate" write action
// (architecture §13.2's v2 writable-action list) the dashboard's own
// "Approve/Deprecate" form posts. No sibling SEAMS.md publishes a single
// owning function for this write (only the pure gate computation,
// `@aart/governance`'s `computeApprovalState`, is published) — this mirrors
// the now-deleted dashboard-local `approveOrDeprecateWorkflow`
// (`packages/dashboard/src/stub-deps.ts`, pre-A47) exactly, moved here so
// this package's own real HTTP write path is the one implementation instead
// of a dashboard-local mirror of it. The actual STORE PERSISTENCE here is
// trivial glue (no policy logic of its own); the POLICY decision is made by
// `computeApprovalState`, `@aart/governance`'s real, authoritative function.
import { recordEvent, type AartStore } from "@aart/store";
import type { TrustMode, Workflow } from "@aart/types";
import { computeApprovalState, REQUIRED_GATES_BY_MODE } from "@aart/governance";

export type ApproveOrDeprecateAction = "approve" | "deprecate";

export type ApproveOrDeprecateResult = { kind: "not_found" } | { kind: "ok"; workflow: Workflow };

/**
 * `action: "approve"` recomputes `Workflow.approval` from its current gates
 * via `computeApprovalState` (whose own contract only ever returns
 * `"draft"|"approved"` — never `"deprecated"`). `action: "deprecate"` is the
 * one transition NOT derivable from gates at all — an explicit human
 * retiring an approved version — so it sets `"deprecated"` directly rather
 * than routing through the gate-computed function.
 */
export async function approveOrDeprecateWorkflow(
  store: AartStore,
  workflowId: string,
  version: string,
  action: ApproveOrDeprecateAction,
  trustMode: TrustMode = "governed",
): Promise<ApproveOrDeprecateResult> {
  const workflow = await store.workflows.get(workflowId, version);
  if (!workflow) return { kind: "not_found" };
  const approval = action === "deprecate" ? "deprecated" : computeApprovalState(workflow.gates, REQUIRED_GATES_BY_MODE[trustMode]);
  const updated: Workflow = { ...workflow, approval };
  await store.workflows.put(updated);
  // V1 event log (AMENDMENTS.md A61) — colocated with the write above,
  // same unconditional-write semantics: "approve" only actually reaches
  // "approved" when computeApprovalState says so (an approve attempt
  // against an unmet-gates workflow still writes, just not to "approved" —
  // no workflow.approved event for that case); "deprecate" always reaches
  // "deprecated" once the workflow is found, matching the ternary above.
  if (action === "approve" && approval === "approved") {
    await recordEvent(store, { type: "workflow.approved", workflowId, workflowVersion: version, summary: `${workflowId}@${version} approved` });
  } else if (action === "deprecate") {
    await recordEvent(store, { type: "workflow.deprecated", workflowId, workflowVersion: version, summary: `${workflowId}@${version} deprecated` });
  }
  return { kind: "ok", workflow: updated };
}
