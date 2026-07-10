import { describe, expect, it } from "vitest";
import { DataPathError, resolveDataPath, tryResolveDataPath } from "./data-path.js";

describe("resolveDataPath", () => {
  it("resolves a nested dot path", async () => {
    const value = { user: { address: { city: "Springfield" } } };
    await expect(resolveDataPath(value, "user.address.city")).resolves.toBe("Springfield");
  });

  it("resolves a bracket index path", async () => {
    const value = { items: [{ name: "a" }, { name: "b" }] };
    await expect(resolveDataPath(value, "items[1].name")).resolves.toBe("b");
  });

  it("resolves a path starting with a bracket index (no leading dot needed)", async () => {
    const value = [{ name: "first" }, { name: "second" }];
    await expect(resolveDataPath(value, "[0].name")).resolves.toBe("first");
  });

  it("resolves the empty path to the whole value", async () => {
    const value = { a: 1 };
    await expect(resolveDataPath(value, "")).resolves.toEqual({ a: 1 });
  });

  it("preserves typed values (number/boolean/object), not just strings", async () => {
    const value = { n: 42, b: true, o: { nested: true } };
    await expect(resolveDataPath(value, "n")).resolves.toBe(42);
    await expect(resolveDataPath(value, "b")).resolves.toBe(true);
    await expect(resolveDataPath(value, "o")).resolves.toEqual({ nested: true });
  });

  it("throws DataPathError for a missing key", async () => {
    await expect(resolveDataPath({ a: 1 }, "b.c")).rejects.toThrow(DataPathError);
  });

  it("throws DataPathError for invalid PropertyPath grammar (an operator token)", async () => {
    await expect(resolveDataPath({ a: 1 }, "a == 1")).rejects.toThrow(DataPathError);
  });
});

describe("tryResolveDataPath", () => {
  it("returns found:true with the value when the path resolves", async () => {
    await expect(tryResolveDataPath({ a: 1 }, "a")).resolves.toEqual({ found: true, value: 1 });
  });

  it("returns found:false instead of throwing when the path doesn't resolve", async () => {
    await expect(tryResolveDataPath({ a: 1 }, "b")).resolves.toEqual({ found: false });
  });
});
