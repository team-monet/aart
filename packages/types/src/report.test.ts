import { describe, expect, it } from "vitest";
import { compactModelFacingOutputs, ModelFacingReportSchema } from "./report.js";

describe("ModelFacingReportSchema", () => {
  it.each(["passed", "failed", "waiting"] as const)("round-trips a %s-headline report", (headline) => {
    const input = {
      headline,
      workflowId: "checkout-smoke",
      workflowVersion: "0.1.0",
      failures: headline === "failed" ? [{ stepId: "assert", block: "assert.contains", error: "mismatch" }] : [],
      outputs: { result: "ok" },
      artifactRefs: [{ id: "art_1", kind: "screenshot", uri: "artifacts/run_1/art_1.png" }],
      next: headline === "waiting" ? "resume when signal arrives" : "none",
    };
    expect(ModelFacingReportSchema.parse(input)).toEqual(input);
  });

  it("rejects a headline value outside {passed, failed, waiting}", () => {
    const result = ModelFacingReportSchema.safeParse({
      headline: "success",
      workflowId: "x",
      workflowVersion: "1",
      failures: [],
      outputs: {},
      artifactRefs: [],
      next: "none",
    });
    expect(result.success).toBe(false);
  });

  it("compacts outputs whose pretty-printed form exceeds the report budget", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 1_000; depth++) nested = [nested];

    const compacted = compactModelFacingOutputs("run-deep", { nested });

    expect(compacted).toMatchObject({
      $aart: {
        kind: "truncated-workflow-outputs",
        fullResultRef: { runId: "run-deep", field: "outputs" },
      },
    });
    expect(JSON.stringify(compacted, null, 2).length).toBeLessThan(10_000);
  });
});
