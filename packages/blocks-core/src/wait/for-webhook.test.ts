import { describe, expect, it } from "vitest";
import { WaitConditionWebhookSchema } from "@aart/types";
import { waitForWebhookBlock } from "./for-webhook.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("wait.for_webhook", () => {
  it("has complete, correctly-declared metadata (capability-free, per the Wait group's engine-handoff design)", () => {
    expect(waitForWebhookBlock.manifest.id).toBe("wait.for_webhook");
    expect(waitForWebhookBlock.manifest.capabilities).toEqual([]);
    expect(waitForWebhookBlock.manifest.category).toBe("wait");
  });

  it("constructs a WaitCondition{type: 'webhook'} shape from its with: parameters", async () => {
    const result = await waitForWebhookBlock.execute(
      { event: "stripe.payment_intent.succeeded", correlationId: "order-123", timeout: "P1D" },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ type: "webhook", event: "stripe.payment_intent.succeeded", correlationId: "order-123", timeout: "P1D" });
  });

  it("omits timeout when not provided", async () => {
    const result = await waitForWebhookBlock.execute({ event: "x", correlationId: "y" }, fakeExecutionContext());
    expect(result).toMatchObject({ type: "webhook", event: "x", correlationId: "y" });
  });

  it("produces output that validates against the frozen WaitConditionWebhookSchema once a schemaVersion is stamped on (the engine's job, not this block's)", async () => {
    const result = await waitForWebhookBlock.execute({ event: "x", correlationId: "y" }, fakeExecutionContext());
    expect(() => WaitConditionWebhookSchema.parse({ ...(result as Record<string, unknown>), schemaVersion: 1 })).not.toThrow();
  });
});
