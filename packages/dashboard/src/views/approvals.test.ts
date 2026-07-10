import { decodeWorkflowVersionApprovalSubject, workflowVersionApprovalSubject } from "@aart/governance";
import { describe, expect, it } from "vitest";
import type { DecideApprovalTaskFn, ResumeApprovalFn } from "../deps.js";
import { createTestFixture, makeRun, makeWorkflow } from "../test-support/fixtures.js";
import { decideApprovalAction, renderApprovalQueuePage } from "./approvals.js";

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
});

describe("decideApprovalAction — same-function-reference proof for BOTH halves (task update + run resume)", () => {
  it("calls the injected decideApprovalTask, then the injected resumeApproval with that task's runId/stepId", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await store.runs.put(makeRun({ runId: "run-1", status: "waiting" }));
      await store.approvals.put({ id: "task-1", runId: "run-1", stepId: "step1", title: "t", description: "d", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" });

      const decideCalls: unknown[] = [];
      const resumeCalls: unknown[] = [];
      const spyDecide: DecideApprovalTaskFn = async (s, taskId, status, reviewer, decision) => {
        decideCalls.push({ taskId, status, reviewer, decision });
        const task = await s.approvals.get(taskId);
        const updated = { ...task!, status, reviewer, decision, decidedAt: "2026-07-10T00:00:00.000Z" };
        await s.approvals.put(updated);
        return updated;
      };
      const spyResume: ResumeApprovalFn = async (runId, stepId, task) => {
        resumeCalls.push({ runId, stepId, task });
        return { kind: "unmatched", mechanism: "direct_lookup" };
      };

      await decideApprovalAction({ ...deps, decideApprovalTask: spyDecide, resumeApproval: spyResume }, store, "task-1", "approved", "alice");

      expect(decideCalls).toEqual([{ taskId: "task-1", status: "approved", reviewer: "alice", decision: undefined }]);
      expect(resumeCalls).toEqual([{ runId: "run-1", stepId: "step1", task: { id: "task-1", status: "approved", decision: undefined, reviewer: "alice" } }]);
    } finally {
      await cleanup();
    }
  });

  // S9 integration (reconciliation ledger item 1's real bug find): before
  // this fix, a decision on a workflow-version task silently called
  // resumeApproval (a safe no-op against the sentinel runId/stepId) and
  // NEVER updated Workflow.gates.humanReview/approval - the operator's
  // decision was recorded on the ApprovalTask but had no actual effect.
  it("a decision on a workflow-version task updates gates.humanReview + approval, NOT resumeApproval (the bug this fix closes)", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({
        id: "wf-version-review",
        version: "3.0.0",
        gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
      });
      await store.workflows.put(workflow);

      const subject = workflowVersionApprovalSubject("wf-version-review", "3.0.0");
      await store.approvals.put({ id: "task-version-1", ...subject, title: "Review", description: "d", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" });

      let resumeCalled = false;
      const spyResume: ResumeApprovalFn = async () => {
        resumeCalled = true;
        return { kind: "unmatched", mechanism: "direct_lookup" };
      };

      const result = await decideApprovalAction({ ...deps, resumeApproval: spyResume }, store, "task-version-1", "approved", "alice", undefined, "governed");

      expect(result.kind).toBe("workflow_version");
      expect(resumeCalled).toBe(false); // the bug: this used to be called against a sentinel runId/stepId

      const updated = await store.workflows.get("wf-version-review", "3.0.0");
      expect(updated?.gates.humanReview).toBe("passed");
      // governed mode requires validate+humanReview passed; validate was
      // already "passed" in the fixture, so this decision should flip
      // approval to "approved".
      expect(updated?.approval).toBe("approved");
    } finally {
      await cleanup();
    }
  });

  it("decodeWorkflowVersionApprovalSubject round-trips through workflowVersionApprovalSubject for any real per-run task's runId (never false-positives)", async () => {
    // A genuine RunRecord.runId (generated by ids.ts, never this sentinel
    // shape) must never be misidentified as a workflow-version subject.
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await store.runs.put(makeRun({ runId: "run-genuine-1", status: "waiting" }));
      await store.approvals.put({ id: "task-genuine-1", runId: "run-genuine-1", stepId: "step1", title: "t", description: "d", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" });
      expect(decodeWorkflowVersionApprovalSubject("run-genuine-1")).toBeUndefined();

      const result = await decideApprovalAction(deps, store, "task-genuine-1", "approved", "alice");
      expect(result.kind).toBe("run_step");
    } finally {
      await cleanup();
    }
  });
});
