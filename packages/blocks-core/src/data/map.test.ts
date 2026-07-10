import { describe, expect, it } from "vitest";
import { dataMapBlock } from "./map.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("data.map", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(dataMapBlock.manifest.id).toBe("data.map");
    expect(dataMapBlock.manifest.capabilities).toEqual([]);
  });

  it("reshapes each item per the field-path mapping", async () => {
    const result = await dataMapBlock.execute(
      { items: [{ user: { name: "Ada" } }, { user: { name: "Bob" } }], fields: { name: "user.name" } },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ items: [{ name: "Ada" }, { name: "Bob" }] });
  });

  it("supports multiple output fields per item", async () => {
    const result = await dataMapBlock.execute(
      { items: [{ id: 1, meta: { active: true } }], fields: { id: "id", isActive: "meta.active" } },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ items: [{ id: 1, isActive: true }] });
  });

  it("rejects an item whose path doesn't resolve", async () => {
    await expect(dataMapBlock.execute({ items: [{}], fields: { x: "missing.path" } }, fakeExecutionContext())).rejects.toThrow();
  });
});
