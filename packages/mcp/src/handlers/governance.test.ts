import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { approvalWaitWorkflowYaml, createTestContext, putCorrectableRun, sampleWorkflowYaml } from "../test-utils.js";
import { registerWorkflowHandler } from "./authoring.js";
import { runWorkflowHandler } from "./execution.js";
import { approveHandler, diffWorkflowHandler, promoteWorkflowHandler, recordCorrectionHandler, requestApprovalHandler } from "./governance.js";

let tc: TestContext;
afterEach(async () => {
  await tc?.cleanup();
});

describe("requestApprovalHandler (aart_request_approval)", () => {
  it("creates a pending task for a run's paused step", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-req-approval-1") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-req-approval-1" });
    const result = await requestApprovalHandler(tc.ctx, { runId: run.runId as string, stepId: "approve" });
    expect(result.ok).toBe(true);
    const task = await tc.ctx.store.approvals.get(result.taskId as string);
    expect(task?.status).toBe("pending");
  });

  // V1 event log foundation (AMENDMENTS.md A61)
  it("emits an approval.requested event carrying runId for a genuine per-run request", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-req-approval-event") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-req-approval-event" });
    const result = await requestApprovalHandler(tc.ctx, { runId: run.runId as string, stepId: "approve" });
    const events = await tc.ctx.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.requested", approvalTaskId: result.taskId, runId: run.runId }));
  });

  it("emits an approval.requested event carrying workflowId/workflowVersion (not runId) for a workflow-version-level request", async () => {
    tc = await createTestContext();
    const result = await requestApprovalHandler(tc.ctx, { workflowId: "wf-req-approval-version-event", workflowVersion: "1.0.0" });
    const events = await tc.ctx.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.requested", approvalTaskId: result.taskId, workflowId: "wf-req-approval-version-event", workflowVersion: "1.0.0" }));
    expect(events.find((e) => e.type === "approval.requested")).not.toHaveProperty("runId");
  });

  // S9 integration (reconciliation ledger item 1): the sentinel format is
  // now @aart/governance's real workflowVersionApprovalSubject convention
  // ("workflow-version:<id>@<version>" / "__gate:humanReview__"), not this
  // package's former locally-invented "version-review:<id>@<version>" /
  // "humanReview".
  it("creates a workflow-version task when given workflowId+workflowVersion instead of runId+stepId", async () => {
    tc = await createTestContext();
    const result = await requestApprovalHandler(tc.ctx, { workflowId: "wf-x", workflowVersion: "1.0.0" });
    expect(result.ok).toBe(true);
    expect(result.runId).toBe("workflow-version:wf-x@1.0.0");
    expect(result.stepId).toBe("__gate:humanReview__");
  });

  it("fails when neither shape of input is given", async () => {
    tc = await createTestContext();
    const result = await requestApprovalHandler(tc.ctx, {});
    expect(result.ok).toBe(false);
  });
});

describe("approveHandler (aart_approve) — mode-agnostic at the handler level (gating is a tool-list concern)", () => {
  it("records a decision on a run-step task and resumes the run", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-approve-run") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-approve-run" });
    const request = await requestApprovalHandler(tc.ctx, { runId: run.runId as string, stepId: "approve" });
    const result = await approveHandler(tc.ctx, { taskId: request.taskId as string, decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("run_step");
    const finished = await tc.ctx.store.runs.get(run.runId as string);
    expect(finished?.status).toBe("completed");
  });

  it("a rejected run-step decision fails the run", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-approve-reject") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-approve-reject" });
    const request = await requestApprovalHandler(tc.ctx, { runId: run.runId as string, stepId: "approve" });
    await approveHandler(tc.ctx, { taskId: request.taskId as string, decision: "rejected", reviewer: "alice" });
    const finished = await tc.ctx.store.runs.get(run.runId as string);
    expect(finished?.status).toBe("failed");
  });

  it("records a decision on a workflow-version review task and updates gates.humanReview + approval", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-approve-version") });
    // governed mode requires validate=passed + humanReview=passed; satisfy validate directly for this test.
    const wf = await tc.ctx.store.workflows.get("wf-approve-version", "0.1.0");
    await tc.ctx.store.workflows.put({ ...wf!, gates: { ...wf!.gates, validate: "passed" } });

    const request = await requestApprovalHandler(tc.ctx, { workflowId: "wf-approve-version", workflowVersion: "0.1.0" });
    const result = await approveHandler(tc.ctx, { taskId: request.taskId as string, decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(true);
    expect(result.approval).toBe("approved");

    const updated = await tc.ctx.store.workflows.get("wf-approve-version", "0.1.0");
    expect(updated?.gates.humanReview).toBe("passed");
    expect(updated?.approval).toBe("approved");
  });

  // V1 event log foundation (AMENDMENTS.md A61) — approveHandler is a
  // SECOND real entry point for approval.decided (CLI `aart approve` / MCP
  // `aart_approve`), independent of server/approvals.ts's decideApprovalTask
  // (the dashboard's HTTP path) — see approveHandler's own comment for why
  // both are needed. This also proves the version-review path emits
  // workflow.gate_passed (humanReview) AND workflow.approved once every
  // required gate is met, all from the SAME decision.
  it("emits approval.decided, workflow.gate_passed, and workflow.approved for a workflow-version review decision that completes approval", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-approve-version-events") });
    const wf = await tc.ctx.store.workflows.get("wf-approve-version-events", "0.1.0");
    await tc.ctx.store.workflows.put({ ...wf!, gates: { ...wf!.gates, validate: "passed" } });

    const request = await requestApprovalHandler(tc.ctx, { workflowId: "wf-approve-version-events", workflowVersion: "0.1.0" });
    await approveHandler(tc.ctx, { taskId: request.taskId as string, decision: "approved", reviewer: "alice" });

    const events = await tc.ctx.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.decided", approvalTaskId: request.taskId, workflowId: "wf-approve-version-events", workflowVersion: "0.1.0" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow.gate_passed", workflowId: "wf-approve-version-events", workflowVersion: "0.1.0" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow.approved", workflowId: "wf-approve-version-events", workflowVersion: "0.1.0" }));
  });

  // A genuine per-run wait decision: approval.decided fires with runId, and
  // NO workflow.gate_passed/workflow.approved (this decision isn't a
  // workflow-version review at all — decodeWorkflowVersionApprovalSubject
  // returns undefined for it).
  it("emits approval.decided with runId (not workflowId) for a genuine per-run wait decision, with no workflow gate/approval events", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-approve-run-event") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-approve-run-event" });
    const request = await requestApprovalHandler(tc.ctx, { runId: run.runId as string, stepId: "approve" });
    await approveHandler(tc.ctx, { taskId: request.taskId as string, decision: "approved", reviewer: "alice" });

    const events = await tc.ctx.store.events.list();
    const decided = events.find((e) => e.type === "approval.decided");
    expect(decided).toMatchObject({ approvalTaskId: request.taskId, runId: run.runId });
    expect(decided).not.toHaveProperty("workflowId");
    expect(events.some((e) => e.type === "workflow.gate_passed" || e.type === "workflow.approved")).toBe(false);
  });

  it("fails cleanly for an unknown taskId", async () => {
    tc = await createTestContext();
    const result = await approveHandler(tc.ctx, { taskId: "task_nope", decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
  });
});

describe("requestApprovalHandler / approveHandler — the riskReview GATE writer via --gate (S14 'gate write paths'), no new mechanism", () => {
  it("--gate riskReview creates a task with a riskReview-shaped stepId, distinct from the humanReview default", async () => {
    tc = await createTestContext();
    const result = await requestApprovalHandler(tc.ctx, { workflowId: "wf-riskreview-1", workflowVersion: "0.1.0", gate: "riskReview" });
    expect(result.ok).toBe(true);
    expect(result.stepId).toBe("__gate:riskReview__");
  });

  it("omitting --gate still defaults to humanReview (regression: pre-S14 behavior unchanged)", async () => {
    tc = await createTestContext();
    const result = await requestApprovalHandler(tc.ctx, { workflowId: "wf-riskreview-default", workflowVersion: "1.0.0" });
    expect(result.stepId).toBe("__gate:humanReview__");
  });

  it("rejects an invalid --gate value at request time", async () => {
    tc = await createTestContext();
    const result = await requestApprovalHandler(tc.ctx, { workflowId: "wf-riskreview-bad", workflowVersion: "1.0.0", gate: "validate" });
    expect(result.ok).toBe(false);
  });

  it("approving a riskReview task writes gates.riskReview (not gates.humanReview) and recomputes approval", async () => {
    tc = await createTestContext({ trustMode: "production" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-riskreview-2") });
    // production requires all 5 gates -- satisfy the other 4 directly so
    // this ONE decision is what flips approval, proving the write actually
    // lands on riskReview specifically (not a coincidental side effect).
    const wf = await tc.ctx.store.workflows.get("wf-riskreview-2", "0.1.0");
    await tc.ctx.store.workflows.put({ ...wf!, gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "pending", humanReview: "passed" } });

    const request = await requestApprovalHandler(tc.ctx, { workflowId: "wf-riskreview-2", workflowVersion: "0.1.0", gate: "riskReview" });
    const result = await approveHandler(tc.ctx, { taskId: request.taskId as string, decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(true);
    expect(result.approval).toBe("approved");

    const updated = await tc.ctx.store.workflows.get("wf-riskreview-2", "0.1.0");
    expect(updated?.gates.riskReview).toBe("passed");
    expect(updated?.gates.humanReview).toBe("passed"); // untouched, was already passed before this decision
  });

  it("a hand-crafted approval task targeting a non-approval-task gate (e.g. 'validate') is refused at approve time — spec §17.1's 'each gate is advanced only by its own mechanism' holds even against a bypass of the request-time check", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-bypass-1") });
    // The RAW runId+stepId shape (genuine per-run-wait input) has no way at
    // request time to recognize it's spoofing the workflow-version sentinel
    // convention with a disallowed gate -- exactly the gap
    // applyVersionReviewDecision's own defensive re-check exists to close.
    const request = await requestApprovalHandler(tc.ctx, { runId: "workflow-version:wf-bypass-1@0.1.0", stepId: "__gate:validate__" });
    expect(request.ok).toBe(true);

    const result = await approveHandler(tc.ctx, { taskId: request.taskId as string, decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);

    const stored = await tc.ctx.store.workflows.get("wf-bypass-1", "0.1.0");
    expect(stored?.gates.validate).toBe("pending"); // untouched -- the bypass attempt did not work
  });
});

describe("recordCorrectionHandler (aart_record_correction)", () => {
  it("persists a correction with the required reviewer field", async () => {
    tc = await createTestContext();
    await putCorrectableRun(tc.ctx, "run_1", "extract");
    const result = await recordCorrectionHandler(tc.ctx, {
      runId: "run_1",
      stepId: "extract",
      fieldPath: "outputs.nmi",
      observed: "6401234567",
      corrected: "6401234568",
      reason: "OCR misread final digit",
      reviewer: "alice",
    });
    expect(result.ok).toBe(true);
    const stored = await tc.ctx.store.corrections.list({ runId: "run_1" });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.reviewer).toBe("alice");
  });

  // V1 event log foundation (AMENDMENTS.md A61)
  it("emits a correction.recorded event carrying runId", async () => {
    tc = await createTestContext();
    await putCorrectableRun(
      tc.ctx,
      "run_event_1",
      "extract",
    );
    await recordCorrectionHandler(tc.ctx, {
      runId: "run_event_1",
      stepId: "extract",
      fieldPath: "outputs.nmi",
      observed: "a",
      corrected: "b",
      reason: "OCR",
      reviewer: "alice",
    });
    const events = await tc.ctx.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "correction.recorded", runId: "run_event_1" }));
  });
});

describe("diffWorkflowHandler (aart_diff_workflow)", () => {
  it("computes a semantic diff between two versions", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-diff", "0.1.0") });
    await registerWorkflowHandler(tc.ctx, {
      workflow: `id: wf-diff
name: Sample Workflow
version: 0.2.0
inputs:
  url:
    type: string
    required: true
steps:
  - id: open
    uses: browser.goto
    with:
      url: "{{ inputs.url }}"
  - id: read
    uses: web.read
  - id: assert
    uses: assert.contains
    with:
      value: "{{ steps.read.outputs.text }}"
      expected: "Checkout"
`,
    });
    const result = await diffWorkflowHandler(tc.ctx, { workflowId: "wf-diff", fromVersion: "0.1.0", toVersion: "0.2.0" });
    expect(result.ok).toBe(true);
    const diff = result.diff as { added: { stepId: string }[] };
    expect(diff.added.map((s) => s.stepId)).toContain("assert");
  });

  it("fails when a version doesn't exist", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-diff-2", "0.1.0") });
    const result = await diffWorkflowHandler(tc.ctx, { workflowId: "wf-diff-2", fromVersion: "0.1.0", toVersion: "9.9.9" });
    expect(result.ok).toBe(false);
  });
});

describe("promoteWorkflowHandler (aart_promote_workflow)", () => {
  it("refuses to promote when required gates are unmet", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-promote-1") });
    const result = await promoteWorkflowHandler(tc.ctx, { workflowId: "wf-promote-1", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(false);
    expect((result.unmetGates as string[]).length).toBeGreaterThan(0);
  });

  it("promotes once every required gate has passed", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-promote-2") });
    const wf = await tc.ctx.store.workflows.get("wf-promote-2", "0.1.0");
    await tc.ctx.store.workflows.put({ ...wf!, gates: { ...wf!.gates, validate: "passed", humanReview: "passed" } });
    const result = await promoteWorkflowHandler(tc.ctx, { workflowId: "wf-promote-2", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(true);
    expect(result.approval).toBe("approved");
  });

  it("dev mode promotes nothing (never-satisfiable empty required-gate set, governance's own documented rule)", async () => {
    tc = await createTestContext({ trustMode: "dev" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-promote-dev") });
    const result = await promoteWorkflowHandler(tc.ctx, { workflowId: "wf-promote-dev", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(false);
    expect(result.approval).toBe("draft");
  });

  // V1 event log foundation (AMENDMENTS.md A61)
  it("emits a workflow.approved event only on a genuine transition to approved, never on refusal or a no-op re-promote", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-promote-event") });
    // Refused (gates unmet) — no event yet.
    await promoteWorkflowHandler(tc.ctx, { workflowId: "wf-promote-event", workflowVersion: "0.1.0" });
    expect((await tc.ctx.store.events.list()).some((e) => e.type === "workflow.approved")).toBe(false);

    const wf = await tc.ctx.store.workflows.get("wf-promote-event", "0.1.0");
    await tc.ctx.store.workflows.put({ ...wf!, gates: { ...wf!.gates, validate: "passed", humanReview: "passed" } });
    await promoteWorkflowHandler(tc.ctx, { workflowId: "wf-promote-event", workflowVersion: "0.1.0" });
    const afterApprove = await tc.ctx.store.events.list();
    expect(afterApprove.filter((e) => e.type === "workflow.approved")).toHaveLength(1);

    // Idempotent re-promote of an ALREADY-approved workflow — no write happens (approval unchanged), so no second event.
    await promoteWorkflowHandler(tc.ctx, { workflowId: "wf-promote-event", workflowVersion: "0.1.0" });
    const afterRePromote = await tc.ctx.store.events.list();
    expect(afterRePromote.filter((e) => e.type === "workflow.approved")).toHaveLength(1);
  });
});
