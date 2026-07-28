import { describe, expect, it } from "vitest";
import { buildReportModel } from "./report-model.js";
import { fixtureRunRecord } from "./test-support/fixtures.js";

describe("buildReportModel", () => {
  it("captures headline/approval/trigger/identity fields from the RunRecord", () => {
    const run = fixtureRunRecord({ status: "completed", approved: true, approvalMode: "production" });
    const model = buildReportModel(run);
    expect(model.headline).toEqual({ status: "completed", label: "Passed" });
    expect(model.approval).toEqual({ approved: true, mode: "production" });
    expect(model.trigger.type).toBe("manual");
    expect(model.runId).toBe(run.runId);
    expect(model.workflowId).toBe(run.workflowId);
    expect(model.workflowVersion).toBe(run.workflowVersion);
  });

  it("maps every RunRecord.status to a distinct headline label", () => {
    const cases: Array<["pending" | "running" | "waiting" | "completed" | "failed" | "cancelled", string]> = [
      ["pending", "Pending"],
      ["running", "Running"],
      ["waiting", "Waiting"],
      ["completed", "Passed"],
      ["failed", "Failed"],
      ["cancelled", "Cancelled"],
    ];
    for (const [status, label] of cases) {
      const model = buildReportModel(fixtureRunRecord({ status }));
      expect(model.headline).toEqual({ status, label });
    }
  });

  it("collects failures only from steps with status \"failed\", defaulting a missing error message", () => {
    const run = fixtureRunRecord({
      trace: [
        { seq: 0, stepId: "a", block: "http.request", status: "completed", inputs: {}, outputs: {}, startedAt: "t" },
        { seq: 1, stepId: "b", block: "http.request", status: "failed", inputs: {}, error: "500 from upstream", startedAt: "t" },
        { seq: 2, stepId: "c", block: "http.request", status: "failed", inputs: {}, startedAt: "t" },
      ],
    });
    const model = buildReportModel(run);
    expect(model.failures).toEqual([
      { stepId: "b", block: "http.request", error: "500 from upstream" },
      { stepId: "c", block: "http.request", error: "Step failed with no recorded error message." },
    ]);
  });

  it("classifies a run-level output validation error as a workflow output failure", () => {
    const error = 'Workflow output validation failed: output "result" expected type "string" but received "object"';
    const model = buildReportModel(fixtureRunRecord({ status: "failed", error }));
    expect(model.failures).toEqual([{ stepId: "$workflow", block: "workflow.outputMapping", error }]);
  });

  it("splits screenshots out of artifacts by kind", () => {
    const run = fixtureRunRecord({
      artifacts: [
        { id: "a1", runId: "r", name: "shot.png", kind: "screenshot", mime: "image/png", path: "a1.png", bytes: 10, createdAt: "t" },
        { id: "a2", runId: "r", name: "out.json", kind: "json_output", mime: "application/json", path: "a2.json", bytes: 5, createdAt: "t" },
      ],
    });
    const model = buildReportModel(run);
    expect(model.artifacts).toHaveLength(2);
    expect(model.screenshots).toHaveLength(1);
    expect(model.screenshots[0]?.id).toBe("a1");
  });

  it("exposes only a runId pointer for eval/correction links, not embedded data (architecture §9.1 purity: RunRecord carries no eval/correction records itself)", () => {
    const run = fixtureRunRecord();
    const model = buildReportModel(run);
    expect(model.links).toEqual({ runId: run.runId });
  });

  it("field declaration order enforces the §19.4 9-element report UX ordering — failures precede fullTrace", () => {
    const model = buildReportModel(fixtureRunRecord());
    const keys = Object.keys(model);
    expect(keys.indexOf("failures")).toBeLessThan(keys.indexOf("fullTrace"));
    expect(keys.indexOf("headline")).toBeLessThan(keys.indexOf("approval"));
    expect(keys.indexOf("approval")).toBeLessThan(keys.indexOf("trigger"));
    expect(keys.indexOf("artifacts")).toBeLessThan(keys.indexOf("links"));
  });
});
