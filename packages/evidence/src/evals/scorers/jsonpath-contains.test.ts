import { describe, expect, it } from "vitest";
import { jsonpathContains } from "./jsonpath-contains.js";

describe("jsonpath_contains scorer (spec §24.3, F6 fix: distinct from jsonpath_exact)", () => {
  it("passes when a single string match contains expected as a substring", () => {
    const actual = { message: "request failed: rate limit exceeded" };
    const result = jsonpathContains(actual, "rate limit", { path: "$.message" });
    expect(result.passed).toBe(true);
  });

  it("fails when a single string match does not contain expected", () => {
    const actual = { message: "all good" };
    const result = jsonpathContains(actual, "rate limit", { path: "$.message" });
    expect(result.passed).toBe(false);
  });

  it("passes when ANY element of a multi-match (wildcard) result deep-equals expected", () => {
    const actual = { tags: ["a", "b", "c"] };
    const result = jsonpathContains(actual, "b", { path: "$.tags[*]" });
    expect(result.passed).toBe(true);
  });

  it("fails when NO element of a multi-match result deep-equals expected", () => {
    const actual = { tags: ["a", "b", "c"] };
    const result = jsonpathContains(actual, "z", { path: "$.tags[*]" });
    expect(result.passed).toBe(false);
  });

  it("fails (not throws) on zero matches", () => {
    const result = jsonpathContains({}, "x", { path: "$.missing" });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("no matches");
  });

  it("degrades to deep-equal for a single non-string match", () => {
    const actual = { obj: { a: 1 } };
    expect(jsonpathContains(actual, { a: 1 }, { path: "$.obj" }).passed).toBe(true);
    expect(jsonpathContains(actual, { a: 2 }, { path: "$.obj" }).passed).toBe(false);
  });
});
