import { WorkflowSchema, WorkflowStepSchema } from "@aart/types";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { COVERED_WORKFLOW_FIELDS, COVERED_WORKFLOW_STEP_FIELDS } from "./approval-summary.js";
import { checkWorkflowFieldCompleteness, checkWorkflowStepFieldCompleteness } from "./trust-surface-completeness.js";

describe("trust-surface-completeness — the ADR-17 CI gate itself", () => {
  it("the REAL WorkflowSchema is fully covered by the approval summary renderer, right now", () => {
    const result = checkWorkflowFieldCompleteness();
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("the REAL WorkflowStepSchema is fully covered by the approval summary renderer, right now", () => {
    const result = checkWorkflowStepFieldCompleteness();
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("test-of-the-test — proves the completeness check actually catches gaps (ADR-17, this session's own DoD)", () => {
  it("FAILS when a throwaway field is added to a COPY of WorkflowStepSchema and the covered-field list doesn't know about it", () => {
    const mutatedSchema = WorkflowStepSchema.extend({ throwawayField: z.string().optional() });
    const result = checkWorkflowStepFieldCompleteness(mutatedSchema, COVERED_WORKFLOW_STEP_FIELDS);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("throwawayField");
  });

  it("PASSES once the covered-field list is updated to include the new field — proving the check isn't trivially always-green", () => {
    const mutatedSchema = WorkflowStepSchema.extend({ throwawayField: z.string().optional() });
    const updatedCoverage = [...COVERED_WORKFLOW_STEP_FIELDS, "throwawayField"];
    const result = checkWorkflowStepFieldCompleteness(mutatedSchema, updatedCoverage);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("the same test-of-the-test holds for the Workflow-level schema, not just WorkflowStep", () => {
    const mutatedSchema = WorkflowSchema.extend({ throwawayWorkflowField: z.number().optional() });
    const failing = checkWorkflowFieldCompleteness(mutatedSchema, COVERED_WORKFLOW_FIELDS);
    expect(failing.ok).toBe(false);
    expect(failing.missing).toContain("throwawayWorkflowField");

    const passing = checkWorkflowFieldCompleteness(mutatedSchema, [...COVERED_WORKFLOW_FIELDS, "throwawayWorkflowField"]);
    expect(passing.ok).toBe(true);
  });

  it("never touches the real frozen @aart/types export — WorkflowStepSchema.extend returns a NEW schema, the original is untouched", () => {
    WorkflowStepSchema.extend({ throwawayField: z.string().optional() });
    // The original schema's own shape has no such field — if .extend()
    // mutated in place, this would now unexpectedly include it.
    expect(Object.keys(WorkflowStepSchema.shape)).not.toContain("throwawayField");
  });
});
