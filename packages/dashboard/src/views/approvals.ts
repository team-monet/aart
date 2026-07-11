// Approval queue (v3) + "approve human tasks" (v2 writable action —
// architecture §13.2). Reads `ApprovalTask`s via `ApiClient.listApprovals`
// (`GET /approvals`, AMENDMENTS.md A47 — previously a direct
// `store.approvals.list` read, the same store-divergence bug class root
// AMENDMENTS.md A43 fixed for workflow/block detail).
//
// AMENDMENTS.md A47: the decision WRITE (`decideApprovalAction`, formerly
// here) is deleted — `server.ts`'s `POST /approvals/:id/decision` route now
// calls `api.decideApproval` directly, a thin proxy to
// `packages/server/src/approvals.ts`'s `decideApprovalTask`, the ONE real
// implementation. That move is also what fixes root AMENDMENTS.md A46's
// flagged bug: this file's FORMER local reimplementation decoded
// `decodeWorkflowVersionApprovalSubject(t.runId)` with only the runId (no
// `t.stepId`) when deciding, then hardcoded `gates.humanReview` regardless
// of which gate actually decoded — a `riskReview` task decided through the
// dashboard silently misattributed to `humanReview`. The DISPLAY-only decode
// below (never a write) is unaffected by that bug — it only picks a link
// target — but now also passes `t.stepId` so the queue table can label
// WHICH gate a version-review row is deciding (a small legibility
// improvement made trivial by having `stepId` in hand already, and
// valuable now that `riskReview` requests exist alongside `humanReview`
// ones, S14/A46).
import type { ApprovalTask } from "@aart/types";
import { decodeWorkflowVersionApprovalSubject } from "@aart/governance";
import { escapeHtml, form, page, table } from "../http/html.js";

export function renderApprovalQueuePage(tasks: ApprovalTask[]): string {
  const rows = tasks
    .filter((t) => t.status === "pending")
    .map((t) => {
      const versionSubject = decodeWorkflowVersionApprovalSubject(t.runId, t.stepId);
      const subjectCell = versionSubject
        ? `<a href="/workflows/${escapeHtml(versionSubject.workflowId)}">${escapeHtml(versionSubject.workflowId)}@${escapeHtml(versionSubject.workflowVersion)}</a> (${escapeHtml(versionSubject.gate)} review)`
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
