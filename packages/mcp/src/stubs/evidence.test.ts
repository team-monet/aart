import type { RunRecord } from "@aart/types";
import { describe, expect, it } from "vitest";
import { buildMarkdownReport, buildModelFacingReport } from "./evidence.js";

function runWithOutputs(outputs: Record<string, unknown>): RunRecord {
  const now = "2026-07-28T00:00:00.000Z";
  return {
    runId: "run-stub-report",
    workflowId: "wf-stub-report",
    workflowVersion: "1.0.0",
    status: "completed",
    approved: true,
    approvalMode: "dev",
    trigger: { id: "trigger-1", type: "manual", source: "test", payload: {}, receivedAt: now },
    inputs: {},
    trace: [],
    waits: [],
    artifacts: [],
    outputs,
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: now },
    startedAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

describe("stub evidence model-facing report", () => {
  it("keeps small workflow outputs inline", () => {
    expect(buildModelFacingReport(runWithOutputs({ result: "ok" })).outputs).toEqual({ result: "ok" });
  });

  it("compacts oversized workflow outputs and points back to the run record", () => {
    const run = runWithOutputs({ document: "x".repeat(200_000) });
    const report = buildModelFacingReport(run);

    expect(JSON.stringify(report).length).toBeLessThan(8_000);
    expect(report.outputs).toMatchObject({
      $aart: {
        kind: "truncated-workflow-outputs",
        fullResultRef: { runId: run.runId, field: "outputs" },
      },
    });
  });

  it("keeps full workflow outputs in the human-facing Markdown report", () => {
    const output = "x".repeat(10_000);
    const markdown = buildMarkdownReport(runWithOutputs({ result: output }));

    expect(markdown).toContain("## Outputs");
    expect(markdown).toContain(JSON.stringify({ result: output }, null, 2));
    expect(markdown).not.toContain("truncated-workflow-outputs");
  });

  it("surfaces a workflow-level output failure when no trace step failed", () => {
    const error = 'Workflow output validation failed: output "result" expected type "string" but received "object"';
    const run: RunRecord = { ...runWithOutputs({}), status: "failed", error };

    expect(buildModelFacingReport(run).failures).toEqual([
      { stepId: "$workflow", block: "workflow.outputMapping", error },
    ]);
    expect(buildMarkdownReport(run)).toContain(error);
    expect(buildMarkdownReport(run)).toContain("workflow.outputMapping");
  });
});
