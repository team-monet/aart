import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { approvalWaitWorkflowYaml, createTestContext, sampleWorkflowYaml } from "../test-utils.js";
import { registerWorkflowHandler } from "./authoring.js";
import { deployWorkflowHandler, listWaitingRunsHandler, resumeRunHandler, triggerWorkflowHandler } from "./deployment.js";
import { runWorkflowHandler } from "./execution.js";

let tc: TestContext;
afterEach(async () => {
  await tc?.cleanup();
});

async function approveAllGates(ctxStore: TestContext["ctx"]["store"], workflowId: string, version: string) {
  const wf = await ctxStore.workflows.get(workflowId, version);
  await ctxStore.workflows.put({
    ...wf!,
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
  });
}

describe("deployWorkflowHandler (aart_deploy_workflow)", () => {
  it("refuses to deploy an unapproved draft", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-deploy-1") });
    const result = await deployWorkflowHandler(tc.ctx, { workflowId: "wf-deploy-1", workflowVersion: "0.1.0", target: "staging" });
    expect(result.ok).toBe(false);
  });

  it("deploys an approved version, auto-creating the target environment", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-deploy-2") });
    await approveAllGates(tc.ctx.store, "wf-deploy-2", "0.1.0");
    const result = await deployWorkflowHandler(tc.ctx, { workflowId: "wf-deploy-2", workflowVersion: "0.1.0", target: "staging" });
    expect(result.ok).toBe(true);
    const environments = await tc.ctx.store.environments.list();
    expect(environments.some((e) => e.name === "staging")).toBe(true);
  });

  it("reuses an existing environment by name rather than creating a duplicate", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-deploy-3a") });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-deploy-3b") });
    await approveAllGates(tc.ctx.store, "wf-deploy-3a", "0.1.0");
    await approveAllGates(tc.ctx.store, "wf-deploy-3b", "0.1.0");
    await deployWorkflowHandler(tc.ctx, { workflowId: "wf-deploy-3a", workflowVersion: "0.1.0", target: "prod" });
    await deployWorkflowHandler(tc.ctx, { workflowId: "wf-deploy-3b", workflowVersion: "0.1.0", target: "prod" });
    const environments = await tc.ctx.store.environments.list();
    expect(environments.filter((e) => e.name === "prod")).toHaveLength(1);
  });

  it("fails cleanly when the workflow version doesn't exist", async () => {
    tc = await createTestContext();
    const result = await deployWorkflowHandler(tc.ctx, { workflowId: "nope", workflowVersion: "0.0.0", target: "staging" });
    expect(result.ok).toBe(false);
  });
});

describe("triggerWorkflowHandler (aart_trigger_workflow)", () => {
  it("refuses to trigger a workflow that isn't deployed anywhere", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-trigger-1") });
    const result = await triggerWorkflowHandler(tc.ctx, { workflowId: "wf-trigger-1" });
    expect(result.ok).toBe(false);
  });

  it("triggers a run once the workflow is deployed", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-trigger-2") });
    await approveAllGates(tc.ctx.store, "wf-trigger-2", "0.1.0");
    await deployWorkflowHandler(tc.ctx, { workflowId: "wf-trigger-2", workflowVersion: "0.1.0", target: "staging" });
    const result = await triggerWorkflowHandler(tc.ctx, { workflowId: "wf-trigger-2", input: { url: "https://example.com" } });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("run");
  });

  it("delivers a signal to resume a waiting run", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, {
      workflow: `id: wf-trigger-signal
name: Signal Wait
version: 0.1.0
steps:
  - id: wait
    uses: wait.for_signal
    with:
      name: external-event
      correlationId: corr-1
`,
    });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-trigger-signal" });
    expect(run.status).toBe("waiting");

    const result = await triggerWorkflowHandler(tc.ctx, {
      workflowId: "wf-trigger-signal",
      signal: { name: "external-event", correlationId: "corr-1", payload: { done: true } },
    });
    expect(result.ok).toBe(true);
    const finished = await tc.ctx.store.runs.get(run.runId as string);
    expect(finished?.status).toBe("completed");
  });
});

describe("listWaitingRunsHandler (aart_list_waiting_runs)", () => {
  it("lists runs currently waiting, with their wait conditions", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-waiting-1") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-waiting-1" });
    const result = await listWaitingRunsHandler(tc.ctx, {});
    expect(result.ok).toBe(true);
    const runs = result.runs as { runId: string; waits: unknown[] }[];
    expect(runs.some((r) => r.runId === run.runId)).toBe(true);
    const entry = runs.find((r) => r.runId === run.runId);
    expect(entry?.waits.length).toBeGreaterThan(0);
  });

  it("returns an empty list (still ok:true) when nothing is waiting", async () => {
    tc = await createTestContext();
    const result = await listWaitingRunsHandler(tc.ctx, {});
    expect(result.ok).toBe(true);
    expect(result.runs).toEqual([]);
  });
});

describe("resumeRunHandler (aart_resume_run)", () => {
  it("resumes a waiting run given only the runId (auto-discovers the stepId)", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-resume-1") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-resume-1" });
    const result = await resumeRunHandler(tc.ctx, { runId: run.runId as string, payload: { decision: "approved" } });
    expect(result.ok).toBe(true);
    const finished = await tc.ctx.store.runs.get(run.runId as string);
    expect(finished?.status).toBe("completed");
  });

  it("fails when nothing is waiting for the given runId", async () => {
    tc = await createTestContext();
    const result = await resumeRunHandler(tc.ctx, { runId: "run_nonexistent" });
    expect(result.ok).toBe(false);
  });

  it("resumes via a matching signal", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, {
      workflow: `id: wf-resume-signal
name: Signal Wait
version: 0.1.0
steps:
  - id: wait
    uses: wait.for_signal
    with:
      name: ext
      correlationId: c1
`,
    });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-resume-signal" });
    const result = await resumeRunHandler(tc.ctx, { runId: run.runId as string, signal: { name: "ext", correlationId: "c1" } });
    expect(result.ok).toBe(true);
  });
});
