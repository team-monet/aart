import type { RunRecord } from "@aart/types";
import { describe, expect, it } from "vitest";
import { buildModelFacingReport } from "./evidence.js";

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
});
