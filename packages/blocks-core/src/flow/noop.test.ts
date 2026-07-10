import { describe, expect, it } from "vitest";
import { flowNoopBlock } from "./noop.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("flow.noop", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(flowNoopBlock.manifest.id).toBe("flow.noop");
    expect(flowNoopBlock.manifest.capabilities).toEqual([]);
    expect(flowNoopBlock.manifest.category).toBe("flow");
  });

  it("passes a given value through unchanged", async () => {
    const result = await flowNoopBlock.execute({ value: { stage: "before-review" } }, fakeExecutionContext());
    expect(result).toEqual({ value: { stage: "before-review" } });
  });

  it("returns null when no value is provided", async () => {
    const result = await flowNoopBlock.execute({}, fakeExecutionContext());
    expect(result).toEqual({ value: null });
  });
});
