import { describe, expect, it } from "vitest";
import { assertRegexBlock } from "./regex.js";
import { BlockAssertionError } from "../lib/assertion.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("assert.regex", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(assertRegexBlock.manifest.id).toBe("assert.regex");
    expect(assertRegexBlock.manifest.capabilities).toEqual([]);
  });

  it("passes and returns the matched substring", async () => {
    const result = await assertRegexBlock.execute({ value: "Order #42", pattern: "#(\\d+)" }, fakeExecutionContext());
    expect(result).toEqual({ passed: true, match: "#42" });
  });

  it("supports flags", async () => {
    const result = await assertRegexBlock.execute({ value: "HELLO", pattern: "hello", flags: "i" }, fakeExecutionContext());
    expect(result).toMatchObject({ passed: true });
  });

  it("throws BlockAssertionError when the pattern doesn't match", async () => {
    await expect(assertRegexBlock.execute({ value: "hello", pattern: "^goodbye$" }, fakeExecutionContext())).rejects.toThrow(BlockAssertionError);
  });
});
