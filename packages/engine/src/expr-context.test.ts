import { describe, expect, it } from "vitest";
import { buildExprContext, resolveArrayExpression, resolveBooleanExpression, resolveStringExpression, resolveWithRecord } from "./expr-context.js";
import { fixtureRun } from "./test-utils/fixtures.js";

describe("buildExprContext", () => {
  it("exposes inputs/trigger/run from the RunRecord", () => {
    const run = fixtureRun({ inputs: { url: "http://x" }, runId: "run1", workflowId: "wf1", workflowVersion: "2.0.0" });
    const ctx = buildExprContext(run);
    expect(ctx.inputs).toEqual({ url: "http://x" });
    expect(ctx.trigger).toEqual(run.trigger);
    expect(ctx.run).toEqual({ id: "run1", workflowId: "wf1", version: "2.0.0" });
  });

  it("exposes completed steps' outputs keyed by stepId", () => {
    const run = fixtureRun({
      trace: [{ seq: 0, stepId: "extract", block: "llm.extract", status: "completed", inputs: {}, outputs: { nmi: "123" }, startedAt: "t", endedAt: "t" }],
    });
    const ctx = buildExprContext(run);
    const steps = ctx.steps as Record<string, { outputs: unknown }>;
    expect(steps.extract?.outputs).toEqual({ nmi: "123" });
  });

  it("does not let a forEach child occurrence impersonate an authored bracket-suffixed step", () => {
    const run = fixtureRun({
      trace: [
        {
          seq: 0,
          stepId: "map[0]",
          authoredStepId: "map",
          iterationIndex: 0,
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { value: "child" },
          startedAt: "t",
          endedAt: "t",
        },
        {
          seq: 1,
          stepId: "map",
          authoredStepId: "map",
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { items: [{ value: "child" }] },
          startedAt: "t",
          endedAt: "t",
        },
      ],
    });

    const steps = buildExprContext(run).steps as Record<
      string,
      { outputs: unknown }
    >;

    expect(steps["map[0]"]).toBeUndefined();
    expect(steps.map?.outputs).toEqual({
      items: [{ value: "child" }],
    });
  });
});

describe("resolveWithRecord", () => {
  it("resolves every value in a with: record", async () => {
    const ctx = { inputs: { url: "http://x", count: 3 } };
    const resolved = await resolveWithRecord({ url: "{{ inputs.url }}", label: "Count: {{ inputs.count }}", literal: "plain" }, ctx, {});
    expect(resolved).toEqual({ url: "http://x", label: "Count: 3", literal: "plain" });
  });

  it("returns {} for an undefined with: record", async () => {
    expect(await resolveWithRecord(undefined, { inputs: {} }, {})).toEqual({});
  });
});

describe("resolveBooleanExpression", () => {
  it("resolves a typed-passthrough boolean true", async () => {
    const ctx = { steps: { check: { outputs: { ok: true } } } };
    expect(await resolveBooleanExpression("{{ steps.check.outputs.ok }}", ctx, {})).toBe(true);
  });

  it("truthy-coerces a non-boolean resolved value", async () => {
    const ctx = { steps: { list: { outputs: { count: 3 } } } };
    expect(await resolveBooleanExpression("{{ steps.list.outputs.count }}", ctx, {})).toBe(true);
    const ctxZero = { steps: { list: { outputs: { count: 0 } } } };
    expect(await resolveBooleanExpression("{{ steps.list.outputs.count }}", ctxZero, {})).toBe(false);
  });
});

describe("resolveArrayExpression", () => {
  it("resolves an array-yielding expression", async () => {
    const ctx = { steps: { list: { outputs: { items: [1, 2, 3] } } } };
    expect(await resolveArrayExpression("{{ steps.list.outputs.items }}", ctx, {})).toEqual([1, 2, 3]);
  });

  it("throws a plain Error when the resolved value is not an array", async () => {
    const ctx = { steps: { list: { outputs: { items: "not-an-array" } } } };
    await expect(resolveArrayExpression("{{ steps.list.outputs.items }}", ctx, {})).rejects.toThrow(/non-array/i);
  });
});

describe("resolveStringExpression", () => {
  it("returns undefined for undefined input", async () => {
    expect(await resolveStringExpression(undefined, {}, {})).toBeUndefined();
  });

  it("resolves and passes through an already-string value", async () => {
    const ctx = { inputs: { caseId: "abc" } };
    expect(await resolveStringExpression("{{ inputs.caseId }}", ctx, {})).toBe("abc");
  });

  it("coerces a non-string resolved value to a string", async () => {
    const ctx = { inputs: { caseId: 42 } };
    expect(await resolveStringExpression("{{ inputs.caseId }}", ctx, {})).toBe("42");
  });
});
