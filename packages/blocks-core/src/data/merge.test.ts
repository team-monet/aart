import { describe, expect, it } from "vitest";
import { dataMergeBlock } from "./merge.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("data.merge", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(dataMergeBlock.manifest.id).toBe("data.merge");
    expect(dataMergeBlock.manifest.capabilities).toEqual([]);
  });

  it("shallow merge: later object wins for a top-level key", async () => {
    const result = await dataMergeBlock.execute({ objects: [{ a: 1, b: 1 }, { b: 2, c: 3 }] }, fakeExecutionContext());
    expect(result).toEqual({ value: { a: 1, b: 2, c: 3 } });
  });

  it("shallow merge: a nested object is replaced wholesale, not merged", async () => {
    const result = await dataMergeBlock.execute(
      { objects: [{ nested: { x: 1, y: 1 } }, { nested: { y: 2 } }] },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ value: { nested: { y: 2 } } });
  });

  it("deep merge: nested objects merge key by key", async () => {
    const result = await dataMergeBlock.execute(
      { objects: [{ a: 1, nested: { x: 1, y: 1 } }, { nested: { y: 2 } }], strategy: "deep" },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ value: { a: 1, nested: { x: 1, y: 2 } } });
  });

  it("deep merge: an array value is replaced wholesale, never concatenated", async () => {
    const result = await dataMergeBlock.execute(
      { objects: [{ list: [1, 2] }, { list: [3] }], strategy: "deep" },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ value: { list: [3] } });
  });

  it("merges 3+ objects in order", async () => {
    const result = await dataMergeBlock.execute({ objects: [{ a: 1 }, { a: 2 }, { a: 3 }] }, fakeExecutionContext());
    expect(result).toEqual({ value: { a: 3 } });
  });
});
