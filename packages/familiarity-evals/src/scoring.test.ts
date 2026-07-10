import { describe, expect, it } from "vitest";
import { createFakeModelRunner } from "./model-runner.js";
import { createReferenceRunSuccessChecker } from "./run-success.js";
import { scoreAuthoringAttempt } from "./scoring.js";
import type { AuthoringTask } from "./types.js";
import { createReferenceValidator } from "./validate.js";

const KNOWN_BLOCKS = ["browser.goto", "web.read", "assert.contains"];

function wf(uses: string[]) {
  return {
    id: "wf1",
    name: "n",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: uses.map((u, i) => ({ id: `s${i}`, uses: u })) },
    approval: "draft",
    gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
  };
}

const task: AuthoringTask = { id: "t1", prompt: "verify page renders", expectedBlocks: ["browser.goto", "web.read"] };

describe("scoreAuthoringAttempt — deterministic scoring (spec §32.4: aart_validate + run success, no LLM judge)", () => {
  it("firstDraftValid is true and loopsToValid is 0 when the zero-shot attempt validates immediately", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "yaml...", workflow: wf(["browser.goto", "web.read"]) } });
    const result = await scoreAuthoringAttempt(task, runner, { validate: createReferenceValidator(KNOWN_BLOCKS) });
    expect(result.firstDraftValid).toBe(true);
    expect(result.loopsToValid).toBe(0);
    expect(result.deterministic).toBe(true);
  });

  it("firstDraftValid is false but loopsToValid > 0 when a later round converges", async () => {
    const runner = createFakeModelRunner({
      t1: [
        { rawOutput: "bad", workflow: wf(["not.a.real.block"]) },
        { rawOutput: "good", workflow: wf(["browser.goto", "web.read"]) },
      ],
    });
    const result = await scoreAuthoringAttempt(task, runner, { validate: createReferenceValidator(KNOWN_BLOCKS) });
    expect(result.firstDraftValid).toBe(false);
    expect(result.loopsToValid).toBe(1);
    expect(result.rounds).toBe(2);
  });

  it("loopsToValid stays -1 (never converged) when the attempt never validates within maxCorrectiveRounds", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "always bad", workflow: wf(["not.a.real.block"]) } });
    const result = await scoreAuthoringAttempt(task, runner, { validate: createReferenceValidator(KNOWN_BLOCKS), maxCorrectiveRounds: 2 });
    expect(result.loopsToValid).toBe(-1);
    expect(result.rounds).toBe(2);
    expect(result.passed).toBe(false);
  });

  it("treats a response with no parseable workflow as a failed round, not a crash", async () => {
    const runner = createFakeModelRunner({
      t1: [{ rawOutput: "not parseable, no workflow field" }, { rawOutput: "good", workflow: wf(["browser.goto", "web.read"]) }],
    });
    const result = await scoreAuthoringAttempt(task, runner, { validate: createReferenceValidator(KNOWN_BLOCKS) });
    expect(result.loopsToValid).toBe(1);
  });

  it("correctBlockChoice is true only when every task.expectedBlocks id appears in the converged workflow", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "x", workflow: wf(["browser.goto"]) } }); // missing web.read
    const result = await scoreAuthoringAttempt(task, runner, { validate: createReferenceValidator(KNOWN_BLOCKS) });
    expect(result.loopsToValid).toBe(0); // it DID validate...
    expect(result.correctBlockChoice).toBe(false); // ...but picked the wrong (incomplete) block set
    expect(result.passed).toBe(false);
  });

  it("correctBlockChoice is always false when the attempt never converged", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "x", workflow: wf(["not.a.real.block"]) } });
    const result = await scoreAuthoringAttempt(task, runner, { validate: createReferenceValidator(KNOWN_BLOCKS), maxCorrectiveRounds: 1 });
    expect(result.correctBlockChoice).toBe(false);
  });

  it("ranSuccessfully uses the injected RunSuccessFn when supplied", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "x", workflow: wf(["browser.goto", "web.read"]) } });
    const alwaysFails = () => ({ succeeded: false, error: "engine says no" });
    const result = await scoreAuthoringAttempt(task, runner, { validate: createReferenceValidator(KNOWN_BLOCKS), runSuccess: alwaysFails });
    expect(result.ranSuccessfully).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("ranSuccessfully defaults to true (validity alone stands in) when no RunSuccessFn is supplied and the attempt converged", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "x", workflow: wf(["browser.goto", "web.read"]) } });
    const result = await scoreAuthoringAttempt(task, runner, { validate: createReferenceValidator(KNOWN_BLOCKS) });
    expect(result.ranSuccessfully).toBe(true);
  });

  it("integrates with the real createReferenceRunSuccessChecker end-to-end", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "x", workflow: wf(["browser.goto", "web.read"]) } });
    const result = await scoreAuthoringAttempt(task, runner, {
      validate: createReferenceValidator(KNOWN_BLOCKS),
      runSuccess: createReferenceRunSuccessChecker(),
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it("score is the fraction of {converged, correctBlockChoice, ranSuccessfully} satisfied", async () => {
    const runner = createFakeModelRunner({ t1: { rawOutput: "x", workflow: wf(["browser.goto"]) } }); // converges, but wrong block set
    const result = await scoreAuthoringAttempt(task, runner, { validate: createReferenceValidator(KNOWN_BLOCKS) });
    expect(result.score).toBeCloseTo(2 / 3); // converged(1) + correctBlockChoice(0) + ranSuccessfully(1, default) = 2/3
  });
});
