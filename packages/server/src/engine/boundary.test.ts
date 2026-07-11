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
import { alwaysAllowCapabilityCheck, createEngine, identityRedactFn, type Engine, type GetGrantedCapabilities } from "@aart/engine";
import { checkCapability, getGrantedCapabilities, normalizeEnvironmentTrustMode } from "@aart/governance";
import type { BlockImplementation, TrustMode, Workflow } from "@aart/types";
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

  describe("startRun — environment threading (AMENDMENTS.md S15, settling the S11/A42 governance-permissiveness finding)", () => {
    it("threads params.environment through to the persisted run — the capability-dispatch chokepoint (architecture §4.6) reads this on every step dispatch", async () => {
      const workflow = fixtureWorkflow({ id: "boundary-env-thread" });
      await store.workflows.put(workflow);
      const boundary = createRealEngineBoundary(store, engine);

      const result = await boundary.startRun({
        workflowId: workflow.id,
        trigger: { id: "t1", type: "webhook", source: "test", payload: null, receivedAt: new Date().toISOString() },
        mappedInputs: {},
        environment: "env_production",
      });
      const runId = (result as { runId: string }).runId;
      const persisted = await store.runs.get(runId);
      expect(persisted?.params?.["environment"]).toBe("env_production");
    });

    it("omitting environment leaves it unset on the run — unchanged, pre-existing behavior for deployment-less triggers", async () => {
      const workflow = fixtureWorkflow({ id: "boundary-env-omit" });
      await store.workflows.put(workflow);
      const boundary = createRealEngineBoundary(store, engine);

      const result = await boundary.startRun({
        workflowId: workflow.id,
        trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() },
        mappedInputs: {},
      });
      const runId = (result as { runId: string }).runId;
      const persisted = await store.runs.get(runId);
      expect(persisted?.params?.["environment"]).toBeUndefined();
      expect(persisted?.approved).toBe(true);
      expect(persisted?.approvalMode).toBe("dev"); // the engine's own pre-existing default, unchanged when no environment resolves
    });

    it("captures RunRecord.approved/approvalMode HONESTLY from the target environment's real config.trustMode, instead of the engine's generic {approved:true, approvalMode:'dev'} default", async () => {
      await store.environments.put({ id: "env_prod", name: "production", config: { trustMode: "production" } });
      const draftWorkflow = fixtureWorkflow({ id: "boundary-env-approvalmode", approval: "draft" });
      await store.workflows.put(draftWorkflow);
      const boundary = createRealEngineBoundary(store, engine);

      const result = await boundary.startRun({
        workflowId: draftWorkflow.id,
        trigger: { id: "t1", type: "webhook", source: "test", payload: null, receivedAt: new Date().toISOString() },
        mappedInputs: {},
        environment: "env_prod",
      });
      const runId = (result as { runId: string }).runId;
      const persisted = await store.runs.get(runId);
      expect(persisted?.approvalMode).toBe("production");
      expect(persisted?.approved).toBe(false); // draft, not approved — an honest audit record, not the generic default's approved:true
    });

    it("an environment with no recognizable config.trustMode normalizes to 'governed', not 'dev' — the same fail-closed default as the direct-run path", async () => {
      await store.environments.put({ id: "env_untyped", name: "untyped", config: {} });
      const workflow = fixtureWorkflow({ id: "boundary-env-untyped" });
      await store.workflows.put(workflow);
      const boundary = createRealEngineBoundary(store, engine);

      const result = await boundary.startRun({
        workflowId: workflow.id,
        trigger: { id: "t1", type: "webhook", source: "test", payload: null, receivedAt: new Date().toISOString() },
        mappedInputs: {},
        environment: "env_untyped",
      });
      const runId = (result as { runId: string }).runId;
      const persisted = await store.runs.get(runId);
      expect(persisted?.approvalMode).toBe("governed");
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

  describe("executeClaimedRun — worker-claimed capability enforcement (AMENDMENTS.md S15, settling the S11/A42 governance-permissiveness finding, 4th entry point)", () => {
    // A dedicated, real-POLICY engine (unlike this file's shared `engine`
    // fixture above, which deliberately uses alwaysAllowCapabilityCheck for
    // every OTHER test in this file) — real @aart/governance
    // checkCapability + a getGrantedCapabilities adapter matching
    // real-context.ts's own shape (trustMode resolved from the target
    // environment when one is given, "governed" ambient default otherwise —
    // mirroring this session's real-context.ts fix rather than the old
    // hardcoded "dev"). Proves the worker-claim entry point
    // (executeClaimedRun — "used by the worker claim loop... once admission
    // control + the race-safe job_queue claim has already won the claim,"
    // this interface's own doc comment) enforces the exact same dispatch-time
    // gating as the direct-run/trigger-intake paths tested above, not a
    // fourth, independently-behaving copy.
    const capabilityBlock: BlockImplementation = {
      manifest: { id: "test.write", version: "1.0.0", capabilities: ["file.write"], inputSchema: {}, outputSchema: {}, description: "declares file.write, mirroring artifact.write's real Medium-risk capability" },
      execute: async () => ({ ok: true }),
    };

    function realPolicyGetGrantedCapabilities(policyStore: AartStore): GetGrantedCapabilities {
      return async (workflow, environment) => {
        let trustMode: TrustMode = "governed"; // ambient default, matching real-context.ts's fixed hardcoded-"dev" bug and spec §17.2's own stated default
        if (environment) {
          const env = await policyStore.environments.get(environment);
          trustMode = normalizeEnvironmentTrustMode(env?.config["trustMode"]);
        }
        return getGrantedCapabilities({ trustMode, approvalState: workflow.approval, capabilityClosure: ["file.write"], riskTier: "Medium" });
      };
    }

    function capabilityWorkflow(overrides: Partial<Workflow> = {}): Workflow {
      return {
        id: overrides.id ?? "boundary-worker-claim-wf",
        name: "Worker-claim capability fixture",
        version: "0.1.0",
        inputs: [],
        outputs: [],
        execution: { type: "workflow", steps: [{ id: "s1", uses: "test.write", with: {} }] },
        approval: "draft",
        gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
        ...overrides,
      };
    }

    it("denies an unapproved draft's capability-bearing step at claim-time dispatch, deployed to a governed environment — capability enforcement isn't bypassed just because a worker (not the direct-run handler) is the one calling executeRun", async () => {
      const policyEngine = createEngine({ store, redact: identityRedactFn, capabilityCheck: checkCapability, getGrantedCapabilities: realPolicyGetGrantedCapabilities(store), blocks: { [capabilityBlock.manifest.id]: capabilityBlock }, now: () => systemClock.now() });
      await store.environments.put({ id: "env_worker_governed", name: "worker-governed", config: { trustMode: "governed" } });
      const workflow = capabilityWorkflow({ id: "boundary-worker-claim-deny" });
      await store.workflows.put(workflow);
      const boundary = createRealEngineBoundary(store, policyEngine);

      const started = await boundary.startRun({
        workflowId: workflow.id,
        trigger: { id: "t1", type: "webhook", source: "test", payload: null, receivedAt: new Date().toISOString() },
        mappedInputs: {},
        environment: "env_worker_governed",
      });
      const runId = (started as { runId: string }).runId;

      await boundary.executeClaimedRun(runId, "worker-1");

      const finished = await store.runs.get(runId);
      expect(finished?.status).toBe("failed");
      expect(finished?.error).toMatch(/not a subset of this run's granted capabilities/);
    });

    it("runs an APPROVED version's identical capability-bearing step to completion via the same worker-claim path", async () => {
      const policyEngine = createEngine({ store, redact: identityRedactFn, capabilityCheck: checkCapability, getGrantedCapabilities: realPolicyGetGrantedCapabilities(store), blocks: { [capabilityBlock.manifest.id]: capabilityBlock }, now: () => systemClock.now() });
      await store.environments.put({ id: "env_worker_governed_2", name: "worker-governed-2", config: { trustMode: "governed" } });
      const workflow = capabilityWorkflow({
        id: "boundary-worker-claim-allow",
        approval: "approved",
        gates: { validate: "passed", readiness: "pending", evals: "waived", riskReview: "waived", humanReview: "passed" },
      });
      await store.workflows.put(workflow);
      const boundary = createRealEngineBoundary(store, policyEngine);

      const started = await boundary.startRun({
        workflowId: workflow.id,
        trigger: { id: "t1", type: "webhook", source: "test", payload: null, receivedAt: new Date().toISOString() },
        mappedInputs: {},
        environment: "env_worker_governed_2",
      });
      const runId = (started as { runId: string }).runId;

      await boundary.executeClaimedRun(runId, "worker-1");

      const finished = await store.runs.get(runId);
      expect(finished?.status).toBe("completed");
    });
  });
});
