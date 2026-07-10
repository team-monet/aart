// Approval queue (v3) + "approve human tasks" (v2 writable action —
// architecture §13.2). Reads `ApprovalTask`s directly from `store`
// (`AartStore.approvals.list`) — S2 documents only the decision-POST route
// (`POST /approvals/:id/decision`), no list-GET route, so there's no HTTP
// surface to read this through yet; flagged in SEAMS.md.
//
// S9 integration (reconciliation ledger item 1's real bug find): this
// action used to call `deps.resumeApproval(task.runId, task.stepId, ...)`
// UNCONDITIONALLY for every decided task, including workflow-VERSION-level
// ones (created via `aart_request_approval`'s workflowId+workflowVersion
// input shape). Against a sentinel runId/stepId, the real
// `Engine.resumeApproval` finds no matching wait and returns
// `{kind:"unmatched"}` — a SAFE no-op by design, but that also meant a
// dashboard operator's version-level decision was silently swallowed: the
// ApprovalTask record updated, but `Workflow.gates.humanReview`/`approval`
// never did, with no error surfaced anywhere. Fixed by decoding the runId
// first (governance's real `decodeWorkflowVersionApprovalSubject`) and,
// when it decodes, applying the SAME gate-update logic `@aart/mcp`'s
// `aart_approve` handler uses for the identical case (same gate-result
// mapping, same `computeApprovalState` call).
import type { AartStore } from "@aart/store";
import type { ApprovalState, ApprovalTask, Gates, TrustMode } from "@aart/types";
import { decodeWorkflowVersionApprovalSubject } from "@aart/governance";
import type { DashboardDeps, ResumeOutcome } from "../deps.js";
import { escapeHtml, form, page, table } from "../http/html.js";

export function renderApprovalQueuePage(tasks: ApprovalTask[]): string {
  const rows = tasks
    .filter((t) => t.status === "pending")
    .map((t) => {
      const versionSubject = decodeWorkflowVersionApprovalSubject(t.runId);
      const subjectCell = versionSubject
        ? `<a href="/workflows/${escapeHtml(versionSubject.workflowId)}">${escapeHtml(versionSubject.workflowId)}@${escapeHtml(versionSubject.workflowVersion)}</a> (version review)`
        : `<a href="/runs/${escapeHtml(t.runId)}">${escapeHtml(t.runId)}</a>`;
      return [
        escapeHtml(t.id),
        subjectCell,
        escapeHtml(t.stepId),
        escapeHtml(t.title),
        escapeHtml(t.description),
        form(
          `/approvals/${escapeHtml(t.id)}/decision`,
          `<label>Decision: <select name="status"><option value="approved">Approve</option><option value="rejected">Reject</option><option value="needs_changes">Needs changes</option></select></label><br>
<label>Reviewer: <input type="text" name="reviewer" value="dashboard-operator"></label><br>
<label>Trust mode (used only for a workflow-version review decision): <select name="trustMode"><option value="dev">dev</option><option value="governed" selected>governed</option><option value="strict">strict</option><option value="production">production</option></select></label>`,
          "Submit decision",
        ),
      ];
    });
  return page("Approval Queue", table(["Task", "Run / Workflow", "Step", "Title", "Description", "Decision"], rows));
}

export type DecideApprovalResult =
  | { kind: "run_step"; task: ApprovalTask; resume: ResumeOutcome }
  | { kind: "workflow_version"; task: ApprovalTask; workflowId: string; workflowVersion: string; gates: Gates; approval: ApprovalState };

/**
 * "Approve human tasks": updates the ApprovalTask record (`decideApprovalTask`)
 * then either (a) resumes the run waiting on it (`resumeApproval`, S1's
 * seam) for a genuine per-run task, or (b) updates the workflow version's
 * `gates.humanReview`/`approval` for a workflow-version-level task —
 * mirroring `@aart/mcp`'s `applyVersionReviewDecision` exactly.
 */
export async function decideApprovalAction(
  deps: DashboardDeps,
  store: AartStore,
  taskId: string,
  status: "approved" | "rejected" | "needs_changes",
  reviewer: string,
  decision?: unknown,
  trustMode: TrustMode = "governed",
): Promise<DecideApprovalResult> {
  const task = await deps.decideApprovalTask(store, taskId, status, reviewer, decision);

  const versionSubject = decodeWorkflowVersionApprovalSubject(task.runId);
  if (versionSubject) {
    const workflow = await store.workflows.get(versionSubject.workflowId, versionSubject.workflowVersion);
    if (!workflow) {
      throw new Error(`decideApprovalAction: workflow ${versionSubject.workflowId}@${versionSubject.workflowVersion} not found (referenced by approval task ${taskId}).`);
    }
    const gateResult = status === "approved" ? "passed" : status === "rejected" ? "failed" : "pending";
    const gates: Gates = { ...workflow.gates, humanReview: gateResult };
    const requiredGates = deps.requiredGatesByTrustMode[trustMode];
    const approval = deps.computeApprovalState(gates, requiredGates);
    await store.workflows.put({ ...workflow, gates, approval });
    return { kind: "workflow_version", task, workflowId: versionSubject.workflowId, workflowVersion: versionSubject.workflowVersion, gates, approval };
  }

  const resume = await deps.resumeApproval(task.runId, task.stepId, { id: task.id, status: task.status, decision: task.decision, reviewer: task.reviewer });
  return { kind: "run_step", task, resume };
}
