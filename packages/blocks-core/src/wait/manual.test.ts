import { describe, expect, it } from "vitest";
import { WaitConditionManualSchema } from "@aart/types";
import { waitManualBlock } from "./manual.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("wait.manual", () => {
  it("has complete, correctly-declared metadata (capability-free, per the Wait group's engine-handoff design)", () => {
    expect(waitManualBlock.manifest.id).toBe("wait.manual");
    expect(waitManualBlock.manifest.capabilities).toEqual([]);
    expect(waitManualBlock.manifest.category).toBe("wait");
  });

  it("constructs a WaitCondition{type: 'manual'} shape from its with: parameters", async () => {
    const result = await waitManualBlock.execute({ timeout: "P3D" }, fakeExecutionContext());
    expect(result).toEqual({ type: "manual", timeout: "P3D" });
  });

  it("omits timeout when not provided", async () => {
    const result = await waitManualBlock.execute({}, fakeExecutionContext());
    expect(result).toMatchObject({ type: "manual" });
  });

  it("produces output that validates against the frozen WaitConditionManualSchema once a schemaVersion is stamped on (the engine's job, not this block's)", async () => {
    const result = await waitManualBlock.execute({}, fakeExecutionContext());
    expect(() => WaitConditionManualSchema.parse({ ...result, schemaVersion: 1 })).not.toThrow();
  });
});
