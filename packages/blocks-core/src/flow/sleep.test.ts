import { describe, expect, it } from "vitest";
import { flowSleepBlock } from "./sleep.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("flow.sleep", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(flowSleepBlock.manifest.id).toBe("flow.sleep");
    expect(flowSleepBlock.manifest.capabilities).toEqual([]);
    expect(flowSleepBlock.manifest.category).toBe("flow");
  });

  it("sleeps for approximately the given duration and reports it back", async () => {
    const start = Date.now();
    const result = await flowSleepBlock.execute({ durationMs: 50 }, fakeExecutionContext());
    const elapsed = Date.now() - start;
    expect(result).toEqual({ sleptMs: 50 });
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it("resolves immediately for a zero duration", async () => {
    const result = await flowSleepBlock.execute({ durationMs: 0 }, fakeExecutionContext());
    expect(result).toEqual({ sleptMs: 0 });
  });
});
