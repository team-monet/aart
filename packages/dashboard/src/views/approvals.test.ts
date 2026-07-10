import { describe, expect, it } from "vitest";
import type { DecideApprovalTaskFn, ResumeApprovalFn } from "../deps.js";
import { createTestFixture, makeRun } from "../test-support/fixtures.js";
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
});
