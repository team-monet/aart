import { describe, expect, it } from "vitest";
import { createFakeLlmJudge, createLlmJudgeScorer, type LlmJudgeInput } from "./llm-judge.js";

describe("llm_judge scorer (spec §24.3 'LLM judge scorer, clearly marked non-deterministic'; architecture §9.5's deliberate exception)", () => {
  it("always reports deterministic: false, unlike every other scorer kind", async () => {
    const judge = createFakeLlmJudge(() => ({ passed: true, score: 1, detail: "looks right" }));
    const scorer = createLlmJudgeScorer(judge);
    const result = await scorer("the answer is 42", "42");
    expect(result).toEqual({ passed: true, score: 1, detail: "looks right", deterministic: false });
  });

  it("invokes the injected judge at temperature: 0 regardless of scorerConfig (architecture §9.5: reduces run-to-run variance)", async () => {
    let capturedInput: LlmJudgeInput | undefined;
    const judge = createFakeLlmJudge((input) => {
      capturedInput = input;
      return { passed: true, score: 1 };
    });
    const scorer = createLlmJudgeScorer(judge);
    await scorer("actual", "expected", { model: "openai/gpt-5.5-thinking", criteria: "must be polite" });

    expect(capturedInput?.model).toBe("openai/gpt-5.5-thinking");
    expect(capturedInput?.criteria).toBe("must be polite");
    expect(capturedInput?.temperature).toBe(0);
    expect(capturedInput?.actual).toBe("actual");
    expect(capturedInput?.expected).toBe("expected");
  });

  it("defaults the model when scorerConfig.model is not supplied", async () => {
    let capturedInput: LlmJudgeInput | undefined;
    const scorer = createLlmJudgeScorer(
      createFakeLlmJudge((input) => {
        capturedInput = input;
        return { passed: true, score: 1 };
      }),
    );
    await scorer("a", "b");
    expect(capturedInput?.model).toBeTruthy();
  });

  it("propagates a rejected judge call rather than silently masquerading as a deterministic pass", async () => {
    const judge = createFakeLlmJudge(() => {
      throw new Error("provider timeout");
    });
    const scorer = createLlmJudgeScorer(judge);
    await expect(scorer("a", "b")).rejects.toThrow("provider timeout");
  });
});
