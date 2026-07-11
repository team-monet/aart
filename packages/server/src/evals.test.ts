// createEvalSuite / runEvalSuiteForWorkflow — the "Create suite" / "Run
// eval" write actions the dashboard's Evals page posts (AMENDMENTS.md A47:
// moved here from a dashboard-local implementation; `runEvalSuiteForWorkflow`
// now uses @aart/evidence's REAL 12-kind scorer registry, not a 1-kind
// local stub).
import type { Workflow } from "@aart/types";
import { describe, expect, it } from "vitest";
import { createEvalSuite, runEvalSuiteForWorkflow } from "./evals.js";
import { createTestFixture, type TestFixture } from "./test-helpers.js";

function fixtureWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf_eval",
    name: "n",
    version: "1.0.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [] },
    approval: "draft",
    gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    ...overrides,
  };
}

async function withFixture(fn: (fx: TestFixture) => Promise<void>): Promise<void> {
  const fx = await createTestFixture();
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

describe("createEvalSuite", () => {
  it("persists a suite and returns it with a generated id", async () => {
    await withFixture(async (fx) => {
      const suite = await createEvalSuite(fx.store, { name: "My Suite", scorer: { id: "s1", kind: "exact_match" } });

      expect(suite.name).toBe("My Suite");
      expect(suite.id).toMatch(/^evalsuite_/);
      expect(await fx.store.evals.getSuite(suite.id)).toEqual(suite);
    });
  });

  it("also persists each inline example into the separate listExamples collection, keyed by the example's OWN suiteId field", async () => {
    await withFixture(async (fx) => {
      // Exercises the exact mechanism (a `for (const example of
      // suite.examples) await store.evals.putExample(example)` loop) in
      // isolation from the generated SUITE id: each example already
      // carries its own `suiteId` field (EvalExample's frozen shape), and
      // this function persists it verbatim rather than validating or
      // rewriting it — so `listExamples` keyed on that SAME field is the
      // decisive check, independent of what id the suite itself got.
      const example = { id: "ex1", suiteId: "suite-caller-supplied", input: 1, expected: 1 };
      await createEvalSuite(fx.store, { name: "My Suite", scorer: { id: "s1", kind: "exact_match" }, examples: [example] });

      expect(await fx.store.evals.listExamples("suite-caller-supplied")).toEqual([example]);
    });
  });
});

describe("runEvalSuiteForWorkflow", () => {
  it("scores every example with @aart/evidence's real registry (exact_match), persists the EvalRun, and returns the aggregate", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      const suite = await createEvalSuite(fx.store, {
        name: "Suite",
        scorer: { id: "s1", kind: "exact_match" },
        examples: [
          { id: "ex1", suiteId: "placeholder", input: 5, expected: 5 },
          { id: "ex2", suiteId: "placeholder", input: 1, expected: 2 },
        ],
      });

      const result = await runEvalSuiteForWorkflow(fx.store, suite.id, "wf_eval", "1.0.0");

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.evalRun.total).toBe(2);
      expect(result.evalRun.passed).toBe(1); // echo-execute: ex1's input===expected, ex2's doesn't
      expect(result.evalRun.failed).toBe(1);
      expect(result.evalRun.workflowId).toBe("wf_eval");
      expect(result.evalRun.workflowVersion).toBe("1.0.0");

      expect(await fx.store.evals.listRuns({ suiteId: suite.id })).toEqual([result.evalRun]);
    });
  });

  it("resolves the workflow's LATEST version when workflowVersion is omitted", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ version: "1.0.0" }));
      await fx.store.workflows.put(fixtureWorkflow({ version: "2.0.0" }));
      const suite = await createEvalSuite(fx.store, { name: "Suite", scorer: { id: "s1", kind: "exact_match" } });

      const result = await runEvalSuiteForWorkflow(fx.store, suite.id, "wf_eval");

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.evalRun.workflowVersion).toBe("2.0.0");
    });
  });

  // AMENDMENTS.md A47: the pre-A47 dashboard-local mirror never checked
  // workflow existence at all — this closes that gap, matching
  // packages/mcp/src/handlers/evals.ts's real runEvalHandler.
  it("workflow_not_found when the target workflow version doesn't exist", async () => {
    await withFixture(async (fx) => {
      const suite = await createEvalSuite(fx.store, { name: "Suite", scorer: { id: "s1", kind: "exact_match" } });
      const result = await runEvalSuiteForWorkflow(fx.store, suite.id, "no-such-workflow", "1.0.0");
      expect(result.kind).toBe("workflow_not_found");
    });
  });

  it("suite_not_found for an unknown suite id", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      const result = await runEvalSuiteForWorkflow(fx.store, "no-such-suite", "wf_eval", "1.0.0");
      expect(result.kind).toBe("suite_not_found");
    });
  });

  // AMENDMENTS.md A47: matches packages/mcp/src/handlers/evals.ts's own
  // documented store-shape note — the separately-queryable
  // store.evals.listExamples collection is authoritative when non-empty,
  // NOT the suite's own embedded `examples` array, closing a gap the
  // pre-A47 dashboard-local mirror had (it unconditionally read only the
  // embedded array). Constructs the divergence directly via
  // `store.evals.putSuite` (bypassing `createEvalSuite`'s own
  // examples-sync loop, which would otherwise keep the two in sync) so the
  // two sources genuinely disagree, proving which one wins.
  it("prefers store.evals.listExamples over the suite's own (here, deliberately stale) embedded examples", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow());
      const suite = { id: "suite-stale", name: "Suite", scorer: { id: "s1", kind: "exact_match" }, examples: [{ id: "stale-embedded", suiteId: "suite-stale", input: "stale", expected: "stale" }], tags: [] };
      await fx.store.evals.putSuite(suite);
      await fx.store.evals.putExample({ id: "grown", suiteId: suite.id, input: 9, expected: 9 });

      const result = await runEvalSuiteForWorkflow(fx.store, suite.id, "wf_eval", "1.0.0");

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.results.map((r) => r.exampleId)).toEqual(["grown"]); // NOT "stale-embedded"
    });
  });
});
