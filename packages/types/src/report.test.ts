import { describe, expect, it, vi } from "vitest";
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

  it("does not stringify or parse a complete large output while compacting it", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const parse = vi.spyOn(JSON, "parse");
    try {
      const compacted = compactModelFacingOutputs("run-large", {
        document: `${"x".repeat(200_000)}-UNBOUNDED-TAIL`,
      });

      expect(compacted).toMatchObject({ $aart: { kind: "truncated-workflow-outputs" } });
      const stringArguments = stringify.mock.calls
        .map(([value]) => value)
        .filter((value): value is string => typeof value === "string");
      expect(Math.max(...stringArguments.map((value) => value.length))).toBeLessThanOrEqual(256);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
      parse.mockRestore();
    }
  });
});
