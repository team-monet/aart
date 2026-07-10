import { describe, expect, it } from "vitest";
import { assertContainsBlock } from "./contains.js";
import { BlockAssertionError } from "../lib/assertion.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("assert.contains", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(assertContainsBlock.manifest.id).toBe("assert.contains");
    expect(assertContainsBlock.manifest.capabilities).toEqual([]);
  });

  it("passes when a string actual contains expected as a substring", async () => {
    await expect(assertContainsBlock.execute({ actual: "hello world", expected: "world" }, fakeExecutionContext())).resolves.toEqual({
      passed: true,
    });
  });

  it("passes when an array actual deep-contains expected", async () => {
    await expect(
      assertContainsBlock.execute({ actual: [{ id: 1 }, { id: 2 }], expected: { id: 2 } }, fakeExecutionContext()),
    ).resolves.toEqual({ passed: true });
  });

  it("throws BlockAssertionError when a string doesn't contain the substring", async () => {
    await expect(assertContainsBlock.execute({ actual: "hello", expected: "bye" }, fakeExecutionContext())).rejects.toThrow(BlockAssertionError);
  });

  it("throws BlockAssertionError when an array doesn't contain a deep-equal element", async () => {
    await expect(assertContainsBlock.execute({ actual: [{ id: 1 }], expected: { id: 2 } }, fakeExecutionContext())).rejects.toThrow(
      BlockAssertionError,
    );
  });
});
