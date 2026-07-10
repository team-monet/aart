import { describe, expect, it } from "vitest";
import {
  CorrectionSchema,
  DeploymentSchema,
  EnvironmentSchema,
  PackManifestSchema,
  PromptRegistryEntrySchema,
  RejectedTriggerSchema,
  ScheduleSchema,
  SchemaRegistryEntrySchema,
} from "./store-records.js";

describe("DeploymentSchema", () => {
  it("round-trips a Deployment", () => {
    const input = {
      id: "dep_1",
      workflowId: "checkout-smoke",
      workflowVersion: "0.2.0",
      environmentId: "env_prod",
      triggerConfig: { webhook: { path: "/hooks/checkout" } },
      bundleHash: "sha256:abc",
      createdAt: "2026-07-10T00:00:00.000Z",
    };
    expect(DeploymentSchema.parse(input)).toEqual(input);
  });
});

describe("EnvironmentSchema", () => {
  it("round-trips an Environment", () => {
    const input = { id: "env_prod", name: "production", config: { region: "us-east-1" } };
    expect(EnvironmentSchema.parse(input)).toEqual(input);
  });
});

describe("ScheduleSchema", () => {
  it("round-trips a Schedule (spec §29 example)", () => {
    const input = {
      id: "sched_1",
      workflowId: "weekly-energy-report",
      workflowVersion: "0.2.0",
      cron: "0 9 * * 1",
      timezone: "Australia/Brisbane",
      missedRunPolicy: "fire_once" as const,
      inputs: { brokerId: "broker_123" },
      paused: false,
    };
    expect(ScheduleSchema.parse(input)).toEqual(input);
  });

  it("rejects a missedRunPolicy outside {skip, fire_once, fire_all}", () => {
    const result = ScheduleSchema.safeParse({
      id: "sched_2",
      workflowId: "x",
      workflowVersion: "1",
      cron: "* * * * *",
      timezone: "UTC",
      missedRunPolicy: "fire_twice",
      paused: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("PromptRegistryEntrySchema / SchemaRegistryEntrySchema", () => {
  it("round-trips a PromptRegistryEntry", () => {
    const input = { name: "energy_bill_extraction", version: "3", contentHash: "sha256:def", body: "Extract the NMI..." };
    expect(PromptRegistryEntrySchema.parse(input)).toEqual(input);
  });

  it("round-trips a SchemaRegistryEntry", () => {
    const input = {
      name: "energy_bill",
      version: "1",
      contentHash: "sha256:ghi",
      jsonSchema: { type: "object", properties: { nmi: { type: "string" } } },
    };
    expect(SchemaRegistryEntrySchema.parse(input)).toEqual(input);
  });
});

describe("PackManifestSchema", () => {
  it("round-trips a PackManifest", () => {
    const input = {
      name: "aart-pack-github",
      version: "1.2.0",
      contentHash: "sha256:jkl",
      manifest: { capabilities: ["github.read", "github.write"] },
      approvalStatus: "unapproved",
    };
    expect(PackManifestSchema.parse(input)).toEqual(input);
  });
});

describe("CorrectionSchema", () => {
  it("round-trips the spec §23.3 correction example", () => {
    const input = {
      runId: "run_123",
      stepId: "extract_bill",
      fieldPath: "outputs.nmi",
      observed: "6401234567",
      corrected: "6401234568",
      reason: "OCR misread final digit",
      reviewer: "jane@example.com",
      createdAt: "2026-07-10T00:00:00.000Z",
    };
    expect(CorrectionSchema.parse(input)).toEqual(input);
  });

  it("rejects a Correction with no reviewer (spec §23.3: required on every correction, transcribed or not)", () => {
    const result = CorrectionSchema.safeParse({
      runId: "run_123",
      stepId: "extract_bill",
      fieldPath: "outputs.nmi",
      observed: "a",
      corrected: "b",
      reason: "x",
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("RejectedTriggerSchema", () => {
  it.each(["bad_hmac", "input_mapping_failed", "concurrency_rejected", "backlog_ceiling", "poison_flagged", "duplicate_delivery"] as const)(
    "round-trips a RejectedTrigger with reason=%s",
    (reason) => {
      const input = {
        id: "rej_1",
        triggerType: "webhook",
        reason,
        rawPayload: { foo: "bar" },
        receivedAt: "2026-07-10T00:00:00.000Z",
      };
      expect(RejectedTriggerSchema.parse(input)).toEqual(input);
    },
  );

  it("rejects a reason outside the architecture §5.3 enum", () => {
    const result = RejectedTriggerSchema.safeParse({
      id: "rej_2",
      triggerType: "webhook",
      reason: "rate_limited",
      rawPayload: {},
      receivedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
