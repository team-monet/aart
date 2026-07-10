import { describe, expect, it } from "vitest";
import { createReferenceValidator } from "./validate.js";

function validWorkflow(uses: string) {
  return {
    id: "wf1",
    name: "Test",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [{ id: "s1", uses }] },
    approval: "draft",
    gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
  };
}

describe("createReferenceValidator (NOT the real aart_validate — see SEAMS.md)", () => {
  it("accepts a workflow that parses against WorkflowSchema and only references known blocks", async () => {
    const validate = createReferenceValidator(["browser.goto"]);
    const result = await validate(validWorkflow("browser.goto"));
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects a workflow referencing a block not in knownBlocks", async () => {
    const validate = createReferenceValidator(["browser.goto"]);
    const result = await validate(validWorkflow("browser.click"));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('unknown block "browser.click"');
  });

  it("rejects a payload that does not even parse as a Workflow (spec §18.1 schema-validation class)", async () => {
    const validate = createReferenceValidator(["browser.goto"]);
    const result = await validate({ not: "a workflow" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects `undefined` (the model returned no parseable workflow at all)", async () => {
    const validate = createReferenceValidator([]);
    const result = await validate(undefined);
    expect(result.valid).toBe(false);
  });
});
