import { describe, expect, it } from "vitest";
import { jsonpathExact } from "./jsonpath-exact.js";

const actual = { outputs: { nmi: "6401234567", tags: ["a", "b"] } };

describe("jsonpath_exact scorer (spec §24.3, F6 fix: distinct from jsonpath_contains)", () => {
  it("passes when the single match deep-equals expected", () => {
    const result = jsonpathExact(actual, "6401234567", { path: "$.outputs.nmi" });
    expect(result).toEqual({ passed: true, score: 1, deterministic: true });
  });

  it("fails when the single match does not equal expected", () => {
    const result = jsonpathExact(actual, "wrong", { path: "$.outputs.nmi" });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });

  it("fails (not throws) when the path resolves to zero matches", () => {
    const result = jsonpathExact(actual, "x", { path: "$.outputs.doesNotExist" });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("got 0");
  });

  it("compares the FULL matched array against expected when the path itself ends in a wildcard", () => {
    const result = jsonpathExact(actual, ["a", "b"], { path: "$.outputs.tags[*]" });
    expect(result).toEqual({ passed: true, score: 1, deterministic: true, detail: "2 wildcard match(es) at \"$.outputs.tags[*]\"" });
  });

  it("throws a clear error when config.path is missing", () => {
    expect(() => jsonpathExact(actual, "x", {})).toThrow(/requires config\.path/);
  });
});
