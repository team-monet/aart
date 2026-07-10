// test-support/fixtures.ts — shared RunRecord/Workflow fixture builders for
// this package's own test suite. NOT a *.test.ts file (vitest's
// `include: ["src/**/*.test.ts"]` won't pick it up), so it's safe to import
// from multiple test files without registering duplicate test blocks.
import type { RunRecord, Workflow } from "@aart/types";

let seq = 0;
export function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

export function fixtureRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: uniqueId("run"),
    workflowId: "checkout-smoke",
    workflowVersion: "0.1.0",
    status: "completed",
    approved: true,
    approvalMode: "governed",
    trigger: { type: "manual", id: uniqueId("trig"), source: "cli", payload: null, receivedAt: "2026-01-01T00:00:00.000Z" },
    inputs: { url: "https://example.com" },
    trace: [
      {
        seq: 0,
        stepId: "open",
        block: "browser.goto",
        status: "completed",
        inputs: { url: "https://example.com" },
        outputs: {},
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
      },
    ],
    waits: [],
    artifacts: [],
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: "2026-01-01T00:00:00.000Z" },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
    endedAt: "2026-01-01T00:00:02.000Z",
    schemaVersion: 1,
    ...overrides,
  };
}

export function fixtureWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: uniqueId("wf"),
    name: "Fixture Workflow",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [{ id: "s1", uses: "assert.contains", with: {} }] },
    approval: "draft",
    gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    ...overrides,
  };
}
