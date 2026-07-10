import { describe, expect, it } from "vitest";
import { assertRangeBlock } from "./range.js";
import { BlockAssertionError } from "../lib/assertion.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("assert.range", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(assertRangeBlock.manifest.id).toBe("assert.range");
    expect(assertRangeBlock.manifest.capabilities).toEqual([]);
  });

  it("passes when value is within [min, max]", async () => {
    await expect(assertRangeBlock.execute({ value: 5, min: 0, max: 10 }, fakeExecutionContext())).resolves.toEqual({ passed: true });
  });

  it("passes with only min given", async () => {
    await expect(assertRangeBlock.execute({ value: 100, min: 0 }, fakeExecutionContext())).resolves.toEqual({ passed: true });
  });

  it("passes with only max given", async () => {
    await expect(assertRangeBlock.execute({ value: -5, max: 0 }, fakeExecutionContext())).resolves.toEqual({ passed: true });
  });

  it("throws BlockAssertionError when value is below min", async () => {
    await expect(assertRangeBlock.execute({ value: -1, min: 0, max: 10 }, fakeExecutionContext())).rejects.toThrow(BlockAssertionError);
  });

  it("throws BlockAssertionError when value is above max", async () => {
    await expect(assertRangeBlock.execute({ value: 11, min: 0, max: 10 }, fakeExecutionContext())).rejects.toThrow(BlockAssertionError);
  });

  it("rejects resolvedInputs with neither min nor max (schema-level refine)", async () => {
    await expect(assertRangeBlock.execute({ value: 5 }, fakeExecutionContext())).rejects.toThrow();
  });
});
