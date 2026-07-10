import { describe, expect, it } from "vitest";
import { WaitConditionSignalSchema } from "@aart/types";
import { waitForSignalBlock } from "./for-signal.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("wait.for_signal", () => {
  it("has complete, correctly-declared metadata (capability-free, per the Wait group's engine-handoff design)", () => {
    expect(waitForSignalBlock.manifest.id).toBe("wait.for_signal");
    expect(waitForSignalBlock.manifest.capabilities).toEqual([]);
    expect(waitForSignalBlock.manifest.category).toBe("wait");
  });

  it("constructs a WaitCondition{type: 'signal'} shape from its with: parameters", async () => {
    const result = await waitForSignalBlock.execute(
      { name: "quote.received", correlationId: "case-123", timeout: "P7D" },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ type: "signal", name: "quote.received", correlationId: "case-123", timeout: "P7D" });
  });

  it("omits timeout when not provided", async () => {
    const result = await waitForSignalBlock.execute({ name: "x", correlationId: "y" }, fakeExecutionContext());
    expect(result).toMatchObject({ type: "signal", name: "x", correlationId: "y" });
  });

  it("produces output that validates against the frozen WaitConditionSignalSchema once a schemaVersion is stamped on (the engine's job, not this block's)", async () => {
    const result = await waitForSignalBlock.execute({ name: "x", correlationId: "y" }, fakeExecutionContext());
    expect(() => WaitConditionSignalSchema.parse({ ...(result as Record<string, unknown>), schemaVersion: 1 })).not.toThrow();
  });
});
