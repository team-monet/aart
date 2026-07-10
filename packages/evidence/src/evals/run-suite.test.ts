import type { EvalExample, EvalSuite } from "@aart/types";
import { describe, expect, it } from "vitest";
import { ConnectorFakeRegistry, runStepsWithDryRun, type EvalStepDefinition } from "./dry-run.js";
import { runEvalExample, runEvalSuite } from "./run-suite.js";
import { createScorerRegistry } from "./scorers/registry.js";

describe("runEvalExample", () => {
  it("produces `actual` via options.execute and scores it against example.expected", async () => {
    const example: EvalExample = { id: "ex1", suiteId: "s1", input: { n: 2 }, expected: 4 };
    const result = await runEvalExample(example, { kind: "exact_match" }, {
      execute: (input) => (input as { n: number }).n * 2,
      scorers: createScorerRegistry(),
    });
    expect(result).toEqual({ exampleId: "ex1", actual: 4, result: { passed: true, score: 1, deterministic: true } });
  });

  it("prefers example.scorerConfig over the suite-level scorer.config", async () => {
    const example: EvalExample = { id: "ex1", suiteId: "s1", input: {}, expected: "x", scorerConfig: { path: "$.override" } };
    const result = await runEvalExample(example, { kind: "jsonpath_exact", config: { path: "$.default" } }, {
      execute: () => ({ override: "x", default: "y" }),
      scorers: createScorerRegistry(),
    });
    expect(result.result.passed).toBe(true);
  });

  it("passes dryRun through to options.execute's context", async () => {
    let capturedDryRun: boolean | undefined;
    const example: EvalExample = { id: "ex1", suiteId: "s1", input: {}, expected: true };
    await runEvalExample(example, { kind: "exact_match" }, {
      dryRun: true,
      execute: (_input, ctx) => {
        capturedDryRun = ctx.dryRun;
        return true;
      },
      scorers: createScorerRegistry(),
    });
    expect(capturedDryRun).toBe(true);
  });
});

describe("runEvalSuite — aggregation (spec §24.4)", () => {
  function suiteOf(examples: EvalExample[]): EvalSuite {
    return { id: "suite1", name: "Suite", examples, scorer: { id: "sc1", kind: "exact_match" }, tags: [] };
  }

  it("aggregates total/passed/failed correctly", async () => {
    const examples: EvalExample[] = [
      { id: "ex1", suiteId: "suite1", input: 1, expected: 1 },
      { id: "ex2", suiteId: "suite1", input: 2, expected: 999 },
      { id: "ex3", suiteId: "suite1", input: 3, expected: 3 },
    ];
    const { evalRun } = await runEvalSuite(suiteOf(examples), {
      workflowId: "wf1",
      workflowVersion: "0.1.0",
      reportArtifact: "art1",
      execute: (input) => input,
      scorers: createScorerRegistry(),
    });
    expect(evalRun.total).toBe(3);
    expect(evalRun.passed).toBe(2);
    expect(evalRun.failed).toBe(1);
  });

  it("score is the AVERAGE of each example's own graded score, not just the pass rate", async () => {
    const examples: EvalExample[] = [
      { id: "ex1", suiteId: "suite1", input: { a: 1, b: 1 }, expected: { a: 1, b: 1 } }, // field_level_accuracy: 2/2 = 1
      { id: "ex2", suiteId: "suite1", input: { a: 1, b: 999 }, expected: { a: 1, b: 2 } }, // field_level_accuracy: 1/2 = 0.5
    ];
    const suite: EvalSuite = { id: "suite1", name: "Suite", examples, scorer: { id: "sc1", kind: "field_level_accuracy" }, tags: [] };
    const { evalRun } = await runEvalSuite(suite, {
      workflowId: "wf1",
      workflowVersion: "0.1.0",
      reportArtifact: "art1",
      execute: (input) => input,
      scorers: createScorerRegistry(),
    });
    expect(evalRun.score).toBeCloseTo(0.75); // (1 + 0.5) / 2
  });

  it("regressions is the list of FAILED example ids for this run", async () => {
    const examples: EvalExample[] = [
      { id: "ex_good", suiteId: "suite1", input: 1, expected: 1 },
      { id: "ex_bad", suiteId: "suite1", input: 1, expected: 2 },
    ];
    const { evalRun } = await runEvalSuite(suiteOf(examples), {
      workflowId: "wf1",
      workflowVersion: "0.1.0",
      reportArtifact: "art1",
      execute: (input) => input,
      scorers: createScorerRegistry(),
    });
    expect(evalRun.regressions).toEqual(["ex_bad"]);
    expect(evalRun.improvements).toEqual([]);
  });

  it("an empty suite scores 1 and reports 0/0/0", async () => {
    const { evalRun } = await runEvalSuite(suiteOf([]), {
      workflowId: "wf1",
      workflowVersion: "0.1.0",
      reportArtifact: "art1",
      execute: (input) => input,
      scorers: createScorerRegistry(),
    });
    expect(evalRun).toMatchObject({ total: 0, passed: 0, failed: 0, score: 1 });
  });

  it("carries workflowId/workflowVersion/reportArtifact through onto the EvalRun verbatim", async () => {
    const { evalRun } = await runEvalSuite(suiteOf([]), {
      workflowId: "wf_carry",
      workflowVersion: "9.9.9",
      reportArtifact: "art_carry",
      execute: (input) => input,
      scorers: createScorerRegistry(),
    });
    expect(evalRun).toMatchObject({ workflowId: "wf_carry", workflowVersion: "9.9.9", reportArtifact: "art_carry", suiteId: "suite1" });
  });

  it("integrates with runStepsWithDryRun + ConnectorFakeRegistry: an eval suite run in dry-run mode over a fixture workflow never invokes a real effectful handler", async () => {
    let realCalls = 0;
    const fakes = new ConnectorFakeRegistry();
    fakes.register({
      blockId: "email.send",
      capability: "email.send",
      real: () => {
        realCalls++;
        throw new Error("real send must not happen in dry-run");
      },
      fake: (input: { to: string }) => ({ messageId: "fake-1", to: input.to }),
    });
    const steps: EvalStepDefinition[] = [{ id: "send", block: "email.send", with: { to: "x@example.com" } }];

    const example: EvalExample = { id: "ex1", suiteId: "suite_dr", input: {}, expected: true, scorerConfig: { fn: (actual: unknown) => ({ passed: (actual as { send: { messageId: string } }).send.messageId === "fake-1", score: 1 }) } };
    const suite: EvalSuite = { id: "suite_dr", name: "dry-run suite", examples: [example], scorer: { id: "sc1", kind: "custom_node" }, tags: [] };

    const { evalRun } = await runEvalSuite(suite, {
      workflowId: "wf_dr",
      workflowVersion: "0.1.0",
      reportArtifact: "art_dr",
      dryRun: true,
      scorers: createScorerRegistry(),
      execute: async (_input, ctx) => {
        const { outputs } = await runStepsWithDryRun(steps, { dryRun: ctx.dryRun, fakes });
        return outputs;
      },
    });

    expect(realCalls).toBe(0);
    expect(evalRun.passed).toBe(1);
  });
});
