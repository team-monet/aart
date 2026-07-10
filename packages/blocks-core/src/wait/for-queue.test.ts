import { describe, expect, it } from "vitest";
import { WaitConditionQueueSchema } from "@aart/types";
import { waitForQueueBlock } from "./for-queue.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("wait.for_queue", () => {
  it("has complete, correctly-declared metadata (capability-free, per the Wait group's engine-handoff design)", () => {
    expect(waitForQueueBlock.manifest.id).toBe("wait.for_queue");
    expect(waitForQueueBlock.manifest.capabilities).toEqual([]);
    expect(waitForQueueBlock.manifest.category).toBe("wait");
  });

  it("constructs a WaitCondition{type: 'queue'} shape from its with: parameters", async () => {
    const result = await waitForQueueBlock.execute(
      { queue: "orders.fulfillment", correlationId: "order-789", timeout: "P2D" },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ type: "queue", queue: "orders.fulfillment", correlationId: "order-789", timeout: "P2D" });
  });

  it("omits timeout when not provided", async () => {
    const result = await waitForQueueBlock.execute({ queue: "x", correlationId: "y" }, fakeExecutionContext());
    expect(result).toMatchObject({ type: "queue", queue: "x", correlationId: "y" });
  });

  it("produces output that validates against the frozen WaitConditionQueueSchema once a schemaVersion is stamped on (the engine's job, not this block's)", async () => {
    const result = await waitForQueueBlock.execute({ queue: "x", correlationId: "y" }, fakeExecutionContext());
    expect(() => WaitConditionQueueSchema.parse({ ...(result as Record<string, unknown>), schemaVersion: 1 })).not.toThrow();
  });
});
