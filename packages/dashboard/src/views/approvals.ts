// Approval queue (v3) + "approve human tasks" (v2 writable action —
// architecture §13.2). Reads `ApprovalTask`s directly from `store`
// (`AartStore.approvals.list`) — S2 documents only the decision-POST route
// (`POST /approvals/:id/decision`), no list-GET route, so there's no HTTP
// surface to read this through yet; flagged in SEAMS.md.
import type { AartStore } from "@aart/store";
import type { ApprovalTask } from "@aart/types";
import type { DashboardDeps, ResumeOutcome } from "../deps.js";
import { escapeHtml, form, page, table } from "../http/html.js";

export function renderApprovalQueuePage(tasks: ApprovalTask[]): string {
  const rows = tasks
    .filter((t) => t.status === "pending")
    .map((t) => [
      escapeHtml(t.id),
      `<a href="/runs/${escapeHtml(t.runId)}">${escapeHtml(t.runId)}</a>`,
      escapeHtml(t.stepId),
      escapeHtml(t.title),
      escapeHtml(t.description),
      form(
        `/approvals/${escapeHtml(t.id)}/decision`,
        `<label>Decision: <select name="status"><option value="approved">Approve</option><option value="rejected">Reject</option><option value="needs_changes">Needs changes</option></select></label><br>
<label>Reviewer: <input type="text" name="reviewer" value="dashboard-operator"></label>`,
        "Submit decision",
      ),
    ]);
  return page("Approval Queue", table(["Task", "Run", "Step", "Title", "Description", "Decision"], rows));
}

/**
 * "Approve human tasks": updates the ApprovalTask record (`decideApprovalTask`)
 * AND resumes the run waiting on it (`resumeApproval`, S1's seam) — both
 * thin delegates to injected functions, per architecture §13.2's principle.
 */
export async function decideApprovalAction(
  deps: DashboardDeps,
  store: AartStore,
  taskId: string,
  status: "approved" | "rejected" | "needs_changes",
  reviewer: string,
  decision?: unknown,
): Promise<{ task: ApprovalTask; resume: ResumeOutcome }> {
  const task = await deps.decideApprovalTask(store, taskId, status, reviewer, decision);
  const resume = await deps.resumeApproval(task.runId, task.stepId, { id: task.id, status: task.status, decision: task.decision, reviewer: task.reviewer });
  return { task, resume };
}
