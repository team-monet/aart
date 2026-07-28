import type { Field } from "@aart/types";
import { describe, expect, it } from "vitest";
import { validateWorkflowOutputs, WorkflowOutputValidationError } from "./output-validation.js";

function validationProblem(field: Field, value: unknown): string {
  try {
    validateWorkflowOutputs({ outputs: [field] }, { [field.name]: value });
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowOutputValidationError);
    return (error as WorkflowOutputValidationError).problems[0]!;
  }
}

describe("workflow output validation diagnostics", () => {
  it("bounds a large pattern-mismatch value while reporting its total size", () => {
    const value = `${"a".repeat(200_000)}-UNBOUNDED-TAIL`;
    const problem = validationProblem({ name: "document", type: "string", pattern: "^accepted$" }, value);

    expect(problem.length).toBeLessThan(1_000);
    expect(problem).toContain("200017 characters total");
    expect(problem).not.toContain("UNBOUNDED-TAIL");
  });

  it("bounds both the rejected value and declared candidates in enum diagnostics", () => {
    const value = `${"x".repeat(200_000)}-VALUE-TAIL`;
    const candidate = `${"y".repeat(200_000)}-ENUM-TAIL`;
    const problem = validationProblem({ name: "document", type: "string", enum: [candidate] }, value);

    expect(problem.length).toBeLessThan(1_500);
    expect(problem).toContain("characters total");
    expect(problem).not.toContain("VALUE-TAIL");
    expect(problem).not.toContain("ENUM-TAIL");
  });
});
