import { describe, expect, it } from "vitest";
import { createFakeModelRunner } from "./model-runner.js";
import { runFamiliarityEvalSuite } from "./suite.js";
import type { AuthoringTask } from "./types.js";
import { createReferenceValidator } from "./validate.js";

const KNOWN_BLOCKS = ["browser.goto", "web.read"];

function wf(uses: string[]) {
  return {
    id: "wf",
    name: "n",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: uses.map((u, i) => ({ id: `s${i}`, uses: u })) },
    approval: "draft",
    gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
  };
}

const tasks: AuthoringTask[] = [
  { id: "t1", prompt: "task 1", expectedBlocks: ["browser.goto"] },
  { id: "t2", prompt: "task 2", expectedBlocks: ["web.read"] },
];

describe("runFamiliarityEvalSuite — aggregates spec §32.4's named metrics", () => {
  it("computes firstDraftValidityRate and correctBlockChoiceRate across all tasks", async () => {
    const runner = createFakeModelRunner({
      t1: { rawOutput: "x", workflow: wf(["browser.goto"]) }, // first-draft valid + correct
      t2: { rawOutput: "x", workflow: wf(["not.a.block"]) }, // never converges
    });
    const { results, metrics } = await runFamiliarityEvalSuite(tasks, runner, { validate: createReferenceValidator(KNOWN_BLOCKS), maxCorrectiveRounds: 1 });
    expect(results).toHaveLength(2);
    expect(metrics.firstDraftValidityRate).toBe(0.5); // t1 yes, t2 no
    expect(metrics.correctBlockChoiceRate).toBe(0.5);
  });

  it("averageLoopsToValid only averages over CONVERGED tasks, and is -1 when none converged", async () => {
    const runner = createFakeModelRunner({
      t1: { rawOutput: "x", workflow: wf(["not.a.block"]) },
      t2: { rawOutput: "x", workflow: wf(["not.a.block"]) },
    });
    const { metrics } = await runFamiliarityEvalSuite(tasks, runner, { validate: createReferenceValidator(KNOWN_BLOCKS), maxCorrectiveRounds: 1 });
    expect(metrics.averageLoopsToValid).toBe(-1);
  });

  it("averageLoopsToValid reflects a mix of first-draft-valid (0 loops) and one-correction (1 loop) tasks", async () => {
    const runner = createFakeModelRunner({
      t1: { rawOutput: "x", workflow: wf(["browser.goto"]) }, // 0 loops
      t2: [{ rawOutput: "bad", workflow: wf(["not.a.block"]) }, { rawOutput: "good", workflow: wf(["web.read"]) }], // 1 loop
    });
    const { metrics } = await runFamiliarityEvalSuite(tasks, runner, { validate: createReferenceValidator(KNOWN_BLOCKS), maxCorrectiveRounds: 2 });
    expect(metrics.averageLoopsToValid).toBe(0.5); // (0 + 1) / 2
  });

  it("unpromptedAdoptionRate is undefined when no choiceTasks/choiceModelRunner supplied — a separate, optional harness (adoption.ts)", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "x", workflow: wf(["browser.goto"]) }, t2: { rawOutput: "x", workflow: wf(["web.read"]) } });
    const { metrics } = await runFamiliarityEvalSuite(tasks, runner, { validate: createReferenceValidator(KNOWN_BLOCKS) });
    expect(metrics.unpromptedAdoptionRate).toBeUndefined();
  });

  it("unpromptedAdoptionRate is computed when choiceTasks + choiceModelRunner are supplied", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "x", workflow: wf(["browser.goto"]) }, t2: { rawOutput: "x", workflow: wf(["web.read"]) } });
    const choiceTasks = [{ id: "c1", prompt: "p1" }, { id: "c2", prompt: "p2" }];
    const { metrics, choiceResults } = await runFamiliarityEvalSuite(tasks, runner, {
      validate: createReferenceValidator(KNOWN_BLOCKS),
      choiceTasks,
      choiceModelRunner: async (task) => (task.id === "c1" ? "uses: http.request" : "curl https://example.com"),
    });
    expect(choiceResults).toEqual([
      { taskId: "c1", choseAart: true },
      { taskId: "c2", choseAart: false },
    ]);
    expect(metrics.unpromptedAdoptionRate).toBe(0.5);
  });

  it("returns 0-valued rates (not NaN) for an empty task list", async () => {
    const runner = createFakeModelRunner({});
    const { metrics } = await runFamiliarityEvalSuite([], runner, { validate: createReferenceValidator(KNOWN_BLOCKS) });
    expect(metrics.firstDraftValidityRate).toBe(0);
    expect(metrics.correctBlockChoiceRate).toBe(0);
    expect(metrics.averageLoopsToValid).toBe(-1);
  });
});
