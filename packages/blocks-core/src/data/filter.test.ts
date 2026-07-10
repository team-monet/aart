import { describe, expect, it } from "vitest";
import { dataFilterBlock } from "./filter.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("data.filter", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(dataFilterBlock.manifest.id).toBe("data.filter");
    expect(dataFilterBlock.manifest.capabilities).toEqual([]);
  });

  const items = [{ status: "active", id: 1 }, { status: "inactive", id: 2 }, { id: 3 }];

  it("filters by equals", async () => {
    const result = await dataFilterBlock.execute({ items, path: "status", equals: "active" }, fakeExecutionContext());
    expect(result).toEqual({ items: [{ status: "active", id: 1 }] });
  });

  it("filters by notEquals", async () => {
    const result = await dataFilterBlock.execute({ items, path: "status", notEquals: "active" }, fakeExecutionContext());
    expect(result).toEqual({ items: [{ status: "inactive", id: 2 }, { id: 3 }] });
  });

  it("filters by exists", async () => {
    const result = await dataFilterBlock.execute({ items, path: "status", exists: true }, fakeExecutionContext());
    expect(result).toEqual({ items: [{ status: "active", id: 1 }, { status: "inactive", id: 2 }] });
  });

  it("filters by exists: false", async () => {
    const result = await dataFilterBlock.execute({ items, path: "status", exists: false }, fakeExecutionContext());
    expect(result).toEqual({ items: [{ id: 3 }] });
  });

  it("defaults to exists:true semantics when no predicate is given", async () => {
    const result = await dataFilterBlock.execute({ items, path: "status" }, fakeExecutionContext());
    expect(result).toEqual({ items: [{ status: "active", id: 1 }, { status: "inactive", id: 2 }] });
  });

  it("combines exists and equals", async () => {
    const result = await dataFilterBlock.execute({ items, path: "status", exists: true, equals: "inactive" }, fakeExecutionContext());
    expect(result).toEqual({ items: [{ status: "inactive", id: 2 }] });
  });
});
