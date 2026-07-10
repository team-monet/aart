// Shared test fixtures for this package's own *.test.ts files. Not part of
// the public API (never re-exported from index.ts) — internal-only, DRY
// helper for constructing a real fs-backed AartStore, minimal valid
// Workflow/RunRecord objects, and small BlockImplementation fixtures used
// across step-executor/wait-machine/run-lifecycle/engine tests.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStore, type AartStore } from "@aart/store";
import type { BlockImplementation, RunRecord, Trigger, Workflow } from "@aart/types";
import { identityRedactFn } from "../redaction.js";
import { alwaysAllowCapabilityCheck } from "../capability.js";
import { CURRENT_ENGINE_SCHEMA_VERSION } from "../schema-version.js";
import { uncapturedSnapshot } from "../snapshot.js";
import type { EngineConfig } from "../types.js";

let seq = 0;
export function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

/** A fresh temp-directory-backed fs `AartStore` (the real S0 adapter, not a hand-rolled mock — matches this session's DoD: "it should pass its own tests against the fs adapter from S0"). Returns the store plus a `cleanup()` to remove the temp dir. */
export async function createTestStore(): Promise<{ store: AartStore; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-engine-test-"));
  return { store: createFsStore(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

export function fixtureTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return { type: "manual", id: uniqueId("trig"), source: "test", payload: null, receivedAt: new Date().toISOString(), ...overrides } as Trigger;
}

export function fixtureWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: uniqueId("wf"),
    name: "Fixture Workflow",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", with: {} }] },
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    ...overrides,
  };
}

export function fixtureRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: uniqueId("run"),
    workflowId: "fixture-workflow",
    workflowVersion: "0.1.0",
    status: "running",
    approved: true,
    approvalMode: "dev",
    trigger: fixtureTrigger(),
    inputs: {},
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: uncapturedSnapshot(),
    startedAt: now,
    updatedAt: now,
    schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION,
    ...overrides,
  };
}

/** Echoes `resolvedInputs` back as `{ echoed: resolvedInputs }`. The default no-op fixture block most tests register under `test.echo`. */
export const echoBlock: BlockImplementation = {
  manifest: { id: "test.echo", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "Echoes its input." },
  execute: async (resolvedInputs) => ({ echoed: resolvedInputs }),
};

/** Always throws — for testing failure/retry-exhaustion paths. `message` defaults to a distinctive string so assertions can match on it. */
export function failingBlock(id: string, message = "fixture block always fails"): BlockImplementation {
  return {
    manifest: { id, version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "Always fails." },
    execute: async () => {
      throw new Error(message);
    },
  };
}

/** Fails its first `failuresBeforeSuccess` calls (per fresh instance — construct a new one per test), then succeeds — for testing retry-then-recover. */
export function flakyBlock(id: string, failuresBeforeSuccess: number, errorClassHint?: { status?: number }): BlockImplementation {
  let calls = 0;
  return {
    manifest: { id, version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "Fails N times then succeeds." },
    execute: async (resolvedInputs) => {
      calls += 1;
      if (calls <= failuresBeforeSuccess) {
        const err = new Error(`flaky failure ${calls}/${failuresBeforeSuccess}`) as Error & { status?: number };
        if (errorClassHint?.status) err.status = errorClassHint.status;
        throw err;
      }
      return { attempts: calls, resolvedInputs };
    },
  };
}

/** Never resolves within any reasonable test timeout — for testing step.timeout enforcement. */
export function hangingBlock(id: string, delayMs: number): BlockImplementation {
  return {
    manifest: { id, version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "Delays before resolving." },
    execute: () => new Promise((resolve) => setTimeout(() => resolve({ finished: true }), delayMs)),
  };
}

/** A block declaring a specific capability set — for capability-dispatch allow/deny tests. */
export function capabilityBlock(id: string, capabilities: string[]): BlockImplementation {
  return {
    manifest: { id, version: "1.0.0", capabilities, inputSchema: {}, outputSchema: {}, description: "Declares capabilities for dispatch testing." },
    execute: async (resolvedInputs) => ({ ran: true, resolvedInputs }),
  };
}

/** Minimal `EngineConfig` wired with the identity redactor, always-allow capability stub, fast (zero-delay) retry backoff, and a small `forEachArrayLimit` override point — every field individually overridable per test. */
export function testEngineConfig(store: AartStore, overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    store,
    redact: identityRedactFn,
    capabilityCheck: alwaysAllowCapabilityCheck,
    blocks: { [echoBlock.manifest.id]: echoBlock },
    computeRetryDelayMs: () => 0, // fast, deterministic retry tests by default
    now: () => new Date(),
    ...overrides,
  };
}
