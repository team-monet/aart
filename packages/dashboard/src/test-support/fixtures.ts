// Shared test fixtures — mirrors @aart/server's own test-helpers.ts pattern
// (observed in the S2 sibling worktree): a real `createFsStore` against a
// tmp dir rather than a bare mock, so tests exercise actual persistence
// round-trips. Not itself a `*.test.ts` file (vitest.config.ts's `include`
// only picks up `*.test.ts`).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStore, type AartStore } from "@aart/store";
import type { Correction, Environment, EvalExample, EvalSuite, EventLogEntry, RunRecord, Trigger, Workflow } from "@aart/types";
import { createFakeClock, type Clock } from "../clock.js";
import { createStubDeps } from "../stub-deps.js";
import type { DashboardDeps } from "../deps.js";

export interface TestFixture {
  store: AartStore;
  clock: ReturnType<typeof createFakeClock>;
  deps: DashboardDeps;
  cleanup(): Promise<void>;
}

export async function createTestFixture(clock: Clock & { set(iso: string): void } = createFakeClock()): Promise<TestFixture> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-dashboard-test-"));
  const store = createFsStore(root);
  const deps = createStubDeps(store, clock);
  return {
    store,
    clock: clock as ReturnType<typeof createFakeClock>,
    deps,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: overrides.id ?? uniq("wf"),
    name: overrides.name ?? "Test Workflow",
    version: overrides.version ?? "1.0.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [{ id: "step1", uses: "http.get" }] },
    approval: "draft",
    gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    ...overrides,
  };
}

export function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return { type: "manual", id: uniq("trg"), source: "dashboard", payload: {}, receivedAt: "2026-07-10T00:00:00.000Z", ...overrides } as Trigger;
}

export function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = "2026-07-10T00:00:00.000Z";
  return {
    runId: overrides.runId ?? uniq("run"),
    workflowId: overrides.workflowId ?? "wf-1",
    workflowVersion: overrides.workflowVersion ?? "1.0.0",
    status: "completed",
    approved: true,
    approvalMode: "dev",
    trigger: makeTrigger(),
    inputs: {},
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: now },
    startedAt: now,
    updatedAt: now,
    schemaVersion: 1,
    ...overrides,
  };
}

export function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return { id: overrides.id ?? uniq("env"), name: overrides.name ?? "staging", config: {}, ...overrides };
}

export function makeCorrection(overrides: Partial<Correction> = {}): Correction {
  return {
    runId: overrides.runId ?? "run-1",
    stepId: overrides.stepId ?? "step1",
    fieldPath: overrides.fieldPath ?? "outputs.total",
    observed: overrides.observed ?? 1,
    corrected: overrides.corrected ?? 2,
    reason: overrides.reason ?? "off by one",
    reviewer: overrides.reviewer ?? "alice",
    createdAt: overrides.createdAt ?? "2026-07-10T00:00:00.000Z",
  };
}

/** V2 Wave 2A (activity feed, AMENDMENTS.md A64) — mirrors the other
 * make*() factories above; scoped to what this package's own server/
 * api-client tests need (id/type/occurredAt/summary + whichever correlation
 * id a given test exercises). */
export function makeEvent(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: overrides.id ?? uniq("evt"),
    type: overrides.type ?? "run.completed",
    occurredAt: overrides.occurredAt ?? "2026-07-10T00:00:00.000Z",
    summary: overrides.summary ?? "Something happened",
    ...overrides,
  };
}

export function makeEvalSuite(overrides: Partial<EvalSuite> = {}, examples: EvalExample[] = []): EvalSuite {
  return {
    id: overrides.id ?? uniq("suite"),
    name: overrides.name ?? "Test Suite",
    examples,
    scorer: overrides.scorer ?? { id: "s1", kind: "exact_match" },
    tags: overrides.tags ?? [],
    ...overrides,
  };
}
