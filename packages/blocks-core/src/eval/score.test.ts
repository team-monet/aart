import { describe, expect, it } from "vitest";
import { createEvalScoreBlock, evalScoreBlock } from "./score.js";
import { createFakeScorerRegistry } from "../test-support/fake-scorer-registry.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("eval.score", () => {
  it("has complete, correctly-declared metadata (capability: llm, defensively for the llm_judge kind)", () => {
    const block = createEvalScoreBlock(createFakeScorerRegistry());
    expect(block.manifest.id).toBe("eval.score");
    expect(block.manifest.capabilities).toEqual(["llm"]);
    expect(block.manifest.category).toBe("eval");
  });

  it("delegates to the injected ScorerRegistryPort and returns its ScorerResult", async () => {
    const block = createEvalScoreBlock(createFakeScorerRegistry());
    const result = await block.execute({ kind: "exact_match", actual: 42, expected: 42 }, fakeExecutionContext());
    expect(result).toEqual({ passed: true, score: 1 });
  });

  it("reflects a failed score (passed:false) without throwing — a scoring failure is a normal result, not an error", async () => {
    const block = createEvalScoreBlock(createFakeScorerRegistry());
    const result = await block.execute({ kind: "exact_match", actual: 1, expected: 2 }, fakeExecutionContext());
    expect(result).toEqual({ passed: false, score: 0 });
  });

  it("passes config through to the scorer (numeric_tolerance)", async () => {
    const block = createEvalScoreBlock(createFakeScorerRegistry());
    const result = await block.execute(
      { kind: "numeric_tolerance", actual: 100.005, expected: 100, config: { tolerance: 0.01 } },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ passed: true, score: 1 });
  });

  it("the default catalog export (no injection) now resolves via the real, merged @aart/evidence registry", async () => {
    // Pre-S9-integration, @aart/evidence was S0's empty stub and this
    // threw ScorerRegistryUnavailableError (see git history / SEAMS.md
    // E2) - tryLoadEvidenceScorerRegistry()'s lazy dynamic import now
    // resolves S6's real createScorerRegistry() with no injection
    // needed for any of the 11 non-llm_judge kinds. ScorerRegistryUnavailableError
    // is unreachable via this path now; it remains reachable only if
    // @aart/evidence's own export shape ever regresses.
    const result = await evalScoreBlock.execute({ kind: "exact_match", actual: 1, expected: 1 }, fakeExecutionContext());
    expect(result).toEqual({ passed: true, score: 1 });
  });

  it("the default catalog export's llm_judge kind still throws (no LlmJudgeFn injected at the composition root)", async () => {
    await expect(
      evalScoreBlock.execute({ kind: "llm_judge", actual: "a", expected: "a" }, fakeExecutionContext()),
    ).rejects.toThrow(/llm_judge scorer invoked with no LlmJudgeFn configured/);
  });
});
