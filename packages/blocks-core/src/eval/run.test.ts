import { describe, expect, it } from "vitest";
import type { EvalSuite } from "@aart/types";
import { createEvalRunBlock, evalRunBlock } from "./run.js";
import { createFakeScorerRegistry } from "../test-support/fake-scorer-registry.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

function fakeSuite(): EvalSuite {
  return {
    id: "suite-1",
    name: "Example suite",
    examples: [
      { id: "ex-1", suiteId: "suite-1", input: {}, expected: 42 },
      { id: "ex-2", suiteId: "suite-1", input: {}, expected: "yes" },
      { id: "ex-3", suiteId: "suite-1", input: {}, expected: "no" },
    ],
    scorer: { id: "scorer-1", kind: "exact_match" },
    tags: [],
  };
}

describe("eval.run", () => {
  it("has complete, correctly-declared metadata (capabilities: file.write for the report artifact, llm defensively for the llm_judge kind)", () => {
    const block = createEvalRunBlock(createFakeScorerRegistry());
    expect(block.manifest.id).toBe("eval.run");
    expect(block.manifest.capabilities).toEqual(["file.write", "llm"]);
    expect(block.manifest.category).toBe("eval");
  });

  it("scores every example against actuals and aggregates total/passed/failed/score for a mix of passing and failing examples", async () => {
    const block = createEvalRunBlock(createFakeScorerRegistry());
    const result = (await block.execute(
      {
        suite: fakeSuite(),
        actuals: { "ex-1": 42, "ex-2": "yes", "ex-3": "WRONG" },
        workflowId: "wf-1",
        workflowVersion: "1.0.0",
      },
      fakeExecutionContext(),
    )) as { total: number; passed: number; failed: number; score: number; status: string; suiteId: string; workflowId: string };

    expect(result.total).toBe(3);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.status).toBe("completed");
    expect(result.suiteId).toBe("suite-1");
    expect(result.workflowId).toBe("wf-1");
  });

  it("defaults workflowId/workflowVersion to empty strings when not provided", async () => {
    const block = createEvalRunBlock(createFakeScorerRegistry());
    const result = (await block.execute(
      { suite: fakeSuite(), actuals: { "ex-1": 42, "ex-2": "yes", "ex-3": "no" } },
      fakeExecutionContext(),
    )) as { workflowId: string; workflowVersion: string };
    expect(result.workflowId).toBe("");
    expect(result.workflowVersion).toBe("");
  });

  it("writes the EvalRun as a report artifact via ctx.writeArtifact", async () => {
    const block = createEvalRunBlock(createFakeScorerRegistry());
    const ctx = fakeExecutionContext({ runId: "run-write-test", stepId: "step-write-test" });
    const result = (await block.execute(
      { suite: fakeSuite(), actuals: { "ex-1": 42, "ex-2": "yes", "ex-3": "no" } },
      ctx,
    )) as { reportArtifact: string; id: string };

    expect(ctx.writtenArtifacts).toHaveLength(1);
    expect(ctx.writtenArtifacts[0]).toMatchObject({
      name: "eval-run-run-write-test-step-write-test.json",
      kind: "json_output",
      mime: "application/json",
    });
    const written = JSON.parse(Buffer.from(ctx.writtenArtifacts[0]!.bytes).toString("utf8"));
    expect(written.suiteId).toBe("suite-1");
    expect(written.id).toBe(result.id);
    expect(result.reportArtifact).toMatch(/^artifact-fake-\d{4}$/);
  });

  it("always returns empty regressions/improvements (no prior-EvalRun history is reachable from a block)", async () => {
    const block = createEvalRunBlock(createFakeScorerRegistry());
    const result = (await block.execute(
      { suite: fakeSuite(), actuals: { "ex-1": 42, "ex-2": "yes", "ex-3": "no" } },
      fakeExecutionContext(),
    )) as { regressions: string[]; improvements: string[] };
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
  });

  it("the default catalog export (no injection) now resolves via the real, merged @aart/evidence registry", async () => {
    // Pre-S9-integration, @aart/evidence was S0's empty stub and this
    // threw ScorerRegistryUnavailableError (see git history / SEAMS.md
    // E2) - tryLoadEvidenceScorerRegistry()'s lazy dynamic import now
    // resolves S6's real createScorerRegistry() with no injection
    // needed for the exact_match kind this suite uses. With no actuals
    // supplied, every example scores undefined-vs-expected, so all 3 fail.
    const result = (await evalRunBlock.execute({ suite: fakeSuite(), actuals: {} }, fakeExecutionContext())) as {
      total: number;
      passed: number;
      failed: number;
      score: number;
      status: string;
      suiteId: string;
      workflowId: string;
      workflowVersion: string;
      reportArtifact: string;
    };
    expect(result.total).toBe(3);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.score).toBe(0);
    expect(result.status).toBe("completed");
    expect(result.suiteId).toBe("suite-1");
    expect(result.workflowId).toBe("");
    expect(result.workflowVersion).toBe("");
    expect(result.reportArtifact).toMatch(/^artifact-fake-\d{4}$/);
  });
});
