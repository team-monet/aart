import { describe, expect, it } from "vitest";
import { createReferenceRunSuccessChecker } from "./run-success.js";

function workflowWithSteps(stepCount: number) {
  return {
    id: "wf1",
    name: "Test",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: Array.from({ length: stepCount }, (_, i) => ({ id: `s${i}`, uses: "browser.goto" })) },
    approval: "draft",
    gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
  };
}

describe("createReferenceRunSuccessChecker (NOT a real @aart/engine execution — see SEAMS.md)", () => {
  it("succeeds for a workflow with at least one step", async () => {
    const result = await createReferenceRunSuccessChecker()(workflowWithSteps(1));
    expect(result).toEqual({ succeeded: true });
  });

  it("fails for a workflow with zero steps — an empty workflow can't meaningfully run", async () => {
    const result = await createReferenceRunSuccessChecker()(workflowWithSteps(0));
    expect(result.succeeded).toBe(false);
    expect(result.error).toContain("no steps");
  });

  it("fails for a payload that doesn't parse as a Workflow at all", async () => {
    const result = await createReferenceRunSuccessChecker()({ not: "a workflow" });
    expect(result.succeeded).toBe(false);
  });
});
