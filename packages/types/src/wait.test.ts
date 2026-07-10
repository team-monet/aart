import { describe, expect, it } from "vitest";
import { WAIT_CONDITION_TYPES, WaitConditionSchema, type WaitCondition, type WaitConditionType } from "./wait.js";

const fixtures: Record<WaitConditionType, Record<string, unknown>> = {
  approval: { type: "approval", taskId: "task_1", schemaVersion: 1 },
  signal: { type: "signal", name: "quote.received", correlationId: "corr_1", schemaVersion: 1 },
  timer: { type: "timer", resumeAt: "2026-08-01T00:00:00.000Z", schemaVersion: 1 },
  webhook: { type: "webhook", event: "listing.appealed", correlationId: "corr_1", schemaVersion: 1 },
  external_job: { type: "external_job", provider: "openai", jobId: "job_1", schemaVersion: 1 },
  queue: { type: "queue", queue: "renewals", correlationId: "corr_1", schemaVersion: 1 },
  manual: { type: "manual", schemaVersion: 1 },
};

describe("WaitConditionSchema", () => {
  it.each(WAIT_CONDITION_TYPES)("round-trips a %s wait condition", (type) => {
    const parsed = WaitConditionSchema.parse(fixtures[type]);
    expect(parsed).toEqual(fixtures[type]);
  });

  it.each(WAIT_CONDITION_TYPES)("accepts an optional timeout on %s where the member supports it", (type) => {
    if (type === "timer") return; // timer has no `timeout` field (resumeAt is the deadline itself)
    const parsed = WaitConditionSchema.parse({ ...fixtures[type], timeout: "PT24H" });
    expect((parsed as Record<string, unknown>).timeout).toBe("PT24H");
  });

  it("requires schemaVersion on every member (architecture §4.7 engine-code version-skew guard)", () => {
    const { schemaVersion: _drop, ...withoutVersion } = fixtures.signal;
    const result = WaitConditionSchema.safeParse(withoutVersion);
    expect(result.success).toBe(false);
  });

  it("rejects a type value outside the 7-member union", () => {
    const result = WaitConditionSchema.safeParse({ type: "bogus", schemaVersion: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects a member missing its own required field (signal without correlationId)", () => {
    const result = WaitConditionSchema.safeParse({ type: "signal", name: "x", schemaVersion: 1 });
    expect(result.success).toBe(false);
  });

  it("exposes exactly the 7 spec §13.3 wait condition types, in spec order", () => {
    expect(WAIT_CONDITION_TYPES).toEqual(["approval", "signal", "timer", "webhook", "external_job", "queue", "manual"]);
  });

  it("supports exhaustive switch-narrowing over every member (compile-time proof via a `never` default) — architecture §2.2's stated requirement", () => {
    function fieldCount(w: WaitCondition): number {
      switch (w.type) {
        case "approval":
          return Object.keys(w).length;
        case "signal":
          return Object.keys(w).length;
        case "timer":
          return Object.keys(w).length;
        case "webhook":
          return Object.keys(w).length;
        case "external_job":
          return Object.keys(w).length;
        case "queue":
          return Object.keys(w).length;
        case "manual":
          return Object.keys(w).length;
        default: {
          const _exhaustive: never = w;
          throw new Error(`unhandled wait condition type: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
    for (const type of WAIT_CONDITION_TYPES) {
      const parsed = WaitConditionSchema.parse(fixtures[type]);
      expect(fieldCount(parsed)).toBeGreaterThan(0);
    }
  });
});
