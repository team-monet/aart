// createRealEngineBoundary (root AMENDMENTS.md, S10 completion — the
// function packages/mcp/src/real-context.ts's own comment claimed existed
// since S9, but never actually did). Uses a REAL @aart/engine Engine (real
// fs store, identity redact, always-allow capability check) — not a mock —
// so these tests exercise the actual adapter logic against actual engine
// behavior, same discipline this repo's own test suites already use
// elsewhere (e.g. packages/engine's own test-utils/fixtures.ts).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsStore, type AartStore } from "@aart/store";
import { alwaysAllowCapabilityCheck, createEngine, identityRedactFn, type Engine } from "@aart/engine";
import type { BlockImplementation, Workflow } from "@aart/types";
import { createRealEngineBoundary } from "./boundary.js";
import { systemClock } from "../clock.js";

const echoBlock: BlockImplementation = {
  manifest: { id: "test.echo", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "echoes input" },
  execute: async (input) => ({ echoed: input }),
};

function fixtureWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: overrides.id ?? "boundary-fixture-wf",
    name: "Boundary Fixture Workflow",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", with: {} }] },
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    ...overrides,
  };
}

let root: string;
let store: AartStore;
let engine: Engine;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aart-server-boundary-test-"));
  store = createFsStore(root);
  engine = createEngine({ store, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: { [echoBlock.manifest.id]: echoBlock }, now: () => systemClock.now() });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("createRealEngineBoundary", () => {
  describe("startRun", () => {
    it("resolves the workflow's latest version when none is pinned, and returns kind: started", async () => {
      const workflow = fixtureWorkflow();
      await store.workflows.put(workflow);
      const boundary = createRealEngineBoundary(store, engine);

      const result = await boundary.startRun({
        workflowId: workflow.id,
        trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() },
        mappedInputs: {},
      });

      expect(result.kind).toBe("started");
      expect((result as { runId: string }).runId).toBeTruthy();
      const persisted = await store.runs.get((result as { runId: string }).runId);
      expect(persisted?.status).toBe("pending");
      // startRun's job is intake only (architecture's job_queue/worker
      // decoupling) — it must NOT have executed any steps itself.
      expect(persisted?.trace).toEqual([]);
    });

    it("returns kind: rejected (not a thrown error) when the workflow doesn't exist", async () => {
      const boundary = createRealEngineBoundary(store, engine);
      const result = await boundary.startRun({
        workflowId: "does-not-exist",
        trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() },
        mappedInputs: {},
      });
      expect(result).toMatchObject({ kind: "rejected" });
      expect((result as { reason: string }).reason).toContain("does-not-exist");
    });

    it("returns kind: rejected (mapped from ConcurrencyRejectedError, not a thrown exception) under a reject_new policy with an existing non-terminal run", async () => {
      const workflow = fixtureWorkflow({ id: "boundary-reject-new", concurrency: { key: "{{ inputs.k }}", policy: "reject_new" } });
      await store.workflows.put(workflow);
      const boundary = createRealEngineBoundary(store, engine);
      const trigger = { id: "t1", type: "manual" as const, source: "test", payload: null, receivedAt: new Date().toISOString() };

      const first = await boundary.startRun({ workflowId: workflow.id, trigger, mappedInputs: { k: "shared" } });
      expect(first.kind).toBe("started");

      const second = await boundary.startRun({ workflowId: workflow.id, trigger, mappedInputs: { k: "shared" } });
      expect(second).toMatchObject({ kind: "rejected" });
    });
  });

  describe("resumeDirect / resumeWithSignal", () => {
    it("resumeDirect returns kind: no_match for a runId/stepId with no outstanding wait", async () => {
      const boundary = createRealEngineBoundary(store, engine);
      const result = await boundary.resumeDirect("no-such-run", "no-such-step", {});
      expect(result).toEqual({ kind: "no_match" });
    });

    it("resumeWithSignal returns kind: no_match when no outstanding wait matches the signal's correlationId", async () => {
      const boundary = createRealEngineBoundary(store, engine);
      const result = await boundary.resumeWithSignal({ id: "sig1", name: "some.event", correlationId: "no-match-here", payload: null, receivedAt: new Date().toISOString() });
      expect(result).toEqual({ kind: "no_match" });
    });
  });

  describe("getDueWaits", () => {
    it("passes through to the real engine's getDueWaits — empty when nothing is outstanding", async () => {
      const boundary = createRealEngineBoundary(store, engine);
      const due = await boundary.getDueWaits(new Date().toISOString());
      expect(due).toEqual([]);
    });
  });

  describe("executeClaimedRun", () => {
    it("calls through to the real engine.executeRun — a pending run genuinely executes its steps and completes", async () => {
      const workflow = fixtureWorkflow({ id: "boundary-execute-claimed" });
      await store.workflows.put(workflow);
      const boundary = createRealEngineBoundary(store, engine);
      const started = await boundary.startRun({
        workflowId: workflow.id,
        trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() },
        mappedInputs: {},
      });
      const runId = (started as { runId: string }).runId;

      await boundary.executeClaimedRun(runId, "worker-1");

      const finished = await store.runs.get(runId);
      expect(finished?.status).toBe("completed");
      expect(finished?.trace).toHaveLength(1);
      expect(finished?.trace[0]).toMatchObject({ stepId: "s1", status: "completed" });
    });
  });
});
