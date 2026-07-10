import { describe, expect, it } from "vitest";
import { dataPickBlock } from "./pick.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("data.pick", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(dataPickBlock.manifest.id).toBe("data.pick");
    expect(dataPickBlock.manifest.capabilities).toEqual([]);
    expect(dataPickBlock.manifest.category).toBe("data");
    expect(dataPickBlock.manifest.description.length).toBeGreaterThan(0);
  });

  it("picks multiple nested paths into a flat object keyed by full path", async () => {
    const result = await dataPickBlock.execute(
      { from: { user: { name: "Ada", email: "ada@example.com" }, active: true }, paths: ["user.name", "user.email", "active"] },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ value: { "user.name": "Ada", "user.email": "ada@example.com", active: true } });
  });

  it("picks an array-indexed path", async () => {
    const result = await dataPickBlock.execute(
      { from: { items: [{ id: 1 }, { id: 2 }] }, paths: ["items[1].id"] },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ value: { "items[1].id": 2 } });
  });

  it("rejects resolvedInputs missing the required paths field", async () => {
    await expect(dataPickBlock.execute({ from: {} }, fakeExecutionContext())).rejects.toThrow();
  });
});
