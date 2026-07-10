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
  });
});
