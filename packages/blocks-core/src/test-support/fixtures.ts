// Shared test fixtures — a minimal-but-schema-valid RunRecord (spec §19.1,
// packages/types/src/run.ts), used by report-renderers-port.test.ts and by
// the report.*/eval.* block tests that need a RunRecord-shaped input.
import type { RunRecord, StepTrace } from "@aart/types";

export function fakeStepTrace(overrides: Partial<StepTrace> = {}): StepTrace {
  return {
    seq: 0,
    stepId: "step-1",
    block: "http.request",
    status: "completed",
    inputs: {},
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T00:00:01.000Z",
    durationMs: 1000,
    ...overrides,
  };
}

export function fakeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-0001",
    workflowId: "wf-example",
    workflowVersion: "1.0.0",
    status: "completed",
    approved: true,
    approvalMode: "dev",
    trigger: {
      type: "manual",
      id: "trigger-0001",
      source: "test-fixture",
      payload: {},
      receivedAt: "2026-07-10T00:00:00.000Z",
    },
    inputs: {},
    trace: [fakeStepTrace()],
    waits: [],
    outputs: { result: "ok" },
    artifacts: [],
    snapshot: {
      definitions: {},
      resolvedVersions: {},
      packHashes: {},
      capturedAt: "2026-07-10T00:00:00.000Z",
    },
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:01.000Z",
    endedAt: "2026-07-10T00:00:01.000Z",
    schemaVersion: 1,
    ...overrides,
  };
}
