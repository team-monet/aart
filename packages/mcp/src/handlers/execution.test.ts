import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { approvalWaitWorkflowYaml, createTestContext, failingWorkflowYaml, sampleWorkflowYaml } from "../test-utils.js";
import { registerWorkflowHandler } from "./authoring.js";
import { getReportHandler, runWorkflowHandler, verifyHandler } from "./execution.js";

let tc: TestContext;
afterEach(async () => {
  await tc?.cleanup();
});

describe("runWorkflowHandler (aart_run_workflow)", () => {
  it("runs a registered workflow through to completion", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-run-1") });
    const result = await runWorkflowHandler(tc.ctx, { workflowId: "wf-run-1", input: { url: "https://example.com" } });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(typeof result.runId).toBe("string");
  });

  it("a workflow ending in flow.fail produces a failed run (ok:false)", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: failingWorkflowYaml("wf-run-fail") });
    const result = await runWorkflowHandler(tc.ctx, { workflowId: "wf-run-fail" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });

  it("a workflow hitting human.approval produces a waiting run (still ok:true)", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-run-wait") });
    const result = await runWorkflowHandler(tc.ctx, { workflowId: "wf-run-wait" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("waiting");
  });

  it("fails cleanly when the workflow isn't registered", async () => {
    tc = await createTestContext();
    const result = await runWorkflowHandler(tc.ctx, { workflowId: "does-not-exist" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  // V1 event log foundation (AMENDMENTS.md A61) — the shared entry point
  // CLI `aart run` and MCP `aart_run_workflow` both dispatch through.
  it("emits a run.started event carrying workflowId/workflowVersion/runId", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-run-event") });
    const result = await runWorkflowHandler(tc.ctx, { workflowId: "wf-run-event", input: { url: "https://example.com" } });
    const events = await tc.ctx.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "run.started", workflowId: "wf-run-event", workflowVersion: "0.1.0", runId: result.runId }));
  });

  it("runs the latest version when workflowVersion is omitted", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-run-latest", "0.1.0") });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-run-latest", "0.2.0") });
    const result = await runWorkflowHandler(tc.ctx, { workflowId: "wf-run-latest", input: { url: "https://example.com" } });
    expect(result.ok).toBe(true);
    const run = await tc.ctx.store.runs.get(result.runId as string);
    expect(run?.workflowVersion).toBe("0.2.0");
  });
});

describe("getReportHandler (aart_get_report)", () => {
  it("returns a model-facing report for a completed run", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-report-1") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-report-1", input: { url: "https://example.com" } });
    const result = await getReportHandler(tc.ctx, { runId: run.runId as string });
    expect(result.ok).toBe(true);
    const report = result.report as { headline: string; workflowId: string; next: string };
    expect(report.headline).toBe("passed");
    expect(report.workflowId).toBe("wf-report-1");
    expect(typeof report.next).toBe("string");
  });

  it("includes markdown when format=markdown is requested", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-report-2") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-report-2", input: { url: "https://example.com" } });
    const result = await getReportHandler(tc.ctx, { runId: run.runId as string, format: "markdown" });
    expect(typeof result.markdown).toBe("string");
    expect((result.markdown as string).length).toBeGreaterThan(0);
  });

  it("fails cleanly for an unknown runId", async () => {
    tc = await createTestContext();
    const result = await getReportHandler(tc.ctx, { runId: "run_nonexistent" });
    expect(result.ok).toBe(false);
  });

  it("reports failures[] correctly for a failed run", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: failingWorkflowYaml("wf-report-fail") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-report-fail" });
    const result = await getReportHandler(tc.ctx, { runId: run.runId as string });
    const report = result.report as { headline: string; failures: unknown[] };
    expect(report.headline).toBe("failed");
    expect(report.failures.length).toBeGreaterThan(0);
  });
});

describe("runWorkflowHandler — the readiness GATE writer (S14 'gate write paths')", () => {
  it("a completed real run of a registered version writes gates.readiness = 'passed'", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-readiness-1") });
    const result = await runWorkflowHandler(tc.ctx, { workflowId: "wf-readiness-1", input: { url: "https://example.com" } });
    expect(result.ok).toBe(true);
    expect((result.gates as { readiness: string }).readiness).toBe("passed");
    const stored = await tc.ctx.store.workflows.get("wf-readiness-1", "0.1.0");
    expect(stored?.gates.readiness).toBe("passed");
  });

  it("a dry run does NOT write gates.readiness, even though it also reports status 'completed' — a dry run fakes dispatch and proves nothing real", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-readiness-dry") });
    const result = await runWorkflowHandler(tc.ctx, { workflowId: "wf-readiness-dry", input: { url: "https://example.com" }, dryRun: true });
    expect(result.status).toBe("completed");
    const stored = await tc.ctx.store.workflows.get("wf-readiness-dry", "0.1.0");
    expect(stored?.gates.readiness).toBe("pending");
  });

  it("a failed run does not write gates.readiness — only a genuinely completed run counts", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: failingWorkflowYaml("wf-readiness-fail") });
    await runWorkflowHandler(tc.ctx, { workflowId: "wf-readiness-fail" });
    const stored = await tc.ctx.store.workflows.get("wf-readiness-fail", "0.1.0");
    expect(stored?.gates.readiness).toBe("pending");
  });

  it("running a specific PINNED (non-latest) version writes readiness onto THAT exact version, leaving a sibling version's gate untouched — negative test: an unrun version lacks readiness", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-readiness-pinned", "0.1.0") });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-readiness-pinned", "0.2.0") });
    await runWorkflowHandler(tc.ctx, { workflowId: "wf-readiness-pinned", workflowVersion: "0.1.0", input: { url: "https://example.com" } });

    const v1 = await tc.ctx.store.workflows.get("wf-readiness-pinned", "0.1.0");
    const v2 = await tc.ctx.store.workflows.get("wf-readiness-pinned", "0.2.0");
    expect(v1?.gates.readiness).toBe("passed");
    expect(v2?.gates.readiness).toBe("pending"); // never run -- still lacks readiness
  });

  it("aart_verify's synthetic workflow (gates pre-'waived') runs cleanly through this SAME readiness-writing path — no special-casing of a prior 'waived' state (matches the pre-existing humanReview writer's own precedent; 'waived' and 'passed' are behaviorally identical for computeApprovalState)", async () => {
    tc = await createTestContext();
    const result = await verifyHandler(tc.ctx, { url: "https://example.com" });
    expect(result.ok).toBe(true);
    const stored = await tc.ctx.store.workflows.get("__aart_verify__", "0.1.0-no-expect");
    expect(["waived", "passed"]).toContain(stored?.gates.readiness);
  });
});

describe("verifyHandler (aart_verify) — the agent's easiest success path (spec §32.6)", () => {
  it("one call, url only: returns a passed report", async () => {
    tc = await createTestContext();
    const result = await verifyHandler(tc.ctx, { url: "https://example.com" });
    expect(result.ok).toBe(true);
    const report = result.report as { headline: string };
    expect(report.headline).toBe("passed");
    expect(typeof result.runId).toBe("string");
  });

  it("registers a reusable synthetic workflow the first time, then reuses it (single stored version per expect-shape)", async () => {
    tc = await createTestContext();
    await verifyHandler(tc.ctx, { url: "https://example.com" });
    await verifyHandler(tc.ctx, { url: "https://example.org" });
    const versions = await tc.ctx.store.workflows.listVersions("__aart_verify__");
    expect(versions).toHaveLength(1);
  });

  it("accepts an optional expect string without erroring", async () => {
    tc = await createTestContext();
    const result = await verifyHandler(tc.ctx, { url: "https://example.com", expect: "Example" });
    expect(result.ok).toBe(true);
  });
});
