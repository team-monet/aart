// Recipe catalog tests — spec §32.3 / architecture §10.5. DoD: "all 9
// catalog recipes present as static data; aart_propose_workflow
// phrase-matching tested against each recipe's triggerPhrases."
import { describe, expect, it } from "vitest";
import { matchRecipe, matchRecipes, RECIPES } from "./recipes.js";

const SPEC_RECIPE_IDS = [
  "verify-page-renders",
  "check-api-health",
  "download-and-parse-csv",
  "fill-web-form-and-screenshot",
  "watch-webhook-and-resume",
  "wait-for-human-approval",
  "call-llm-with-schema",
  "create-eval-from-correction",
  "run-eval-before-promotion",
];

describe("RECIPES — the 9-recipe catalog (spec §32.3's initial list)", () => {
  it("has exactly 9 recipes", () => {
    expect(RECIPES).toHaveLength(9);
  });

  it("has ids matching spec §32.3's 9 listed patterns (order-independent)", () => {
    expect([...RECIPES.map((r) => r.id)].sort()).toEqual([...SPEC_RECIPE_IDS].sort());
  });

  it("every recipe has at least one non-empty triggerPhrase and a non-empty skeleton", () => {
    for (const recipe of RECIPES) {
      expect(recipe.triggerPhrases.length).toBeGreaterThan(0);
      for (const phrase of recipe.triggerPhrases) expect(phrase.trim().length).toBeGreaterThan(0);
      expect(recipe.skeleton.trim().length).toBeGreaterThan(0);
    }
  });

  it("has unique ids", () => {
    const ids = RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("matchRecipe / matchRecipes — phrase matching against every recipe's own triggerPhrases", () => {
  for (const recipe of RECIPES) {
    for (const phrase of recipe.triggerPhrases) {
      it(`"${phrase}" matches recipe "${recipe.id}"`, () => {
        expect(matchRecipe(phrase)?.id).toBe(recipe.id);
      });
    }
  }

  it("matches a natural request that only substring-overlaps a triggerPhrase", () => {
    const match = matchRecipe("please check whether the dashboard loads correctly");
    expect(match?.id).toBe("verify-page-renders");
  });

  it("returns undefined (no match) for a request unrelated to any recipe", () => {
    expect(matchRecipe("compute the fibonacci sequence in python")).toBeUndefined();
    expect(matchRecipes("compute the fibonacci sequence in python")).toEqual([]);
  });

  it("matchRecipes returns results sorted best-first", () => {
    const results = matchRecipes("verify page renders");
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
    expect(results[0]!.recipe.id).toBe("verify-page-renders");
  });
});
