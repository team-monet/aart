import { describe, expect, it } from "vitest";
import { WaitConditionTimerSchema } from "@aart/types";
import { waitUntilBlock } from "./until.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("wait.until", () => {
  it("has complete, correctly-declared metadata (capability-free, per the Wait group's engine-handoff design)", () => {
    expect(waitUntilBlock.manifest.id).toBe("wait.until");
    expect(waitUntilBlock.manifest.capabilities).toEqual([]);
    expect(waitUntilBlock.manifest.category).toBe("wait");
  });

  it("constructs a WaitCondition{type: 'timer'} shape from its with: parameters", async () => {
    const result = await waitUntilBlock.execute({ resumeAt: "2026-08-01T09:00:00Z" }, fakeExecutionContext());
    expect(result).toEqual({ type: "timer", resumeAt: "2026-08-01T09:00:00Z" });
  });

  it("produces output that validates against the frozen WaitConditionTimerSchema once a schemaVersion is stamped on (the engine's job, not this block's)", async () => {
    const result = await waitUntilBlock.execute({ resumeAt: "2026-08-01T09:00:00Z" }, fakeExecutionContext());
    expect(() => WaitConditionTimerSchema.parse({ ...result, schemaVersion: 1 })).not.toThrow();
  });
});
