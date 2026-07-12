// decideApprovalTask — AMENDMENTS.md A46/A47's riskReview-misattribution
// fix. A46 built the gate-parameterized ApprovalTask sentinel
// (`@aart/governance`'s `workflowVersionApprovalSubject`/
// `decodeWorkflowVersionApprovalSubject`, `stepId: "__gate:<gate>__"`) and
// flagged, but did not fix, a pre-existing dashboard-local bug: the
// dashboard's own approval-decision write path decoded `t.runId` ALONE
// (dropping `t.stepId`) and hardcoded `gates.humanReview` regardless of
// which gate actually decoded — a `riskReview` task decided through the
// dashboard silently misattributed to `humanReview`. This module is the ONE
// real implementation `POST /approvals/:id/decision`
// (`packages/server/src/http/server.ts`) now calls — the dashboard no
// longer has its own copy to drift.
import type { Workflow } from "@aart/types";
import { decodeWorkflowVersionApprovalSubject, workflowVersionApprovalSubject } from "@aart/governance";
import { describe, expect, it } from "vitest";
import { decideApprovalTask } from "./approvals.js";
import { createTestFixture, type TestFixture } from "./test-helpers.js";

function fixtureWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf_review",
    name: "n",
    version: "1.0.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [] },
    approval: "draft",
    gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    ...overrides,
  };
}

async function withFixture(fn: (fx: TestFixture) => Promise<void>): Promise<void> {
  const fx = await createTestFixture();
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

describe("decideApprovalTask — workflow-version decisions write the DECODED gate, never a hardcoded one (root AMENDMENTS.md A46, fixed A47)", () => {
  it("a default (humanReview) request writes gates.humanReview only — gates.riskReview stays untouched", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      const subject = workflowVersionApprovalSubject("wf_review", "1.0.0"); // default gate: humanReview
      await fx.store.approvals.put({ id: "task-human", ...subject, title: "Review", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      const result = await decideApprovalTask(fx.store, fx.engine, "task-human", { status: "approved", reviewer: "alice" }, fx.clock);

      expect(result.kind).toBe("workflow_version");
      if (result.kind !== "workflow_version") throw new Error("unreachable");
      expect(result.gates.humanReview).toBe("passed");
      expect(result.gates.riskReview).toBe("pending");
      expect(result.approval).toBe("approved"); // governed default in computeApprovalState requires validate+humanReview; validate already "passed"

      const persisted = await fx.store.workflows.get("wf_review", "1.0.0");
      expect(persisted?.gates.humanReview).toBe("passed");
      expect(persisted?.gates.riskReview).toBe("pending");
    });
  });

  // THE bug this entry fixes: a riskReview task decided through the
  // dashboard used to silently write gates.humanReview instead.
  it("a riskReview request writes gates.riskReview only — gates.humanReview stays untouched (the exact misattribution root AMENDMENTS.md A46 flagged)", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      const subject = workflowVersionApprovalSubject("wf_review", "1.0.0", "riskReview");
      expect(subject.stepId).toBe("__gate:riskReview__"); // sanity: the gate-parameterized sentinel this fix decodes
      await fx.store.approvals.put({ id: "task-risk", ...subject, title: "Risk review", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      const result = await decideApprovalTask(fx.store, fx.engine, "task-risk", { status: "approved", reviewer: "alice" }, fx.clock);

      expect(result.kind).toBe("workflow_version");
      if (result.kind !== "workflow_version") throw new Error("unreachable");
      expect(result.gates.riskReview).toBe("passed");
      expect(result.gates.humanReview).toBe("pending"); // must NOT have been touched

      const persisted = await fx.store.workflows.get("wf_review", "1.0.0");
      expect(persisted?.gates.riskReview).toBe("passed");
      expect(persisted?.gates.humanReview).toBe("pending");
      // governed mode requires validate+humanReview; riskReview passing
      // alone must not flip approval (proves the write really targeted
      // riskReview, not humanReview under a different label).
      expect(persisted?.approval).toBe("draft");
    });
  });

  it("both gates decided independently, in either order, on the same workflow version — production mode needs all five", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "pending", humanReview: "pending" } }));
      const riskSubject = workflowVersionApprovalSubject("wf_review", "1.0.0", "riskReview");
      const humanSubject = workflowVersionApprovalSubject("wf_review", "1.0.0", "humanReview");
      await fx.store.approvals.put({ id: "task-risk-2", ...riskSubject, title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
      await fx.store.approvals.put({ id: "task-human-2", ...humanSubject, title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      await decideApprovalTask(fx.store, fx.engine, "task-risk-2", { status: "approved", reviewer: "alice", trustMode: "production" }, fx.clock);
      const afterRisk = await fx.store.workflows.get("wf_review", "1.0.0");
      expect(afterRisk?.gates.riskReview).toBe("passed");
      expect(afterRisk?.gates.humanReview).toBe("pending");
      expect(afterRisk?.approval).toBe("draft"); // production needs humanReview too

      await decideApprovalTask(fx.store, fx.engine, "task-human-2", { status: "approved", reviewer: "bob", trustMode: "production" }, fx.clock);
      const afterBoth = await fx.store.workflows.get("wf_review", "1.0.0");
      expect(afterBoth?.gates.riskReview).toBe("passed");
      expect(afterBoth?.gates.humanReview).toBe("passed");
      expect(afterBoth?.approval).toBe("approved");
    });
  });

  it("a rejection writes 'failed', not 'passed', for whichever gate decoded", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      const subject = workflowVersionApprovalSubject("wf_review", "1.0.0", "riskReview");
      await fx.store.approvals.put({ id: "task-reject", ...subject, title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      const result = await decideApprovalTask(fx.store, fx.engine, "task-reject", { status: "rejected", reviewer: "alice" }, fx.clock);

      expect(result.kind).toBe("workflow_version");
      if (result.kind !== "workflow_version") throw new Error("unreachable");
      expect(result.gates.riskReview).toBe("failed");
      expect(result.gates.humanReview).toBe("pending");
    });
  });
});

// V1 event log foundation (AMENDMENTS.md A61) — this package's own copy of
// applyGateResult's (packages/mcp/src/handlers/governance.ts) event writes,
// required by package layering (@aart/server cannot import @aart/mcp).
describe("decideApprovalTask — V1 event log writes (AMENDMENTS.md A61)", () => {
  it("emits approval.decided (with workflowId/workflowVersion) and workflow.gate_passed for a version-review approval", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      const subject = workflowVersionApprovalSubject("wf_review", "1.0.0", "riskReview");
      await fx.store.approvals.put({ id: "task-events-1", ...subject, title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      await decideApprovalTask(fx.store, fx.engine, "task-events-1", { status: "approved", reviewer: "alice" }, fx.clock);

      const events = await fx.store.events.list();
      expect(events).toContainEqual(expect.objectContaining({ type: "approval.decided", approvalTaskId: "task-events-1", workflowId: "wf_review", workflowVersion: "1.0.0" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "workflow.gate_passed", workflowId: "wf_review", workflowVersion: "1.0.0" }));
    });
  });

  it("emits workflow.gate_failed (not gate_passed) for a rejection, and approval.decided with runId (not workflowId) for a genuine per-run wait", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      const subject = workflowVersionApprovalSubject("wf_review", "1.0.0", "riskReview");
      await fx.store.approvals.put({ id: "task-events-2", ...subject, title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
      await decideApprovalTask(fx.store, fx.engine, "task-events-2", { status: "rejected", reviewer: "alice" }, fx.clock);

      // status: "expired" — a non-resuming status (mirrors the "a
      // non-terminal status... does not attempt a resume at all" test
      // above) — this test only cares about the emitted event, not the
      // resume outcome, so it deliberately avoids needing a real RunRecord
      // for engine.resumeDirect to act on.
      await fx.store.approvals.put({ id: "task-events-run", runId: "run-events-1", stepId: "step1", title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
      await decideApprovalTask(fx.store, fx.engine, "task-events-run", { status: "expired", reviewer: "bob" }, fx.clock);

      const events = await fx.store.events.list();
      expect(events).toContainEqual(expect.objectContaining({ type: "workflow.gate_failed", workflowId: "wf_review", workflowVersion: "1.0.0" }));
      const runDecision = events.find((e) => e.approvalTaskId === "task-events-run");
      expect(runDecision).toMatchObject({ type: "approval.decided", runId: "run-events-1" });
      expect(runDecision).not.toHaveProperty("workflowId");
    });
  });

  // The exact gap this session's own mcp-side test caught first (governance.ts's
  // applyGateResult): `approval` is recomputed and written UNCONDITIONALLY on
  // every decision — whichever gate happens to be the LAST one a mode
  // requires flips the workflow to "approved" right here, with no separate
  // approveOrDeprecateWorkflow call ever happening.
  it("emits workflow.approved when this decision satisfies the LAST required gate — the same gap fixed in applyGateResult's mcp-side twin", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" } }));
      const subject = workflowVersionApprovalSubject("wf_review", "1.0.0"); // default gate: humanReview
      await fx.store.approvals.put({ id: "task-events-approved", ...subject, title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      // governed default requires validate+humanReview; validate is already
      // "passed" in the fixture, so this ONE decision completes approval.
      await decideApprovalTask(fx.store, fx.engine, "task-events-approved", { status: "approved", reviewer: "alice" }, fx.clock);

      const events = await fx.store.events.list();
      expect(events.filter((e) => e.type === "workflow.approved")).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ type: "workflow.approved", workflowId: "wf_review", workflowVersion: "1.0.0" }));
    });
  });

  it("does NOT emit workflow.approved when the decision is refused (invalid_gate) — no workflow write happens at all", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      const bogusSubject = { runId: "workflow-version:wf_review@1.0.0", stepId: "__gate:validate__" };
      await fx.store.approvals.put({ id: "task-events-bogus", ...bogusSubject, title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      await decideApprovalTask(fx.store, fx.engine, "task-events-bogus", { status: "approved", reviewer: "alice" }, fx.clock);

      const events = await fx.store.events.list();
      expect(events.some((e) => e.type === "workflow.approved" || e.type === "workflow.gate_passed")).toBe(false);
      // The task's own decision is still recorded as approval.decided (mirrors the underlying approvals.put behavior).
      expect(events).toContainEqual(expect.objectContaining({ type: "approval.decided", approvalTaskId: "task-events-bogus" }));
    });
  });
});

describe("decideApprovalTask — defense-in-depth: only humanReview/riskReview may be set by a human decision", () => {
  it("refuses a hand-crafted task whose stepId decodes to a non-approval-task gate (e.g. validate) — the task's OWN decision is still recorded", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      // Hand-crafted, bypassing requestApprovalHandler's own request-time
      // allowlist entirely — this is the load-bearing check (mirrors
      // packages/mcp/src/handlers/governance.ts's identical bypass test).
      const bogusSubject = { runId: "workflow-version:wf_review@1.0.0", stepId: "__gate:validate__" };
      await fx.store.approvals.put({ id: "task-bogus", ...bogusSubject, title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      const result = await decideApprovalTask(fx.store, fx.engine, "task-bogus", { status: "approved", reviewer: "alice" }, fx.clock);

      expect(result.kind).toBe("invalid_gate");
      if (result.kind !== "invalid_gate") throw new Error("unreachable");
      expect(result.gate).toBe("validate");

      // The ApprovalTask's own decision is still persisted (matches
      // packages/mcp's approveHandler ordering) — only the WORKFLOW gate
      // write is refused.
      const task = await fx.store.approvals.get("task-bogus");
      expect(task?.status).toBe("approved");
      expect(task?.reviewer).toBe("alice");

      // The workflow's gates must be completely untouched.
      const workflow = await fx.store.workflows.get("wf_review", "1.0.0");
      expect(workflow?.gates.validate).toBe("passed"); // unchanged from the fixture, not overwritten to anything else
    });
  });
});

describe("decideApprovalTask — genuine per-run waits are unaffected, still resume via the real engine", () => {
  it("resumes a real run's approval wait via engine.resumeDirect when runId/stepId don't decode to a version-review sentinel", async () => {
    await withFixture(async (fx) => {
      await fx.store.waits.put("run-1", "approve-step", { type: "approval", taskId: "task-run", schemaVersion: 1 }, fx.clock.nowIso());
      await fx.store.runs.put({
        runId: "run-1",
        workflowId: "wf",
        workflowVersion: "1",
        status: "waiting",
        approved: true,
        approvalMode: "governed",
        trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: fx.clock.nowIso() },
        inputs: {},
        trace: [],
        waits: [],
        artifacts: [],
        snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: fx.clock.nowIso() },
        startedAt: fx.clock.nowIso(),
        updatedAt: fx.clock.nowIso(),
        schemaVersion: 1,
      });
      await fx.store.approvals.put({ id: "task-run", runId: "run-1", stepId: "approve-step", title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      expect(decodeWorkflowVersionApprovalSubject("run-1", "approve-step")).toBeUndefined(); // sanity: not a sentinel

      const result = await decideApprovalTask(fx.store, fx.engine, "task-run", { status: "approved", reviewer: "alice" }, fx.clock);

      expect(result.kind).toBe("run_step");
      if (result.kind !== "run_step") throw new Error("unreachable");
      expect(result.resume?.kind).toBe("resumed");
      await expect(fx.store.runs.get("run-1")).resolves.toMatchObject({ status: "running" });
    });
  });

  it("a non-terminal status (e.g. still-pending) does not attempt a resume at all", async () => {
    await withFixture(async (fx) => {
      await fx.store.approvals.put({ id: "task-pending", runId: "run-2", stepId: "step1", title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
      // Any status outside approved/rejected/needs_changes takes the
      // no-resume-attempted path — "expired" exercises that branch.
      const result = await decideApprovalTask(fx.store, fx.engine, "task-pending", { status: "expired", reviewer: "alice" }, fx.clock);
      expect(result.kind).toBe("run_step");
      if (result.kind !== "run_step") throw new Error("unreachable");
      expect(result.resume).toBeUndefined();
    });
  });
});

describe("decideApprovalTask — error cases", () => {
  it("not_found for an unknown taskId", async () => {
    await withFixture(async (fx) => {
      const result = await decideApprovalTask(fx.store, fx.engine, "no-such-task", { status: "approved", reviewer: "alice" }, fx.clock);
      expect(result.kind).toBe("not_found");
    });
  });

  it("missing_reviewer when reviewer is empty, without persisting a decision", async () => {
    await withFixture(async (fx) => {
      await fx.store.approvals.put({ id: "task-noreviewer", runId: "run-3", stepId: "step1", title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
      const result = await decideApprovalTask(fx.store, fx.engine, "task-noreviewer", { status: "approved", reviewer: "" }, fx.clock);
      expect(result.kind).toBe("missing_reviewer");
      const task = await fx.store.approvals.get("task-noreviewer");
      expect(task?.status).toBe("pending"); // untouched
    });
  });

  it("workflow_not_found when the decoded workflow version doesn't exist (task decision is still recorded)", async () => {
    await withFixture(async (fx) => {
      const subject = workflowVersionApprovalSubject("no-such-workflow", "9.9.9");
      await fx.store.approvals.put({ id: "task-noworkflow", ...subject, title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });

      const result = await decideApprovalTask(fx.store, fx.engine, "task-noworkflow", { status: "approved", reviewer: "alice" }, fx.clock);

      expect(result.kind).toBe("workflow_not_found");
      const task = await fx.store.approvals.get("task-noworkflow");
      expect(task?.status).toBe("approved");
    });
  });
});
