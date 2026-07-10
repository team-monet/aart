import { describe, expect, it } from "vitest";
import { TRIGGER_TYPES, TriggerSchema, SignalSchema, type TriggerType } from "./trigger.js";

describe("TriggerSchema", () => {
  it.each(TRIGGER_TYPES)("round-trips a %s trigger", (type: TriggerType) => {
    const input = {
      id: "trig_1",
      type,
      source: "test-harness",
      payload: { foo: "bar" },
      receivedAt: "2026-07-10T00:00:00.000Z",
    };
    const parsed = TriggerSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed.type).toBe(type);
  });

  it("accepts optional correlationId and dedupeKey", () => {
    const parsed = TriggerSchema.parse({
      id: "trig_2",
      type: "webhook",
      source: "github",
      payload: {},
      correlationId: "corr_1",
      dedupeKey: "delivery_abc",
      receivedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(parsed.correlationId).toBe("corr_1");
    if (parsed.type === "webhook") {
      expect(parsed.dedupeKey).toBe("delivery_abc");
    }
  });

  it("omits dedupeKey/correlationId cleanly when absent (adapters with no natural delivery id)", () => {
    const parsed = TriggerSchema.parse({
      id: "trig_3",
      type: "manual",
      source: "cli",
      payload: null,
      receivedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(parsed.dedupeKey).toBeUndefined();
    expect(parsed.correlationId).toBeUndefined();
  });

  it("rejects a type value outside the 13-member union", () => {
    const result = TriggerSchema.safeParse({
      id: "trig_4",
      type: "not-a-real-type",
      source: "x",
      payload: {},
      receivedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a trigger missing a required field (receivedAt)", () => {
    const result = TriggerSchema.safeParse({
      id: "trig_5",
      type: "manual",
      source: "cli",
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("exposes exactly the 13 spec §13.1 trigger types, in spec order", () => {
    expect(TRIGGER_TYPES).toEqual([
      "manual",
      "mcp",
      "cli",
      "webhook",
      "schedule",
      "email",
      "file",
      "queue",
      "database",
      "github",
      "slack",
      "poll",
      "sdk",
    ]);
  });

  it("supports exhaustive switch-narrowing over every member (compile-time proof via a `never` default)", () => {
    function describeTrigger(type: TriggerType): string {
      switch (type) {
        case "manual":
          return "manual";
        case "mcp":
          return "mcp";
        case "cli":
          return "cli";
        case "webhook":
          return "webhook";
        case "schedule":
          return "schedule";
        case "email":
          return "email";
        case "file":
          return "file";
        case "queue":
          return "queue";
        case "database":
          return "database";
        case "github":
          return "github";
        case "slack":
          return "slack";
        case "poll":
          return "poll";
        case "sdk":
          return "sdk";
        default: {
          const _exhaustive: never = type;
          throw new Error(`unhandled trigger type: ${_exhaustive}`);
        }
      }
    }
    for (const t of TRIGGER_TYPES) {
      expect(describeTrigger(t)).toBe(t);
    }
  });
});

describe("SignalSchema", () => {
  it("round-trips a Signal", () => {
    const input = {
      id: "sig_1",
      name: "quote.received",
      correlationId: "corr_1",
      payload: { amount: 100 },
      receivedAt: "2026-07-10T00:00:00.000Z",
    };
    expect(SignalSchema.parse(input)).toEqual(input);
  });

  it("rejects a Signal missing correlationId", () => {
    const result = SignalSchema.safeParse({
      id: "sig_2",
      name: "quote.received",
      payload: {},
      receivedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
