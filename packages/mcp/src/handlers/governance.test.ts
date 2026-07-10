import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { approvalWaitWorkflowYaml, createTestContext, sampleWorkflowYaml } from "../test-utils.js";
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

  it("creates a version-review task when given workflowId+workflowVersion instead of runId+stepId", async () => {
    tc = await createTestContext();
    const result = await requestApprovalHandler(tc.ctx, { workflowId: "wf-x", workflowVersion: "1.0.0" });
    expect(result.ok).toBe(true);
    expect(result.runId).toBe("version-review:wf-x@1.0.0");
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

  it("fails cleanly for an unknown taskId", async () => {
    tc = await createTestContext();
    const result = await approveHandler(tc.ctx, { taskId: "task_nope", decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
  });
});

describe("recordCorrectionHandler (aart_record_correction)", () => {
  it("persists a correction with the required reviewer field", async () => {
    tc = await createTestContext();
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
});
