import { describe, expect, it } from "vitest";
import { createFallbackReportRenderers } from "./report-renderers-port.js";
import { fakeRunRecord, fakeStepTrace } from "../test-support/fixtures.js";

describe("createFallbackReportRenderers", () => {
  const renderers = createFallbackReportRenderers();

  it("modelFacing: maps a completed run to headline 'passed' with no failures", () => {
    const run = fakeRunRecord({ status: "completed" });
    const report = renderers.modelFacing(run);
    expect(report.headline).toBe("passed");
    expect(report.workflowId).toBe(run.workflowId);
    expect(report.workflowVersion).toBe(run.workflowVersion);
    expect(report.failures).toEqual([]);
    expect(report.next).toMatch(/no action needed/i);
  });

  it("modelFacing: maps a failed run's failed steps into report.failures[]", () => {
    const run = fakeRunRecord({
      status: "failed",
      trace: [
        fakeStepTrace({ stepId: "step-a", block: "http.request", status: "completed" }),
        fakeStepTrace({ stepId: "step-b", block: "assert.equals", status: "failed", error: "expected 1, got 2" }),
      ],
    });
    const report = renderers.modelFacing(run);
    expect(report.headline).toBe("failed");
    expect(report.failures).toEqual([{ stepId: "step-b", block: "assert.equals", error: "expected 1, got 2" }]);
    expect(report.next).toContain("step-b");
  });

  it("modelFacing: maps waiting/pending/running to headline 'waiting'", () => {
    expect(renderers.modelFacing(fakeRunRecord({ status: "waiting" })).headline).toBe("waiting");
    expect(renderers.modelFacing(fakeRunRecord({ status: "pending" })).headline).toBe("waiting");
    expect(renderers.modelFacing(fakeRunRecord({ status: "running" })).headline).toBe("waiting");
  });

  it("modelFacing: maps cancelled to headline 'failed'", () => {
    expect(renderers.modelFacing(fakeRunRecord({ status: "cancelled" })).headline).toBe("failed");
  });

  it("modelFacing: maps artifacts to artifactRefs {id, kind, uri}", () => {
    const run = fakeRunRecord({
      artifacts: [{ id: "art-1", runId: "run-0001", name: "shot.png", kind: "screenshot", mime: "image/png", path: "/artifacts/shot.png", bytes: 10, createdAt: "2026-07-10T00:00:00.000Z" }],
    });
    expect(renderers.modelFacing(run).artifactRefs).toEqual([{ id: "art-1", kind: "screenshot", uri: "/artifacts/shot.png" }]);
  });

  it("includes workflow outputs in every fallback renderer", () => {
    const run = fakeRunRecord({ outputs: { items: ["alpha", "beta"], count: 2 } });
    expect(renderers.modelFacing(run).outputs).toEqual({ items: ["alpha", "beta"], count: 2 });
    for (const rendered of [renderers.markdown(run), renderers.cliText(run), renderers.html(run), renderers.prComment(run)]) {
      expect(rendered).toContain("alpha");
      expect(rendered).toContain("count");
    }
  });

  it("bounds oversized outputs in the fallback model-facing renderer", () => {
    const run = fakeRunRecord({ outputs: { document: "x".repeat(200_000) } });
    const report = renderers.modelFacing(run);
    expect(JSON.stringify(report).length).toBeLessThan(8_000);
    expect(report.outputs).toMatchObject({ $aart: { kind: "truncated-workflow-outputs", fullResultRef: { runId: run.runId, field: "outputs" } } });
  });

  it("keeps oversized outputs complete in fallback human-facing renderers", () => {
    const document = `start-${"x".repeat(10_000)}-end`;
    const run = fakeRunRecord({ outputs: { document } });

    expect(renderers.modelFacing(run).outputs).not.toEqual(run.outputs);
    for (const rendered of [renderers.markdown(run), renderers.cliText(run), renderers.html(run), renderers.prComment(run)]) {
      expect(rendered).toContain("start-");
      expect(rendered).toContain("-end");
      expect(rendered).not.toContain("truncated-workflow-outputs");
    }
  });

  it("surfaces a run-level output failure in every fallback renderer when no trace step failed", () => {
    const error = 'Workflow output validation failed: output "result" expected type "string" but received "object"';
    const run = fakeRunRecord({ status: "failed", error });
    expect(renderers.modelFacing(run).failures).toEqual([{ stepId: "$workflow", block: "workflow.outputMapping", error }]);
    for (const rendered of [renderers.markdown(run), renderers.cliText(run), renderers.html(run), renderers.prComment(run)]) {
      expect(rendered).toContain("Workflow output validation failed");
      expect(rendered).toContain("workflow.outputMapping");
    }
  });

  it("keeps the terminal output failure when an older failed trace also exists", () => {
    const error = "Workflow output mapping failed: corrected result is missing";
    const run = fakeRunRecord({
      status: "failed",
      error,
      trace: [fakeStepTrace({ stepId: "retry", block: "http.request", status: "failed", error: "stale attempt" })],
    });
    expect(renderers.modelFacing(run).failures.map((failure) => failure.stepId)).toEqual(["retry", "$workflow"]);
  });

  it("markdown: includes the run id, status, and every step", () => {
    const run = fakeRunRecord();
    const md = renderers.markdown(run);
    expect(md).toContain(run.runId);
    expect(md).toContain("completed");
    expect(md).toContain("step-1");
  });

  it("json: round-trips the run record as parseable JSON", () => {
    const run = fakeRunRecord();
    const parsed = JSON.parse(renderers.json(run));
    expect(parsed.runId).toBe(run.runId);
    expect(parsed.workflowId).toBe(run.workflowId);
  });

  it("cliText: leads with a bracketed headline and the workflow id", () => {
    const text = renderers.cliText(fakeRunRecord({ status: "completed" }));
    expect(text).toMatch(/^\[PASSED\]/);
    expect(text).toContain('outputs: {"result":"ok"}');
  });

  it("html: embeds the run id and a row per step", () => {
    const html = renderers.html(fakeRunRecord());
    expect(html).toContain('data-run-id="run-0001"');
    expect(html).toContain("<table>");
  });

  it("prComment: includes a status badge and the workflow identity", () => {
    const comment = renderers.prComment(fakeRunRecord({ status: "completed" }));
    expect(comment).toContain("wf-example@1.0.0");
    expect(comment).toContain("✅");
    expect(comment).toContain("**Outputs**");
  });
});
