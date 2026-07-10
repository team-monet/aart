import { describe, expect, it } from "vitest";
import { assertEqualsBlock } from "./equals.js";
import { BlockAssertionError } from "../lib/assertion.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("assert.equals", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(assertEqualsBlock.manifest.id).toBe("assert.equals");
    expect(assertEqualsBlock.manifest.capabilities).toEqual([]);
  });

  it("passes when actual deep-equals expected (primitives)", async () => {
    await expect(assertEqualsBlock.execute({ actual: 42, expected: 42 }, fakeExecutionContext())).resolves.toEqual({ passed: true });
  });

  it("passes when actual deep-equals expected (objects, key-order independent)", async () => {
    await expect(
      assertEqualsBlock.execute({ actual: { a: 1, b: 2 }, expected: { b: 2, a: 1 } }, fakeExecutionContext()),
    ).resolves.toEqual({ passed: true });
  });

  it("throws BlockAssertionError (fails the run) when values differ", async () => {
    await expect(assertEqualsBlock.execute({ actual: 1, expected: 2 }, fakeExecutionContext())).rejects.toThrow(BlockAssertionError);
  });

  it("throws for a structural mismatch nested inside an object", async () => {
    await expect(
      assertEqualsBlock.execute({ actual: { a: 1 }, expected: { a: 2 } }, fakeExecutionContext()),
    ).rejects.toThrow(BlockAssertionError);
  });
});
