import { BUILTIN_SCORER_KINDS } from "@aart/types";
import { describe, expect, it } from "vitest";
import { createFakeLlmJudge } from "./llm-judge.js";
import { createScorerRegistry } from "./registry.js";

describe("createScorerRegistry — exhaustiveness (architecture §9.5: 12 kinds, F6 fix)", () => {
  it("registers exactly the 12 kinds frozen in @aart/types' BUILTIN_SCORER_KINDS, no more, no fewer", () => {
    const registry = createScorerRegistry();
    expect(BUILTIN_SCORER_KINDS).toHaveLength(12);
    for (const kind of BUILTIN_SCORER_KINDS) {
      expect(registry.get(kind)).toBeDefined();
    }
    expect(registry.kinds).toEqual(BUILTIN_SCORER_KINDS);
  });

  it("jsonpath_exact and jsonpath_contains are two DISTINCT registered kinds (F6 fix)", () => {
    const registry = createScorerRegistry();
    expect(registry.get("jsonpath_exact")).not.toBe(registry.get("jsonpath_contains"));
  });

  it("11 of the 12 kinds report deterministic: true; only llm_judge reports false", () => {
    const registry = createScorerRegistry();
    for (const kind of BUILTIN_SCORER_KINDS) {
      const entry = registry.get(kind)!;
      expect(entry.deterministic).toBe(kind !== "llm_judge");
    }
  });

  it("score() throws a clear error for an unknown kind", async () => {
    const registry = createScorerRegistry();
    await expect(registry.score("not_a_real_kind", 1, 1)).rejects.toThrow(/Unknown scorer kind/);
  });

  it("score() dispatches to the correct scorer by kind", async () => {
    const registry = createScorerRegistry();
    await expect(registry.score("exact_match", 1, 1)).resolves.toMatchObject({ passed: true });
    await expect(registry.score("exact_match", 1, 2)).resolves.toMatchObject({ passed: false });
  });

  it("llm_judge throws a clear, documented error when invoked with no llmJudge configured (this session's stubbed-seam handling)", async () => {
    const registry = createScorerRegistry();
    await expect(registry.score("llm_judge", "a", "b")).rejects.toThrow(/no LlmJudgeFn configured/);
  });

  it("llm_judge works end-to-end once an llmJudge fake is injected at registry-construction time", async () => {
    const registry = createScorerRegistry({ llmJudge: createFakeLlmJudge(() => ({ passed: true, score: 1 })) });
    await expect(registry.score("llm_judge", "a", "b")).resolves.toMatchObject({ passed: true, deterministic: false });
  });

  it("an example-level scorerConfig (4th arg) reaches the underlying scorer function", async () => {
    const registry = createScorerRegistry();
    await expect(registry.score("jsonpath_exact", { a: { b: 1 } }, 1, { path: "$.a.b" })).resolves.toMatchObject({ passed: true });
  });
});
