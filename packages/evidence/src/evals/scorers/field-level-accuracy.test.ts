import { describe, expect, it } from "vitest";
import { fieldLevelAccuracy } from "./field-level-accuracy.js";

describe("field_level_accuracy scorer (spec §24.3) — the one built-in kind with a naturally graded score", () => {
  it("scores the fraction of matching fields, not just a binary pass/fail", () => {
    const actual = { nmi: "123", demandCharge: 50, gst: 10 };
    const expected = { nmi: "123", demandCharge: 999, gst: 10 };
    const result = fieldLevelAccuracy(actual, expected);
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.detail).toBe("2/3 field(s) correct");
  });

  it("passes only when score meets passThreshold (default 1 — every field must match)", () => {
    const actual = { a: 1, b: 2 };
    const expected = { a: 1, b: 999 };
    expect(fieldLevelAccuracy(actual, expected).passed).toBe(false);
    expect(fieldLevelAccuracy(actual, expected, { passThreshold: 0.5 }).passed).toBe(true);
  });

  it("restricts comparison to config.fields when supplied", () => {
    const actual = { a: 1, b: 999, c: 3 };
    const expected = { a: 1, b: 2, c: 3 };
    const result = fieldLevelAccuracy(actual, expected, { fields: ["a", "c"] });
    expect(result.score).toBe(1); // "b" excluded from comparison entirely
    expect(result.passed).toBe(true);
  });

  it("throws when `expected` is not a plain object", () => {
    expect(() => fieldLevelAccuracy({ a: 1 }, "not-an-object")).toThrow(/plain object/);
  });

  it("treats a missing `actual` object as all-fields-wrong rather than throwing", () => {
    const result = fieldLevelAccuracy(undefined, { a: 1 });
    expect(result.score).toBe(0);
  });
});
