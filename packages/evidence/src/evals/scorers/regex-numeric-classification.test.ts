import { describe, expect, it } from "vitest";
import { classificationMatch } from "./classification-match.js";
import { numericTolerance } from "./numeric-tolerance.js";
import { regexScorer } from "./regex.js";

describe("regex scorer (spec §24.3)", () => {
  it("passes when actual matches config.pattern", () => {
    expect(regexScorer("order-12345", null, { pattern: "^order-\\d+$" }).passed).toBe(true);
  });

  it("fails when actual does not match config.pattern", () => {
    expect(regexScorer("not-an-order", null, { pattern: "^order-\\d+$" }).passed).toBe(false);
  });

  it("falls back to using a string `expected` as the pattern when config.pattern is absent", () => {
    expect(regexScorer("order-12345", "^order-\\d+$").passed).toBe(true);
  });

  it("respects config.flags (case-insensitive match)", () => {
    expect(regexScorer("HELLO", null, { pattern: "hello", flags: "i" }).passed).toBe(true);
    expect(regexScorer("HELLO", null, { pattern: "hello" }).passed).toBe(false);
  });

  it("throws when neither config.pattern nor a string expected is supplied", () => {
    expect(() => regexScorer("x", 123)).toThrow(/requires config\.pattern/);
  });
});

describe("numeric_tolerance scorer (spec §24.3)", () => {
  it("passes when |actual - expected| <= tolerance", () => {
    expect(numericTolerance(10.02, 10, { tolerance: 0.05 }).passed).toBe(true);
  });

  it("fails when the difference exceeds tolerance", () => {
    expect(numericTolerance(10.2, 10, { tolerance: 0.05 }).passed).toBe(false);
  });

  it("defaults tolerance to 0 (exact numeric match) when config is omitted", () => {
    expect(numericTolerance(10, 10).passed).toBe(true);
    expect(numericTolerance(10.0001, 10).passed).toBe(false);
  });

  it("fails (not throws/NaN) on non-numeric input", () => {
    const result = numericTolerance("not-a-number", 10);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe("classification_match scorer (spec §24.3)", () => {
  it("passes on an exact label match", () => {
    expect(classificationMatch("safe", "safe").passed).toBe(true);
  });

  it("passes on a case/whitespace-insensitive match", () => {
    expect(classificationMatch("  Safe  ", "safe").passed).toBe(true);
  });

  it("fails on a genuinely different label", () => {
    expect(classificationMatch("unsafe", "safe").passed).toBe(false);
  });
});
