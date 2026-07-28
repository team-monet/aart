import type { Field } from "@aart/types";
import { describe, expect, it, vi } from "vitest";
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
  it("rejects a backtracking-unsafe pattern without evaluating it", () => {
    const problem = validationProblem(
      { name: "document", type: "string", pattern: "^(a+)+$" },
      `${"a".repeat(100)}!`,
    );

    expect(problem).toMatch(/unsafe pattern.*nested quantified groups/i);
  });

  it("rejects overlapping top-level quantifiers without evaluating them", () => {
    const problem = validationProblem(
      { name: "document", type: "string", pattern: "a*a*a*a*a*a*a*a*a*b" },
      `${"a".repeat(100)}!`,
    );

    expect(problem).toMatch(/unsafe pattern.*overlapping sequential quantifiers/i);
  });

  it("rejects overlapping quantifiers separated by a zero-width assertion", () => {
    const problem = validationProblem(
      { name: "document", type: "string", pattern: "^a+(?=a+)a+b$" },
      `${"a".repeat(1_000)}!`,
    );

    expect(problem).toMatch(/unsafe pattern.*overlapping sequential quantifiers/i);
  });

  it("rejects overlapping quantifiers separated by an empty group without evaluating them", () => {
    const problem = validationProblem(
      { name: "document", type: "string", pattern: "^a*(?:)a*$" },
      `${"a".repeat(1_000)}!`,
    );

    expect(problem).toMatch(/unsafe pattern.*overlapping sequential quantifiers/i);
  });

  it("rejects overlapping quantifiers separated by a zero-width escape without evaluating them", () => {
    const problem = validationProblem(
      { name: "document", type: "string", pattern: "^a+\\Ba+$" },
      `${"a".repeat(1_000)}!`,
    );

    expect(problem).toMatch(/unsafe pattern.*overlapping sequential quantifiers/i);
  });

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

  it("serializes large nested diagnostic values only in bounded string chunks", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const problem = validationProblem(
        { name: "document", type: "json", enum: [{ accepted: true }] },
        { document: `${"x".repeat(200_000)}-UNBOUNDED-TAIL` },
      );

      expect(problem.length).toBeLessThan(1_500);
      const stringArguments = stringify.mock.calls
        .map(([value]) => value)
        .filter((value): value is string => typeof value === "string");
      expect(Math.max(...stringArguments.map((value) => value.length))).toBeLessThanOrEqual(256);
    } finally {
      stringify.mockRestore();
    }
  });

  it.each([
    ["Date", new Date("2026-07-28T00:00:00.000Z")],
    ["Map", new Map([["answer", 42]])],
    ["class instance", new (class Result { answer = 42; })()],
    ["nested non-JSON value", { items: [new Date("2026-07-28T00:00:00.000Z")] }],
  ])("rejects %s outputs whose persisted JSON value would differ", (_label, value) => {
    const problem = validationProblem({ name: "result", type: "json" }, value);

    expect(problem).toMatch(/plain JSON objects/);
  });
});
