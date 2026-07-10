// The normal ApprovalTask write path — architecture §7.1/§7.2/§7.5. Every
// approval decision (CLI/dashboard, PR-merge ingestion, standing-approval
// auto-pass) goes through `writeApprovalDecision`, satisfying architecture
// §7.2's "going through the exact same ApprovalTask write path as a
// CLI/dashboard decision" for PR-merge, and spec §17.6's "recorded exactly
// like a regular approval — same audit trail, same visibility" for standing
// approvals.
import type { AartStore, Logger } from "@aart/store";
import type { ApprovalTask, StandingApproval } from "@aart/types";

export interface WriteApprovalDecisionInput {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly title: string;
  readonly description: string;
  readonly status: ApprovalTask["status"];
  readonly reviewer?: string;
  readonly decision?: unknown;
  readonly createdAt: string;
  readonly decidedAt?: string;
}

/** S4's "normal approval-write function" (architecture §7.2's own phrase) — the one path every ApprovalTask write goes through, regardless of origin. */
export async function writeApprovalDecision(store: AartStore, input: WriteApprovalDecisionInput, logger?: Logger): Promise<ApprovalTask> {
  const task: ApprovalTask = { ...input };
  await store.approvals.put(task);
  logger?.info("approval task written", { runId: task.runId, stepId: task.stepId, status: task.status });
  return task;
}

/**
 * `ApprovalTask`'s frozen shape (spec §13.5) is `runId`/`stepId`-keyed for a
 * per-run wait-type approval. A workflow-VERSION-level approval decision
 * (PR-merge ingestion satisfying the `humanReview` gate; a standing
 * approval's synthetic audit-trail task) decides something about a
 * VERSION's promotion eligibility before that version has necessarily ever
 * run — there is no real run/step to key off. Neither source document
 * resolves this identity gap (see AMENDMENTS.md); this sentinel-pair
 * convention is governance's own resolution, used consistently by every
 * workflow-version-level ApprovalTask writer in this module. A genuine
 * per-run `human.approval` wait's ApprovalTask always carries real
 * runId/stepId from the RunRecord/WorkflowStep that created the wait and
 * never goes through this helper.
 */
export function workflowVersionApprovalSubject(workflowId: string, workflowVersion: string): { runId: string; stepId: string } {
  return { runId: `workflow-version:${workflowId}@${workflowVersion}`, stepId: "__gate:humanReview__" };
}

export interface GithubMergeEventPayload {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly mergedBy: string;
  readonly mergedAt: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl?: string;
}

/**
 * PR-merge-as-decision write path (architecture §7.2, spec §26.2). The
 * trigger-side DETECTION of "this is a merge event on a PR tracked as a
 * pending workflow-version approval" is S2's (`@aart/server`'s `github`
 * trigger adapter) — this function is the resulting WRITE, tested here
 * with a synthetic merge-event payload, going through the exact same
 * `writeApprovalDecision` path as any CLI/dashboard decision.
 */
export async function recordPrMergeApproval(store: AartStore, payload: GithubMergeEventPayload, logger?: Logger): Promise<ApprovalTask> {
  const subject = workflowVersionApprovalSubject(payload.workflowId, payload.workflowVersion);
  return writeApprovalDecision(
    store,
    {
      id: `approval_pr_${payload.workflowId}_${payload.pullRequestNumber}`,
      ...subject,
      title: `PR #${payload.pullRequestNumber} merged`,
      description:
        payload.pullRequestUrl ??
        `Pull request #${payload.pullRequestNumber} merged for ${payload.workflowId}@${payload.workflowVersion}`,
      status: "approved",
      reviewer: payload.mergedBy,
      decision: { source: "github_pr_merge", pullRequestNumber: payload.pullRequestNumber },
      createdAt: payload.mergedAt,
      decidedAt: payload.mergedAt,
    },
    logger,
  );
}

export interface RecordStandingApprovalDecisionInput {
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly standingApproval: StandingApproval;
  readonly now: string;
}

/**
 * architecture §7.5 / spec §17.6: a standing-approval auto-pass is "recorded
 * exactly like a regular approval — same audit trail, same visibility —
 * just with a policy as its origin instead of a one-off human click." The
 * synthetic task's `decision` records WHICH standing approval matched, per
 * spec's explicit audit-trail requirement.
 */
export async function recordStandingApprovalDecision(
  store: AartStore,
  input: RecordStandingApprovalDecisionInput,
  logger?: Logger,
): Promise<ApprovalTask> {
  const subject = workflowVersionApprovalSubject(input.workflowId, input.workflowVersion);
  return writeApprovalDecision(
    store,
    {
      id: `approval_standing_${input.workflowId}_${input.workflowVersion}_${input.now}`,
      ...subject,
      title: "Standing approval auto-pass",
      description: `Auto-approved by standing approval granted by ${input.standingApproval.grantedBy} (expires ${input.standingApproval.expiresAt}).`,
      status: "approved",
      decision: {
        source: "standing_approval",
        standingApprovalId: input.standingApproval.id,
        grantedBy: input.standingApproval.grantedBy,
      },
      reviewer: input.standingApproval.grantedBy,
      createdAt: input.now,
      decidedAt: input.now,
    },
    logger,
  );
}
