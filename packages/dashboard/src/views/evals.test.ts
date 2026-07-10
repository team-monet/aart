import { describe, expect, it } from "vitest";
import type { CreateEvalSuiteFn, RunEvalSuiteFn } from "../deps.js";
import { createTestFixture, makeEvalSuite } from "../test-support/fixtures.js";
import { createEvalAction, renderCreateEvalFormPage, renderEvalDashboardPage, runEvalAction } from "./evals.js";

describe("renderEvalDashboardPage / renderCreateEvalFormPage", () => {
  it("renders suites and runs", () => {
    const html = renderEvalDashboardPage([makeEvalSuite({ id: "suite-1", name: "My Suite" })], [{ id: "run-1", suiteId: "suite-1", workflowId: "wf-1", workflowVersion: "1.0.0", status: "completed", total: 2, passed: 2, failed: 0, score: 1, regressions: [], improvements: [], reportArtifact: "a1" }]);
    expect(html).toContain("My Suite");
    expect(html).toContain("2/2");
  });

  it("renders a create-suite form", () => {
    expect(renderCreateEvalFormPage()).toContain('action="/evals/suites"');
  });
});

describe("createEvalAction — same-function-reference proof", () => {
  it("delegates to the injected createEvalSuite", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const calls: unknown[] = [];
      const fakeSuite = makeEvalSuite({ id: "suite-x" });
      const spy: CreateEvalSuiteFn = async (_s, input) => {
        calls.push(input);
        return fakeSuite;
      };

      const result = await createEvalAction({ ...deps, createEvalSuite: spy }, store, { name: "My Suite", scorer: { id: "s1", kind: "exact_match" } });

      expect(calls).toEqual([{ name: "My Suite", scorer: { id: "s1", kind: "exact_match" } }]);
      expect(result).toBe(fakeSuite);
    } finally {
      await cleanup();
    }
  });
});

describe("runEvalAction — same-function-reference proof + persistence", () => {
  it("loads the suite, delegates scoring to the injected runEvalSuite, and persists the resulting EvalRun", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const suite = makeEvalSuite({ id: "suite-run" }, [{ id: "ex1", suiteId: "suite-run", input: 1, expected: 1 }]);
      await store.evals.putSuite(suite);

      const calls: unknown[] = [];
      const fakeEvalRun = { id: "evalrun-1", suiteId: "suite-run", workflowId: "wf-1", workflowVersion: "1.0.0", status: "completed" as const, total: 1, passed: 1, failed: 0, score: 1, regressions: [], improvements: [], reportArtifact: "art-1" };
      const spy: RunEvalSuiteFn = async (s, options) => {
        calls.push({ suiteId: s.id, workflowId: options.workflowId, workflowVersion: options.workflowVersion });
        return { evalRun: fakeEvalRun, results: [] };
      };

      const result = await runEvalAction({ ...deps, runEvalSuite: spy }, store, "suite-run", "wf-1", "1.0.0");

      expect(calls).toEqual([{ suiteId: "suite-run", workflowId: "wf-1", workflowVersion: "1.0.0" }]);
      expect(result.evalRun).toBe(fakeEvalRun);
      expect(await store.evals.listRuns({ suiteId: "suite-run" })).toEqual([fakeEvalRun]);
    } finally {
      await cleanup();
    }
  });

  it("throws for an unknown suite id", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await expect(runEvalAction(deps, store, "nope", "wf-1", "1.0.0")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("end-to-end with the real stub scorer registry: scores examples and aggregates", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const suite = makeEvalSuite({ id: "suite-real", scorer: { id: "s1", kind: "exact_match" } }, [{ id: "ex1", suiteId: "suite-real", input: 5, expected: 5 }]);
      await store.evals.putSuite(suite);

      const result = await runEvalAction(deps, store, "suite-real", "wf-1", "1.0.0");

      expect(result.evalRun.passed).toBe(1);
      expect(result.evalRun.score).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
