import { describe, expect, it } from "vitest";
import {
  ExecutionSnapshotSchema,
  ExternalCallMetadataSchema,
  RunFlagSchema,
  RunRecordSchema,
  StepTraceSchema,
} from "./run.js";

describe("RunFlagSchema", () => {
  it("round-trips an unset (freshly flagged) RunFlag", () => {
    const input = { kind: "reclaim_exhausted" as const, flaggedAt: "2026-07-10T00:00:00.000Z" };
    expect(RunFlagSchema.parse(input)).toEqual(input);
  });

  it("round-trips a cleared RunFlag (history retained, not deleted — architecture §4.7)", () => {
    const input = {
      kind: "poison" as const,
      flaggedAt: "2026-07-10T00:00:00.000Z",
      clearedBy: "jane@example.com",
      clearedAt: "2026-07-10T02:00:00.000Z",
    };
    expect(RunFlagSchema.parse(input)).toEqual(input);
  });

  it("rejects a kind outside {reclaim_exhausted, poison}", () => {
    expect(RunFlagSchema.safeParse({ kind: "stuck", flaggedAt: "2026-07-10T00:00:00.000Z" }).success).toBe(false);
  });
});

describe("ExternalCallMetadataSchema", () => {
  it("round-trips ExternalCallMetadata", () => {
    const input = { system: "github", domain: "api.github.com", method: "POST", status: 201, durationMs: 120 };
    expect(ExternalCallMetadataSchema.parse(input)).toEqual(input);
  });
});

describe("ExecutionSnapshotSchema", () => {
  it("round-trips an ExecutionSnapshot", () => {
    const input = {
      definitions: { id: "checkout-smoke" },
      resolvedVersions: { "browser.click": "1.0.0" },
      packHashes: { "aart-pack-github": "sha256:abc" },
      capturedAt: "2026-07-10T00:00:00.000Z",
    };
    expect(ExecutionSnapshotSchema.parse(input)).toEqual(input);
  });
});

describe("StepTraceSchema", () => {
  it("round-trips a completed StepTrace with artifacts/llmCall/externalCalls", () => {
    const input = {
      seq: 1,
      stepId: "extract_bill",
      block: "llm.extract",
      status: "completed" as const,
      inputs: { text: "..." },
      outputs: { nmi: "6401234567" },
      startedAt: "2026-07-10T00:00:00.000Z",
      endedAt: "2026-07-10T00:00:02.000Z",
      durationMs: 2000,
      artifacts: [],
      llmCall: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        promptRef: "prompts.energy_bill_extraction",
        promptVersion: "3",
        tokensIn: 512,
        tokensOut: 128,
        latencyMs: 900,
      },
      externalCalls: [],
    };
    expect(StepTraceSchema.parse(input)).toEqual(input);
  });

  it("round-trips a skipped StepTrace (cancelled-run unreached step, spec F16)", () => {
    const input = {
      seq: 2,
      stepId: "notify",
      block: "email.send",
      status: "skipped" as const,
      inputs: {},
      startedAt: "2026-07-10T00:00:00.000Z",
    };
    expect(StepTraceSchema.parse(input)).toEqual(input);
  });

  it("accepts architecture-introduced postHocCorrected (§5.3, correction outcome)", () => {
    const parsed = StepTraceSchema.parse({
      seq: 1,
      stepId: "extract_bill",
      block: "llm.extract",
      status: "completed" as const,
      inputs: {},
      startedAt: "2026-07-10T00:00:00.000Z",
      postHocCorrected: true,
    });
    expect(parsed.postHocCorrected).toBe(true);
  });
});

describe("RunRecordSchema", () => {
  const base = {
    runId: "run_1",
    workflowId: "checkout-smoke",
    workflowVersion: "0.1.0",
    status: "completed" as const,
    approved: true,
    approvalMode: "governed" as const,
    trigger: {
      type: "manual" as const,
      id: "trig_1",
      source: "cli",
      payload: null,
      receivedAt: "2026-07-10T00:00:00.000Z",
    },
    inputs: { url: "http://localhost:3000" },
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: {
      definitions: {},
      resolvedVersions: {},
      packHashes: {},
      capturedAt: "2026-07-10T00:00:00.000Z",
    },
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:03.000Z",
    schemaVersion: 1,
  };

  it("round-trips a RunRecord with flag omitted (ordinary run)", () => {
    const parsed = RunRecordSchema.parse(base);
    expect(parsed.flag).toBeUndefined();
  });

  it("round-trips a RunRecord with flag explicitly null (ordinary, not-yet-flagged run — architecture §4.1)", () => {
    const parsed = RunRecordSchema.parse({ ...base, flag: null });
    expect(parsed.flag).toBeNull();
  });

  it("round-trips a RunRecord with a set RunFlag (reclaim-exhausted or poison — architecture §4.1/§4.7/§6.2)", () => {
    const parsed = RunRecordSchema.parse({
      ...base,
      status: "failed" as const,
      flag: { kind: "reclaim_exhausted" as const, flaggedAt: "2026-07-10T00:05:00.000Z" },
    });
    expect(parsed.flag?.kind).toBe("reclaim_exhausted");
  });

  it("requires schemaVersion (architecture §4.7)", () => {
    const { schemaVersion: _drop, ...withoutVersion } = base;
    expect(RunRecordSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it("rejects a status value outside the spec §19.1 6-value enum", () => {
    expect(RunRecordSchema.safeParse({ ...base, status: "queued" }).success).toBe(false);
  });

  it("nests a full Trigger/WaitCondition inside RunRecord correctly (trigger + waits[])", () => {
    const parsed = RunRecordSchema.parse({
      ...base,
      status: "waiting" as const,
      waits: [{ type: "signal" as const, name: "client.signed", correlationId: "corr_1", schemaVersion: 1 }],
    });
    expect(parsed.waits[0]?.type).toBe("signal");
  });
});
