import { describe, expect, it } from "vitest";
import { assertJsonpathBlock } from "./jsonpath.js";
import { BlockAssertionError } from "../lib/assertion.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("assert.jsonpath", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(assertJsonpathBlock.manifest.id).toBe("assert.jsonpath");
    expect(assertJsonpathBlock.manifest.capabilities).toEqual([]);
  });

  const data = { store: { status: "ok", items: [{ id: 1 }, { id: 2 }] } };

  it("passes when a match exists and no expected value is given", async () => {
    await expect(assertJsonpathBlock.execute({ data, path: "$.store.status" }, fakeExecutionContext())).resolves.toEqual({
      passed: true,
      matches: ["ok"],
    });
  });

  it("passes when a match deep-equals the given expected value", async () => {
    await expect(assertJsonpathBlock.execute({ data, path: "$.store.status", expected: "ok" }, fakeExecutionContext())).resolves.toMatchObject({
      passed: true,
    });
  });

  it("throws BlockAssertionError when no match exists", async () => {
    await expect(assertJsonpathBlock.execute({ data, path: "$.store.nonexistent" }, fakeExecutionContext())).rejects.toThrow(BlockAssertionError);
  });

  it("throws BlockAssertionError when matches exist but none equal expected", async () => {
    await expect(
      assertJsonpathBlock.execute({ data, path: "$.store.status", expected: "broken" }, fakeExecutionContext()),
    ).rejects.toThrow(BlockAssertionError);
  });

  it("supports a wildcard match against expected", async () => {
    await expect(
      assertJsonpathBlock.execute({ data, path: "$.store.items[*].id", expected: 2 }, fakeExecutionContext()),
    ).resolves.toMatchObject({ passed: true });
  });
});
