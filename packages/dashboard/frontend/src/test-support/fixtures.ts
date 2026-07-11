// Minimal, type-correct fixture factories for frontend page tests — mirrors
// packages/dashboard/src/test-support/fixtures.ts's makeRun/makeWorkflow
// pattern on the backend side of this package, scoped to what the SPA
// pages actually read (real @aart/types shapes, not hand-waved objects —
// the whole point of this package's own typing pass was making a wrong
// field name a compile error, and an untyped test fixture would quietly
// defeat that for every test built on top of it).
import type { ApprovalTask, Correction, Environment, EvalSuite, RunRecord, Workflow } from "@aart/types";

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
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
    trigger: { type: "manual", id: uniq("trig"), source: "dashboard", payload: {}, receivedAt: now },
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

export function makeApprovalTask(overrides: Partial<ApprovalTask> = {}): ApprovalTask {
  return {
    id: overrides.id ?? uniq("task"),
    runId: overrides.runId ?? "run-1",
    stepId: overrides.stepId ?? "step1",
    title: overrides.title ?? "Ship?",
    description: overrides.description ?? "Needs sign-off",
    status: "pending",
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
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
    ...overrides,
  };
}

export function makeEvalSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    id: overrides.id ?? uniq("suite"),
    name: overrides.name ?? "Test Suite",
    examples: [],
    scorer: { id: "s1", kind: "exact_match" },
    tags: [],
    ...overrides,
  };
}

export function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return { id: overrides.id ?? uniq("env"), name: overrides.name ?? "staging", config: {}, ...overrides };
}
