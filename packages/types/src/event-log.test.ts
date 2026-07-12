import { describe, expect, it } from "vitest";
import { EventLogEntrySchema } from "./event-log.js";

describe("EventLogEntrySchema", () => {
  it("round-trips the minimal shape — id/type/occurredAt/summary only, no correlation fields", () => {
    const input = {
      id: "evt_1",
      type: "run.started",
      occurredAt: "2026-07-12T00:00:00.000Z",
      summary: "checkout-flow@0.1.0 run started",
    };
    expect(EventLogEntrySchema.parse(input)).toEqual(input);
  });

  it("round-trips every optional correlation field when all are present", () => {
    const input = {
      id: "evt_2",
      type: "deployment.promoted",
      occurredAt: "2026-07-12T00:00:00.000Z",
      summary: "invoice-scan@0.3.0 promoted to production",
      workflowId: "invoice-scan",
      workflowVersion: "0.3.0",
      runId: "run_1",
      deploymentId: "dep_1",
      environmentId: "env_1",
      approvalTaskId: "task_1",
      actor: "deploy-token",
    };
    expect(EventLogEntrySchema.parse(input)).toEqual(input);
  });

  it("accepts an arbitrary type string — a value set, not a closed enum (forward-compatible with a future Wave-2 event type)", () => {
    const input = { id: "evt_3", type: "some.future.event.type.not.yet.defined", occurredAt: "2026-07-12T00:00:00.000Z", summary: "s" };
    expect(EventLogEntrySchema.parse(input)).toEqual(input);
  });

  it("rejects a missing required field (summary)", () => {
    const result = EventLogEntrySchema.safeParse({ id: "evt_4", type: "run.started", occurredAt: "2026-07-12T00:00:00.000Z" });
    expect(result.success).toBe(false);
  });
});
