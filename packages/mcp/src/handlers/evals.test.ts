import type { EvalSuite } from "@aart/types";
import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, sampleWorkflowYaml } from "../test-utils.js";
import { registerWorkflowHandler } from "./authoring.js";
import { createEvalFromCorrectionHandler, runEvalHandler } from "./evals.js";
import { recordCorrectionHandler } from "./governance.js";

let tc: TestContext;
afterEach(async () => {
  await tc?.cleanup();
});

const emptySuite: EvalSuite = { id: "suite-1", name: "Suite 1", examples: [], scorer: { id: "s", kind: "exact_match" }, tags: [] };

describe("createEvalFromCorrectionHandler (aart_create_eval_from_correction)", () => {
  it("fails when the target suite doesn't exist", async () => {
    tc = await createTestContext();
    const result = await createEvalFromCorrectionHandler(tc.ctx, { runId: "run_1", stepId: "s1", suiteId: "no-such-suite" });
    expect(result.ok).toBe(false);
  });

  it("fails when no correction exists for the given run/step", async () => {
    tc = await createTestContext();
    await tc.ctx.store.evals.putSuite(emptySuite);
    const result = await createEvalFromCorrectionHandler(tc.ctx, { runId: "run_1", stepId: "s1", suiteId: "suite-1" });
    expect(result.ok).toBe(false);
  });

  it("creates an eval example from a recorded correction", async () => {
    tc = await createTestContext();
    await tc.ctx.store.evals.putSuite(emptySuite);
    await recordCorrectionHandler(tc.ctx, {
      runId: "run_1",
      stepId: "extract",
      fieldPath: "outputs.nmi",
      observed: "A",
      corrected: "B",
      reason: "typo",
      reviewer: "alice",
    });
    const result = await createEvalFromCorrectionHandler(tc.ctx, { runId: "run_1", stepId: "extract", suiteId: "suite-1" });
    expect(result.ok).toBe(true);
    const example = result.example as { expected: unknown; suiteId: string };
    expect(example.expected).toBe("B");
    expect(example.suiteId).toBe("suite-1");
    const stored = await tc.ctx.store.evals.listExamples("suite-1");
    expect(stored).toHaveLength(1);
  });
});

describe("runEvalHandler (aart_run_eval)", () => {
  it("fails when the suite doesn't exist", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-eval-1") });
    const result = await runEvalHandler(tc.ctx, { suiteId: "no-such-suite", workflowId: "wf-eval-1" });
    expect(result.ok).toBe(false);
  });

  it("fails when the workflow doesn't exist", async () => {
    tc = await createTestContext();
    await tc.ctx.store.evals.putSuite(emptySuite);
    const result = await runEvalHandler(tc.ctx, { suiteId: "suite-1", workflowId: "no-such-workflow" });
    expect(result.ok).toBe(false);
  });

  it("runs an empty suite as a trivially-passing (0/0) eval run", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-eval-2") });
    await tc.ctx.store.evals.putSuite(emptySuite);
    const result = await runEvalHandler(tc.ctx, { suiteId: "suite-1", workflowId: "wf-eval-2" });
    expect(result.ok).toBe(true);
    const evalRun = result.evalRun as { total: number; passed: number; failed: number };
    expect(evalRun.total).toBe(0);
    expect(evalRun.failed).toBe(0);
  });

  it("scores a real example using listExamples (not the suite's own possibly-stale embedded examples)", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-eval-3") });
    await tc.ctx.store.evals.putSuite(emptySuite);
    // Every step in sampleWorkflowYaml completes with empty outputs under
    // StubEngine — expected: {} is therefore an exact_match pass.
    await tc.ctx.store.evals.putExample({ id: "ex1", suiteId: "suite-1", input: { url: "https://example.com" }, expected: {} });
    const result = await runEvalHandler(tc.ctx, { suiteId: "suite-1", workflowId: "wf-eval-3" });
    expect(result.ok).toBe(true);
    const evalRun = result.evalRun as { total: number; passed: number };
    expect(evalRun.total).toBe(1);
    expect(evalRun.passed).toBe(1);
  });

  it("records regressions for examples that don't match", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-eval-4") });
    await tc.ctx.store.evals.putSuite(emptySuite);
    await tc.ctx.store.evals.putExample({ id: "ex1", suiteId: "suite-1", input: { url: "https://example.com" }, expected: { impossible: true } });
    const result = await runEvalHandler(tc.ctx, { suiteId: "suite-1", workflowId: "wf-eval-4" });
    expect(result.ok).toBe(false);
    const evalRun = result.evalRun as { failed: number; regressions: string[] };
    expect(evalRun.failed).toBe(1);
    expect(evalRun.regressions).toEqual(["ex1"]);
  });
});
