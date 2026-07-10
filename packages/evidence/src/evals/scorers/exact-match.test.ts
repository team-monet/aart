import { describe, expect, it } from "vitest";
import { deepEqual } from "./deep-equal.js";
import { exactMatch } from "./exact-match.js";

describe("deepEqual", () => {
  it("compares primitives, including NaN and -0/+0 via Object.is semantics", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(0, -0)).toBe(false);
    expect(deepEqual(1, 2)).toBe(false);
  });

  it("compares arrays element-wise, order-sensitive", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("compares plain objects key-wise, order-insensitive", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("compares nested structures", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  it("treats an array and an object as unequal even with matching entries", () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });
});

describe("exact_match scorer (spec §24.3)", () => {
  it("passes on a deep-equal match, score 1, deterministic true", () => {
    const result = exactMatch({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] });
    expect(result).toEqual({ passed: true, score: 1, deterministic: true });
  });

  it("fails on any mismatch, score 0", () => {
    const result = exactMatch({ a: 1 }, { a: 2 });
    expect(result).toEqual({ passed: false, score: 0, deterministic: true });
  });
});
