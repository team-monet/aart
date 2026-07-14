// The literal spec §18.2 worked example ("A guarded cycle") as an
// end-to-end test fixture, per this session's DoD: "guarded back-edges
// with maxIterations/until (including the exact §18.2 worked example from
// the spec as a literal test fixture)."
//
// This file imports the CANONICAL form of that exact fixture directly from
// this package's own `src/fixtures/` (not a re-typed inline duplicate) and
// drives it through the full createEngine wiring across multiple
// wait/resume cycles, proving the guarded back-edge's maxIterations cap is
// enforced correctly end-to-end, not just at the step-executor unit level
// (step-executor.test.ts already covers the unit-level mechanics; this is
// the literal-fixture, full-engine-loop proof the DoD specifically calls
// for).
//
// Deliberately industry-neutral (AMENDMENTS.md A70): this fixture used to
// live in a repo-root example-workflows directory and carried a specific
// customer/domain narrative — that whole directory was removed from the
// product (2026-07-14, zero customer/domain-specific content). The fixture
// moved to this package's own `src/fixtures/review-cycle-loop.workflow.json`,
// with block/step ids
// renamed to a neutral `demo.*` namespace; the guarded-loop mechanics and
// every assertion below are unchanged.
import type { BlockImplementation, Workflow } from "@aart/types";
import { WorkflowSchema } from "@aart/types";
import { describe, expect, it, afterEach } from "vitest";
import fixtureJson from "./fixtures/review-cycle-loop.workflow.json" with { type: "json" };
import { IterationLimitExceededError } from "@aart/types";
import { alwaysAllowCapabilityCheck } from "./capability.js";
import { createEngine } from "./engine.js";
import { identityRedactFn } from "./redaction.js";
import { createTestStore, fixtureTrigger } from "./test-utils/fixtures.js";
import { createBlockRegistry } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

/** `demo.compute_window` — a domain-pack-shaped node block, not a real shipped block; a fixture stand-in that always resolves to a moment already in the past, so `resumeAt` is immediately due for the scheduler-tick mechanism to pick up (this test drives `resumeTimerWait` directly rather than running a real ticker, matching this package's own scope boundary — this package exports the resume primitive, `@aart/server` owns running the interval loop). */
const computeNextWindowBlock: BlockImplementation = {
  manifest: { id: "demo.compute_window", version: "0.1.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "fixture" },
  execute: async () => ({ resumeAt: new Date(Date.now() - 1000).toISOString() }),
};

describe("the exact spec §18.2 guarded-loop worked example, imported literally from this package's own src/fixtures/", () => {
  it("the imported fixture round-trips through WorkflowSchema exactly (proves the JSON form is a genuinely valid canonical Workflow, not just JSON-shaped)", () => {
    const parsed = WorkflowSchema.parse(fixtureJson);
    expect(parsed.id).toBe("review-cycle-loop");
    const rescan = parsed.execution.steps.find((s) => s.id === "rescan");
    expect(rescan).toMatchObject({ uses: "demo.compute", maxIterations: 6, next: "recheck_wait" });
    const recheckWait = parsed.execution.steps.find((s) => s.id === "recheck_wait");
    expect(recheckWait).toMatchObject({ uses: "wait.until", with: { resumeAt: "{{ steps.compute_next_window.outputs.resumeAt }}" } });
  });

  it("runs the guarded cycle up to maxIterations (6) rescans, then the 7th attempt fails with IterationLimitExceededError — the run ends failed, not stuck looping forever", async () => {
    const workflow = WorkflowSchema.parse(fixtureJson) as Workflow;
    const { store, cleanup } = await createTestStore();
    cleanups.push(cleanup);
    await store.workflows.put(workflow);

    let rescanCalls = 0;
    const rescanBlock: BlockImplementation = {
      manifest: { id: "demo.compute", version: "0.1.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "fixture" },
      execute: async (resolvedInputs) => {
        rescanCalls += 1;
        return { recordId: (resolvedInputs as { recordId: string }).recordId, cycle: rescanCalls };
      },
    };

    const engine = createEngine({
      store,
      redact: identityRedactFn,
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([computeNextWindowBlock, rescanBlock]),
      computeRetryDelayMs: () => 0,
    });

    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: { recordId: "record-42", nextReviewDate: "2027-01-01T00:00:00.000Z" } });
    const firstWait = await engine.executeRun(run.runId);
    expect(firstWait.status).toBe("waiting");
    expect(firstWait.trace.find((t) => t.stepId === "compute_next_window")?.status).toBe("completed");
    expect(firstWait.trace.find((t) => t.stepId === "recheck_wait")?.status).toBe("waiting");

    // Cycles 1-6: each resume completes `recheck_wait`, runs `rescan`
    // (priorExecutions < 6, allowed), then takes the `next: recheck_wait`
    // back-edge (no `until` in this literal fixture, so the back-edge is
    // ALWAYS taken) straight into the NEXT cycle's `recheck_wait` — the run
    // should still be "waiting" after each of these.
    let current = firstWait;
    for (let cycle = 1; cycle <= 6; cycle++) {
      const outcome = await engine.resumeTimerWait(run.runId, "recheck_wait");
      expect(outcome.kind).toBe("resumed");
      if (outcome.kind !== "resumed") throw new Error("unreachable");
      current = outcome.run;
      expect(current.status).toBe("waiting"); // looped back into another wait
    }
    expect(rescanCalls).toBe(6);

    // Cycle 7's resume: `recheck_wait` completes fine, but `rescan`'s 7th
    // attempt (priorExecutions === 6 === maxIterations) throws
    // IterationLimitExceededError — caught by the step-loop, NOT re-thrown
    // out of resumeTimerWait itself, and turned into a failed run.
    const finalOutcome = await engine.resumeTimerWait(run.runId, "recheck_wait");
    expect(finalOutcome.kind).toBe("resumed");
    if (finalOutcome.kind !== "resumed") throw new Error("unreachable");
    expect(finalOutcome.run.status).toBe("failed");
    expect(finalOutcome.run.error).toMatch(/maxIterations|iteration/i);
    // rescan was attempted a 7th time (the one that threw) — its failure
    // IS recorded in the trace, diagnosable, per this session's DoD
    // ("distinct from a generic step failure, so it's diagnosable in the
    // trace").
    const rescanTraces = finalOutcome.run.trace.filter((t) => t.stepId === "rescan");
    expect(rescanTraces).toHaveLength(7);
    expect(rescanTraces[6]?.status).toBe("failed");
    expect(rescanCalls).toBe(6); // the 7th attempt never actually called execute() — caught before dispatch
  });
});

describe("a guarded loop using until (spec §18.2/architecture §4.2) to exit BEFORE maxIterations", () => {
  it("exits the loop as soon as until evaluates true, well short of the maxIterations cap", async () => {
    // A small variant (not the literal fixture above, which has no `until`)
    // demonstrating the OTHER guard spec §18.2 names — this session's DoD:
    // "guarded back-edges with maxIterations/until."
    const workflow: Workflow = {
      id: "until-exit-demo",
      name: "Until-exit demo",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: {
        type: "workflow",
        steps: [
          { id: "recheck_wait", uses: "wait.until", with: { resumeAt: "{{ inputs.pastTimestamp }}" } },
          {
            id: "rescan",
            uses: "demo.compute",
            with: {},
            maxIterations: 6,
            until: "{{ steps.rescan.outputs.done }}",
            next: "recheck_wait",
          },
        ],
      },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };
    const { store, cleanup } = await createTestStore();
    cleanups.push(cleanup);
    await store.workflows.put(workflow);

    let rescanCalls = 0;
    const rescanBlock: BlockImplementation = {
      manifest: { id: "demo.compute", version: "0.1.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "fixture" },
      execute: async () => {
        rescanCalls += 1;
        // Completes on the 3rd rescan — well before the maxIterations: 6 cap.
        return { done: rescanCalls >= 3 };
      },
    };
    const engine = createEngine({ store, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: createBlockRegistry([rescanBlock]), computeRetryDelayMs: () => 0 });

    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: { pastTimestamp: new Date(Date.now() - 1000).toISOString() } });
    let current = await engine.executeRun(run.runId);
    expect(current.status).toBe("waiting");

    for (let cycle = 1; cycle <= 2; cycle++) {
      const outcome = await engine.resumeTimerWait(run.runId, "recheck_wait");
      if (outcome.kind !== "resumed") throw new Error("unreachable");
      current = outcome.run;
      expect(current.status).toBe("waiting"); // done still false — loops back
    }

    // 3rd cycle: rescan returns done:true -> until suppresses the
    // back-edge -> falls through to sequential order -> no more steps ->
    // run completes (NOT another wait).
    const finalOutcome = await engine.resumeTimerWait(run.runId, "recheck_wait");
    if (finalOutcome.kind !== "resumed") throw new Error("unreachable");
    expect(finalOutcome.run.status).toBe("completed");
    expect(rescanCalls).toBe(3); // stopped well short of maxIterations: 6
  });
});
