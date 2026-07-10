import { describe, expect, it } from "vitest";
import { ExampleSchema, FieldSchema, WorkflowSchema, WorkflowStepSchema } from "./workflow.js";

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
