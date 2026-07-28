import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowRegexSafety,
  ExampleSchema,
  FieldSchema,
  WorkflowSchema,
  WorkflowStepSchema,
} from "./workflow.js";

describe("FieldSchema", () => {
  it("round-trips a Field", () => {
    const input = { name: "url", type: "string", required: true };
    expect(FieldSchema.parse(input)).toEqual(input);
  });

  it("round-trips a Field with enum/pattern/default", () => {
    const input = {
      name: "repo",
      type: "string",
      pattern: "^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$",
      default: "team-monet/aart",
      enum: ["team-monet/aart", "team-monet/other"],
      description: "GitHub repo",
    };
    expect(FieldSchema.parse(input)).toEqual(input);
  });

  it("preserves custom field types for backward-compatible Pack-defined semantics", () => {
    const result = FieldSchema.safeParse({ name: "publishedAt", type: "date" });
    expect(result.success).toBe(true);
  });
});

describe("analyzeWorkflowRegexSafety", () => {
  it("accepts ordinary anchored validation patterns", () => {
    expect(analyzeWorkflowRegexSafety("^\\d{4}-\\d{2}-\\d{2}$")).toEqual({ safe: true });
    expect(analyzeWorkflowRegexSafety("^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$")).toEqual({ safe: true });
  });

  it("rejects nested quantifiers, repeated alternation, and backreferences", () => {
    expect(analyzeWorkflowRegexSafety("^(a+)+$")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("^(a|aa)+$")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("^(a+)\\1$")).toMatchObject({ safe: false });
  });

  it("rejects overlapping sequential quantifiers at the top level", () => {
    expect(analyzeWorkflowRegexSafety("a*a*a*a*a*a*a*a*a*b")).toMatchObject({
      safe: false,
      reason: expect.stringMatching(/overlapping sequential quantifiers/i),
    });
    expect(analyzeWorkflowRegexSafety("[ab]*[bc]*tail")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("(a)*(a)*tail")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("a*b*c*tail")).toEqual({ safe: true });
  });

  it("preserves overlap detection across zero-width assertions", () => {
    expect(analyzeWorkflowRegexSafety("^a+(?=a+)a+b$")).toMatchObject({
      safe: false,
      reason: expect.stringMatching(/overlapping sequential quantifiers/i),
    });
    expect(analyzeWorkflowRegexSafety("^a+(?!b+)a+b$")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("^a+(?<=a+)a+b$")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("^a+(?<!b+)a+b$")).toMatchObject({ safe: false });
  });

  it("preserves overlap detection across empty capturing and noncapturing groups", () => {
    expect(analyzeWorkflowRegexSafety("^a*()a*$")).toMatchObject({
      safe: false,
      reason: expect.stringMatching(/overlapping sequential quantifiers/i),
    });
    expect(analyzeWorkflowRegexSafety("^a*(?:)a*$")).toMatchObject({ safe: false });
  });

  it("preserves overlap detection across zero-width word-boundary escapes", () => {
    expect(analyzeWorkflowRegexSafety("^a+\\ba+$")).toMatchObject({
      safe: false,
      reason: expect.stringMatching(/overlapping sequential quantifiers/i),
    });
    expect(analyzeWorkflowRegexSafety("^a+\\Ba+$")).toMatchObject({ safe: false });
  });

  it("preserves overlap detection through grouped zero-width fragments", () => {
    expect(analyzeWorkflowRegexSafety("^a+(\\B)a+$")).toMatchObject({
      safe: false,
      reason: expect.stringMatching(/overlapping sequential quantifiers/i),
    });
    expect(analyzeWorkflowRegexSafety("^a+(?:(\\b|^))a+$")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("^a+(?<boundary>\\B)a+$")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("^a+(\\B)*a+$")).toMatchObject({ safe: false });
  });

  it("preserves earlier overlap candidates across optional consuming atoms", () => {
    expect(analyzeWorkflowRegexSafety("^a+b?a+$")).toMatchObject({
      safe: false,
      reason: expect.stringMatching(/overlapping sequential quantifiers/i),
    });
    expect(analyzeWorkflowRegexSafety("^a+b*a+$")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("^a+b{0,3}a+$")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("^a+b+a+$")).toEqual({ safe: true });
  });

  it("rejects chains of adjacent ambiguous alternation groups", () => {
    expect(analyzeWorkflowRegexSafety(`^${"(a|aa)".repeat(8)}b$`)).toMatchObject({
      safe: false,
      reason: expect.stringMatching(/adjacent ambiguous alternation groups/i),
    });
    expect(analyzeWorkflowRegexSafety("^((a|aa)(a|aa))b$")).toMatchObject({ safe: false });
    expect(analyzeWorkflowRegexSafety("^(foo|bar)(x|y)$")).toEqual({ safe: true });
    expect(analyzeWorkflowRegexSafety("^(a|aa)-(a|aa)$")).toEqual({ safe: true });
  });
});

describe("ExampleSchema", () => {
  it("round-trips an Example", () => {
    const input = { description: "basic case", inputs: { url: "http://localhost:3000" } };
    expect(ExampleSchema.parse(input)).toEqual(input);
  });
});

describe("WorkflowStepSchema", () => {
  it("round-trips a minimal step (uses/with only)", () => {
    const input = { id: "open", uses: "browser.goto", with: { url: "{{ inputs.url }}" } };
    expect(WorkflowStepSchema.parse(input)).toEqual(input);
  });

  it("round-trips a step with forEach/as/maxIterations/until/retry/timeout/idempotencyKey", () => {
    const input = {
      id: "renew",
      uses: "flow.branch",
      forEach: "{{ steps.list.outputs.items }}",
      as: "item",
      maxIterations: 10,
      until: "{{ steps.check.outputs.done }}",
      retry: { maxAttempts: 3, backoff: "exponential", retryOn: ["timeout"] },
      timeout: "PT30S",
      idempotencyKey: "{{ run.id }}:renew",
    };
    expect(WorkflowStepSchema.parse(input)).toEqual(input);
  });

  it("round-trips if/then/else/next", () => {
    const input = { id: "check", uses: "assert.contains", if: "{{ steps.a.outputs.ok }}", then: "b", else: "c", next: "d" };
    expect(WorkflowStepSchema.parse(input)).toEqual(input);
  });
});

describe("WorkflowSchema", () => {
  const baseWorkflow = {
    id: "checkout-smoke",
    name: "Checkout Smoke Test",
    version: "0.1.0",
    inputs: [{ name: "url", type: "string", required: true }],
    outputs: [],
    execution: {
      type: "workflow" as const,
      steps: [{ id: "open", uses: "browser.goto", with: { url: "{{ inputs.url }}" } }],
    },
    approval: "draft" as const,
    gates: {
      validate: "pending" as const,
      readiness: "pending" as const,
      evals: "pending" as const,
      riskReview: "pending" as const,
      humanReview: "pending" as const,
    },
  };

  it("round-trips the spec §14.2 checkout-smoke workflow (canonical form)", () => {
    expect(WorkflowSchema.parse(baseWorkflow)).toEqual(baseWorkflow);
  });

  it("accepts architecture-introduced needsReview/promotionBlocked (§5.3, §23.4 correction outcomes)", () => {
    const parsed = WorkflowSchema.parse({ ...baseWorkflow, needsReview: true, promotionBlocked: false });
    expect(parsed.needsReview).toBe(true);
    expect(parsed.promotionBlocked).toBe(false);
  });

  it("defaults needsReview/promotionBlocked to undefined (not present) when omitted", () => {
    const parsed = WorkflowSchema.parse(baseWorkflow);
    expect(parsed.needsReview).toBeUndefined();
    expect(parsed.promotionBlocked).toBeUndefined();
  });

  it("rejects an approval value outside the 3-state model", () => {
    const result = WorkflowSchema.safeParse({ ...baseWorkflow, approval: "published" });
    expect(result.success).toBe(false);
  });

  it("accepts architecture-introduced concurrency (spec §30.1, AMENDMENTS.md A16)", () => {
    const parsed = WorkflowSchema.parse({ ...baseWorkflow, concurrency: { key: "{{ inputs.caseId }}", policy: "queue" } });
    expect(parsed.concurrency).toEqual({ key: "{{ inputs.caseId }}", policy: "queue" });
  });

  it("defaults concurrency to undefined (not present) when omitted", () => {
    const parsed = WorkflowSchema.parse(baseWorkflow);
    expect(parsed.concurrency).toBeUndefined();
  });

  it("rejects a concurrency.policy value outside the 4-value ConcurrencyPolicy enum", () => {
    const result = WorkflowSchema.safeParse({ ...baseWorkflow, concurrency: { key: "{{ inputs.caseId }}", policy: "retry_later" } });
    expect(result.success).toBe(false);
  });
});
