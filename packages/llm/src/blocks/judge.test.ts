import { describe, expect, it } from "vitest";
import type { EngineBlockExecutionContext } from "@aart/engine";
import { createProviderRegistry, type LlmCallParams, type ProviderAdapter } from "../provider.js";
import { createLlmJudge, createLlmJudgeBlock, LLM_JUDGE_MANIFEST, llmJudgeCore, type LlmJudgeDeps, type LlmJudgeFn, type LlmJudgeInput, type LlmJudgeOutput } from "./judge.js";

function fakeJudgeProvider(verdict: unknown): { adapter: ProviderAdapter; seenParams: () => LlmCallParams | undefined } {
  let seenParams: LlmCallParams | undefined;
  return {
    adapter: {
      id: "anthropic",
      async call(params) {
        seenParams = params;
        return { output: verdict, tokensIn: 4, tokensOut: 2, latencyMs: 3 };
      },
    },
    seenParams: () => seenParams,
  };
}
function fakeCtx() {
  return {
    runId: "run_1",
    stepId: "step_1",
    async resolveSecret() { return ""; },
    async writeArtifact() { return { id: "a", path: "/a" }; },
  };
}

describe("llmJudgeCore / createLlmJudge — architecture §12.3, S6's LlmJudgeFn seam (SEAMS.md L2)", () => {
  it("createLlmJudge returns a function matching LlmJudgeFn's exact shape: (input) => Promise<{passed,score,detail?}>", async () => {
    const { adapter } = fakeJudgeProvider({ passed: true, score: 0.95, detail: "close enough" });
    const deps: LlmJudgeDeps = { providers: createProviderRegistry([adapter]) };
    const judge: LlmJudgeFn = createLlmJudge(deps);
    const input: LlmJudgeInput = { model: "anthropic/claude-sonnet-5", actual: { total: 100 }, expected: { total: 100 } };
    const output: LlmJudgeOutput = await judge(input);
    expect(output).toEqual({ passed: true, score: 0.95, detail: "close enough" });
  });

  it("defaults temperature to 0 when omitted (S6's own doc comment: 'always invoked at 0')", async () => {
    const { adapter, seenParams } = fakeJudgeProvider({ passed: true, score: 1 });
    const deps: LlmJudgeDeps = { providers: createProviderRegistry([adapter]) };
    await createLlmJudge(deps)({ model: "anthropic/claude-sonnet-5", actual: 1, expected: 1 });
    expect(seenParams()?.temperature).toBe(0);
  });

  it("honors an explicitly-passed temperature rather than always forcing 0", async () => {
    const { adapter, seenParams } = fakeJudgeProvider({ passed: true, score: 1 });
    const deps: LlmJudgeDeps = { providers: createProviderRegistry([adapter]) };
    await createLlmJudge(deps)({ model: "anthropic/claude-sonnet-5", actual: 1, expected: 1, temperature: 0.3 });
    expect(seenParams()?.temperature).toBe(0.3);
  });

  it("includes criteria/actual/expected in the constructed prompt/input sent to the provider", async () => {
    const { adapter, seenParams } = fakeJudgeProvider({ passed: false, score: 0.1 });
    const deps: LlmJudgeDeps = { providers: createProviderRegistry([adapter]) };
    await createLlmJudge(deps)({ model: "anthropic/claude-sonnet-5", actual: "wrong answer", expected: "right answer", criteria: "must match exactly" });
    expect(seenParams()?.prompt).toContain("must match exactly");
    expect(seenParams()?.prompt).toContain("right answer");
  });

  it("rejects a malformed verdict (fails the JUDGE_OUTPUT_SCHEMA validation) rather than passing through garbage", async () => {
    const { adapter } = fakeJudgeProvider({ passed: "not-a-boolean", score: "also-not-a-number" });
    const deps: LlmJudgeDeps = { providers: createProviderRegistry([adapter]) };
    await expect(createLlmJudge(deps)({ model: "anthropic/claude-sonnet-5", actual: 1, expected: 1 })).rejects.toThrow();
  });

  it("llmJudgeCore's LlmCallMetadata carries the verdict itself as scorerResult (spec §19.2's field exists for exactly this)", async () => {
    const { adapter } = fakeJudgeProvider({ passed: true, score: 0.8, detail: "ok" });
    const deps: LlmJudgeDeps = { providers: createProviderRegistry([adapter]) };
    const result = await llmJudgeCore({ model: "anthropic/claude-sonnet-5", actual: 1, expected: 1 }, deps);
    expect(result.llmCallMetadata.scorerResult).toEqual({ passed: true, score: 0.8, detail: "ok" });
    expect(result.llmCallMetadata.schemaRef).toBe("inline");
  });
});

describe("llm.judge block — the workflow-step surface", () => {
  it("manifest.id is 'llm.judge'", () => {
    expect(LLM_JUDGE_MANIFEST.id).toBe("llm.judge");
  });

  it("execute() returns the plain verdict, matching the standalone LlmJudgeFn's output shape", async () => {
    const { adapter } = fakeJudgeProvider({ passed: true, score: 1, detail: "exact match" });
    const deps: LlmJudgeDeps = { providers: createProviderRegistry([adapter]) };
    const block = createLlmJudgeBlock(deps);
    const result = await block.execute({ model: "anthropic/claude-sonnet-5", actual: "x", expected: "x" }, fakeCtx());
    expect(result).toEqual({ passed: true, score: 1, detail: "exact match" });
  });

  it("execute() calls ctx.recordLlmCall with metadata carrying the verdict as scorerResult", async () => {
    const { adapter } = fakeJudgeProvider({ passed: false, score: 0.2 });
    const deps: LlmJudgeDeps = { providers: createProviderRegistry([adapter]) };
    const block = createLlmJudgeBlock(deps);
    const calls: unknown[] = [];
    const ctx: EngineBlockExecutionContext = { ...fakeCtx(), recordLlmCall: (m: unknown) => calls.push(m) };
    await block.execute({ model: "anthropic/claude-sonnet-5", actual: "x", expected: "y" }, ctx);
    expect(calls).toHaveLength(1);
  });
});
