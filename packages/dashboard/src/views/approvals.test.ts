import { workflowVersionApprovalSubject } from "@aart/governance";
import { describe, expect, it } from "vitest";
import { renderApprovalQueuePage } from "./approvals.js";

// AMENDMENTS.md A47: `decideApprovalAction` (formerly tested below) is
// deleted from this module — the decision write now lives entirely
// server-side (`packages/server/src/approvals.ts`'s `decideApprovalTask`,
// tested there, including the riskReview-misattribution fix this exact
// describe block used to cover for the OLD, now-removed dashboard-local
// gate-decode). This file keeps only the pure rendering left here.
describe("renderApprovalQueuePage", () => {
  it("lists only pending tasks with a decision form", () => {
    const html = renderApprovalQueuePage([
      { id: "t1", runId: "run-1", stepId: "s1", title: "Ship it?", description: "d", status: "pending", createdAt: "t" },
      { id: "t2", runId: "run-2", stepId: "s1", title: "Old", description: "d", status: "approved", createdAt: "t", decidedAt: "t" },
    ]);
    expect(html).toContain("Ship it?");
    expect(html).not.toContain("Old");
    expect(html).toContain('action="/approvals/t1/decision"');
  });

  // S9 integration (reconciliation ledger item 1's lower-priority UX fix):
  // a workflow-version-level task's runId is a sentinel, not a real run -
  // linking to /runs/<sentinel> was always a dead link.
  it("links a workflow-version task to its workflow, not a dead /runs/<sentinel> link", () => {
    const subject = workflowVersionApprovalSubject("wf-review", "2.0.0");
    const html = renderApprovalQueuePage([
      { id: "t1", runId: subject.runId, stepId: subject.stepId, title: "Review v2.0.0", description: "d", status: "pending", createdAt: "t" },
    ]);
    expect(html).toContain('<a href="/workflows/wf-review">wf-review@2.0.0</a>');
    expect(html).not.toContain(`/runs/${subject.runId}`);
  });

  // AMENDMENTS.md A47: the queue table now labels WHICH gate a
  // version-review row decides (decoding `t.stepId`, not just `t.runId` —
  // the same decode this session's server-side fix applies at write time)
  // — a riskReview request no longer displays indistinguishably from a
  // humanReview one.
  it("labels a riskReview version-review task distinctly from a humanReview one", () => {
    const humanSubject = workflowVersionApprovalSubject("wf-review", "2.0.0"); // default gate
    const riskSubject = workflowVersionApprovalSubject("wf-review", "2.0.0", "riskReview");
    const html = renderApprovalQueuePage([
      { id: "t-human", runId: humanSubject.runId, stepId: humanSubject.stepId, title: "Review", description: "d", status: "pending", createdAt: "t" },
      { id: "t-risk", runId: riskSubject.runId, stepId: riskSubject.stepId, title: "Risk review", description: "d", status: "pending", createdAt: "t" },
    ]);
    expect(html).toContain("(humanReview review)");
    expect(html).toContain("(riskReview review)");
  });
});
