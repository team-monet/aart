import { describe, expect, it } from "vitest";
import { validateSchema } from "./schema.js";

const validWorkflow = {
  id: "wf",
  name: "n",
  version: "1.0.0",
  inputs: [],
  outputs: [],
  execution: { type: "workflow", steps: [] },
  approval: "draft",
  gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
};

describe("validateSchema — class 1 (spec §18.1)", () => {
  it("returns no findings for a valid workflow", () => {
    expect(validateSchema(validWorkflow)).toEqual([]);
  });

  it("flags a missing required field", () => {
    const { id, ...withoutId } = validWorkflow;
    void id;
    const findings = validateSchema(withoutId);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.class === "schema" && f.severity === "error")).toBe(true);
  });

  it("flags a wrong-typed field", () => {
    const findings = validateSchema({ ...validWorkflow, version: 123 });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags an unsupported execution.type", () => {
    const findings = validateSchema({ ...validWorkflow, execution: { type: "not-a-real-type", steps: [] } });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("flags an invalid step shape", () => {
    const findings = validateSchema({ ...validWorkflow, execution: { type: "workflow", steps: [{ uses: "x" }] } });
    // missing required `id` on the step
    expect(findings.some((f) => f.path.includes("execution"))).toBe(true);
  });

  it("includes a usable path pointing at the offending field", () => {
    const findings = validateSchema({ ...validWorkflow, version: 123 });
    expect(findings[0]?.path).toBe("version");
  });
});
