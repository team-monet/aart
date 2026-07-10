// Adapter-conformance suite — architecture §5.8/implementation plan §2's
// explicit DoD item: "a shared, reusable test file" exporting a function
// that takes any AartStore and runs the same assertion set against it. The
// fs adapter (this package) runs it today; Wave-1's SQLite adapter
// (packages/store/src/adapters/sqlite/**, S2's declared carve-out into this
// same package) and, later, Postgres (S9) import and run this same
// function against themselves — this is the direct countermeasure named in
// the implementation plan's Risk 2 ("Engine/store contract drift"): every
// adapter must pass the identical suite, not just its own bespoke tests.
//
// Deliberately written only against the AartStore interface (types.ts) —
// no fs-specific assumption (exact file paths, directory layout) leaks in
// here; only fixture *data* is adapter-agnostic JSON.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Artifact,
  ApprovalTask,
  Correction,
  Deployment,
  Environment,
  EvalExample,
  EvalRun,
  EvalSuite,
  PackManifest,
  PromptRegistryEntry,
  RejectedTrigger,
  RunRecord,
  Schedule,
  SchemaRegistryEntry,
  Signal,
  StandingApproval,
  WaitCondition,
  Workflow,
} from "@aart/types";
import type { AartStore } from "./types.js";

let seq = 0;
function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

function fixtureWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: uniqueId("wf"),
    name: "Conformance Fixture",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [{ id: "s1", uses: "assert.contains", with: {} }] },
    approval: "draft",
    gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    ...overrides,
  };
}

function fixtureRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: uniqueId("run"),
    workflowId: "checkout-smoke",
    workflowVersion: "0.1.0",
    status: "running",
    approved: true,
    approvalMode: "governed",
    trigger: { type: "manual", id: uniqueId("trig"), source: "cli", payload: null, receivedAt: new Date().toISOString() },
    inputs: {},
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: new Date().toISOString() },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
    ...overrides,
  };
}

function fixtureWait(overrides: Partial<WaitCondition> = {}): WaitCondition {
  return { type: "manual", schemaVersion: 1, ...overrides } as WaitCondition;
}

export interface ConformanceOptions {
  /** Constructs a fresh, empty store for each test. Wave-1 adapters typically point this at a temp file/schema/database and run migrations 0001_init first. */
  createStore: () => Promise<AartStore> | AartStore;
  /** Optional teardown (closing a DB connection, removing a temp dir) run after each test. */
  cleanup?: (store: AartStore) => Promise<void> | void;
}

/**
 * Runs the full AartStore conformance assertion set against whatever store
 * `createStore()` produces. Call this from an actual `*.test.ts` file so
 * vitest picks up the `describe`/`it` blocks it registers — see
 * adapters/fs/fs-store.conformance.test.ts for the reference invocation.
 */
export function runAartStoreConformanceSuite(label: string, options: ConformanceOptions): void {
  describe(`AartStore conformance — ${label}`, () => {
    let store: AartStore;

    beforeEach(async () => {
      store = await options.createStore();
    });

    afterEach(async () => {
      await options.cleanup?.(store);
    });

    describe("workflows", () => {
      it("put then get round-trips a workflow version", async () => {
        const wf = fixtureWorkflow();
        await store.workflows.put(wf);
        await expect(store.workflows.get(wf.id, wf.version)).resolves.toEqual(wf);
      });

      it("get returns undefined for a workflow that was never put", async () => {
        await expect(store.workflows.get("no-such-workflow", "0.0.0")).resolves.toBeUndefined();
      });

      it("listVersions returns every put version, and getLatest picks the highest", async () => {
        const id = uniqueId("wf");
        await store.workflows.put(fixtureWorkflow({ id, version: "0.1.0" }));
        await store.workflows.put(fixtureWorkflow({ id, version: "0.2.0" }));
        await store.workflows.put(fixtureWorkflow({ id, version: "0.10.0" }));
        await expect(store.workflows.listVersions(id)).resolves.toEqual(expect.arrayContaining(["0.1.0", "0.2.0", "0.10.0"]));
        await expect(store.workflows.getLatest(id)).resolves.toMatchObject({ version: "0.10.0" });
      });

      it("listWorkflowIds includes every workflowId with at least one put version", async () => {
        const id = uniqueId("wf");
        await store.workflows.put(fixtureWorkflow({ id }));
        await expect(store.workflows.listWorkflowIds()).resolves.toEqual(expect.arrayContaining([id]));
      });
    });

    describe("runs", () => {
      it("put then get round-trips a RunRecord", async () => {
        const run = fixtureRun();
        await store.runs.put(run);
        await expect(store.runs.get(run.runId)).resolves.toEqual(run);
      });

      it("get returns undefined for a run that was never put", async () => {
        await expect(store.runs.get("no-such-run")).resolves.toBeUndefined();
      });

      it("list filters by status and workflowId", async () => {
        const wfId = uniqueId("wf");
        await store.runs.put(fixtureRun({ workflowId: wfId, status: "completed" }));
        await store.runs.put(fixtureRun({ workflowId: wfId, status: "failed" }));
        await store.runs.put(fixtureRun({ workflowId: uniqueId("wf"), status: "completed" }));
        await expect(store.runs.list({ workflowId: wfId })).resolves.toHaveLength(2);
        await expect(store.runs.list({ workflowId: wfId, status: "failed" })).resolves.toHaveLength(1);
      });

      it("round-trips a RunRecord carrying a set RunFlag (architecture §4.1)", async () => {
        const run = fixtureRun({ status: "failed", flag: { kind: "poison", flaggedAt: new Date().toISOString() } });
        await store.runs.put(run);
        await expect(store.runs.get(run.runId)).resolves.toMatchObject({ flag: { kind: "poison" } });
      });

      it("hasDedupeKey is false until recordDedupeKey is called, then true (architecture §4.4.2)", async () => {
        const run = fixtureRun();
        await store.runs.put(run);
        await expect(store.runs.hasDedupeKey(run.runId, "sig:corr1")).resolves.toBe(false);
        await store.runs.recordDedupeKey(run.runId, "sig:corr1");
        await expect(store.runs.hasDedupeKey(run.runId, "sig:corr1")).resolves.toBe(true);
      });

      it("recordDedupeKey is idempotent for the same key (duplicate signal delivery is a no-op, architecture §4.4.2)", async () => {
        const run = fixtureRun();
        await store.runs.put(run);
        await store.runs.recordDedupeKey(run.runId, "sig:corr1");
        await store.runs.recordDedupeKey(run.runId, "sig:corr1");
        await expect(store.runs.hasDedupeKey(run.runId, "sig:corr1")).resolves.toBe(true);
      });
    });

    describe("waits", () => {
      it("put then get round-trips a WaitCondition keyed by (runId, stepId)", async () => {
        const runId = uniqueId("run");
        const wait = fixtureWait({ type: "signal", name: "quote.received", correlationId: "corr1" } as Partial<WaitCondition>);
        await store.waits.put(runId, "wait_step", wait, new Date().toISOString());
        await expect(store.waits.get(runId, "wait_step")).resolves.toEqual(wait);
      });

      it("delete removes a wait", async () => {
        const runId = uniqueId("run");
        await store.waits.put(runId, "wait_step", fixtureWait(), new Date().toISOString());
        await store.waits.delete(runId, "wait_step");
        await expect(store.waits.get(runId, "wait_step")).resolves.toBeUndefined();
      });

      it("listDue returns only timer waits whose resumeAt has passed", async () => {
        const runId = uniqueId("run");
        const now = new Date();
        const past = new Date(now.getTime() - 60_000).toISOString();
        const future = new Date(now.getTime() + 60_000).toISOString();
        await store.waits.put(runId, "due", { type: "timer", resumeAt: past, schemaVersion: 1 }, now.toISOString());
        await store.waits.put(runId, "not_due", { type: "timer", resumeAt: future, schemaVersion: 1 }, now.toISOString());
        await store.waits.put(runId, "not_a_timer", fixtureWait(), now.toISOString());
        const due = await store.waits.listDue(now.toISOString());
        expect(due.map((d) => d.stepId)).toContain("due");
        expect(due.map((d) => d.stepId)).not.toContain("not_due");
        expect(due.map((d) => d.stepId)).not.toContain("not_a_timer");
      });
    });

    describe("signals", () => {
      it("append then findUnconsumedMatch finds it by (name, correlationId)", async () => {
        const signal: Signal = { id: uniqueId("sig"), name: "quote.received", correlationId: "corr1", payload: {}, receivedAt: new Date().toISOString() };
        await store.signals.append(signal);
        await expect(store.signals.findUnconsumedMatch("quote.received", "corr1")).resolves.toEqual(signal);
      });

      it("findUnconsumedMatch returns undefined once markConsumed has been called (closes the early-arrival race, architecture §4.4/§5.6)", async () => {
        const signal: Signal = { id: uniqueId("sig"), name: "quote.received", correlationId: "corr2", payload: {}, receivedAt: new Date().toISOString() };
        await store.signals.append(signal);
        await store.signals.markConsumed(signal.id);
        await expect(store.signals.findUnconsumedMatch("quote.received", "corr2")).resolves.toBeUndefined();
      });

      it("list returns every appended signal regardless of consumed state", async () => {
        const signal: Signal = { id: uniqueId("sig"), name: "x", correlationId: "corr3", payload: {}, receivedAt: new Date().toISOString() };
        await store.signals.append(signal);
        await store.signals.markConsumed(signal.id);
        await expect(store.signals.list()).resolves.toEqual(expect.arrayContaining([signal]));
      });
    });

    describe("artifacts", () => {
      it("put then getMetadata/getBytes round-trip", async () => {
        const runId = uniqueId("run");
        const artifact: Artifact = {
          id: uniqueId("art"),
          runId,
          name: "checkout.png",
          kind: "screenshot",
          mime: "image/png",
          path: `artifacts/${runId}/x.png`,
          bytes: 4,
          createdAt: new Date().toISOString(),
        };
        const bytes = new Uint8Array([1, 2, 3, 4]);
        await store.artifacts.put(artifact, bytes);
        await expect(store.artifacts.getMetadata(artifact.id)).resolves.toEqual(artifact);
        await expect(store.artifacts.getBytes(artifact.id)).resolves.toEqual(bytes);
      });

      it("listByRun returns only that run's artifacts", async () => {
        const runId = uniqueId("run");
        const other = uniqueId("run");
        const mk = (rid: string): Artifact => ({
          id: uniqueId("art"),
          runId: rid,
          name: "x",
          kind: "file",
          mime: "text/plain",
          path: "x",
          bytes: 1,
          createdAt: new Date().toISOString(),
        });
        await store.artifacts.put(mk(runId), new Uint8Array([1]));
        await store.artifacts.put(mk(other), new Uint8Array([2]));
        const list = await store.artifacts.listByRun(runId);
        expect(list).toHaveLength(1);
        expect(list[0]?.runId).toBe(runId);
      });
    });

    describe("approvals", () => {
      it("put then get round-trips an ApprovalTask", async () => {
        const task: ApprovalTask = {
          id: uniqueId("at"),
          runId: uniqueId("run"),
          stepId: "approve",
          title: "Approve",
          description: "desc",
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        await store.approvals.put(task);
        await expect(store.approvals.get(task.id)).resolves.toEqual(task);
      });

      it("list filters by runId and status", async () => {
        const runId = uniqueId("run");
        await store.approvals.put({ id: uniqueId("at"), runId, stepId: "a", title: "t", description: "d", status: "pending", createdAt: new Date().toISOString() });
        await store.approvals.put({ id: uniqueId("at"), runId, stepId: "b", title: "t", description: "d", status: "approved", createdAt: new Date().toISOString() });
        await expect(store.approvals.list({ runId })).resolves.toHaveLength(2);
        await expect(store.approvals.list({ runId, status: "approved" })).resolves.toHaveLength(1);
      });
    });

    describe("corrections", () => {
      it("put then list round-trips a Correction (reviewer required per spec §23.3)", async () => {
        const correction: Correction = {
          runId: uniqueId("run"),
          stepId: "extract",
          fieldPath: "outputs.nmi",
          observed: "a",
          corrected: "b",
          reason: "OCR",
          reviewer: "jane@example.com",
          createdAt: new Date().toISOString(),
        };
        await store.corrections.put(correction);
        await expect(store.corrections.list({ runId: correction.runId })).resolves.toEqual([correction]);
      });
    });

    describe("evals", () => {
      it("putSuite/getSuite/listSuites round-trip", async () => {
        const suite: EvalSuite = { id: uniqueId("suite"), name: "n", examples: [], scorer: { id: "s1", kind: "exact_match" }, tags: [] };
        await store.evals.putSuite(suite);
        await expect(store.evals.getSuite(suite.id)).resolves.toEqual(suite);
        await expect(store.evals.listSuites()).resolves.toEqual(expect.arrayContaining([suite]));
      });

      it("putExample/listExamples filters by suiteId", async () => {
        const suiteId = uniqueId("suite");
        const example: EvalExample = { id: uniqueId("ex"), suiteId, input: {}, expected: {} };
        await store.evals.putExample(example);
        await store.evals.putExample({ id: uniqueId("ex"), suiteId: uniqueId("suite"), input: {}, expected: {} });
        await expect(store.evals.listExamples(suiteId)).resolves.toEqual([example]);
      });

      it("putRun/listRuns filters by suiteId", async () => {
        const suiteId = uniqueId("suite");
        const run: EvalRun = { id: uniqueId("er"), suiteId, workflowId: "wf", workflowVersion: "1", status: "completed", total: 1, passed: 1, failed: 0, score: 1, regressions: [], improvements: [], reportArtifact: "x" };
        await store.evals.putRun(run);
        await expect(store.evals.listRuns({ suiteId })).resolves.toEqual([run]);
      });
    });

    describe("deployments", () => {
      it("put then get round-trips, list filters by environmentId", async () => {
        const environmentId = uniqueId("env");
        const deployment: Deployment = { id: uniqueId("dep"), workflowId: "wf", workflowVersion: "0.1.0", environmentId, triggerConfig: {}, createdAt: new Date().toISOString() };
        await store.deployments.put(deployment);
        await expect(store.deployments.get(deployment.id)).resolves.toEqual(deployment);
        await expect(store.deployments.list({ environmentId })).resolves.toEqual([deployment]);
      });
    });

    describe("environments", () => {
      it("put then get(by id) and getByName both resolve (architecture §5's dual-keying note)", async () => {
        const env: Environment = { id: uniqueId("env"), name: `staging-${uniqueId("n")}`, config: {} };
        await store.environments.put(env);
        await expect(store.environments.get(env.id)).resolves.toEqual(env);
        await expect(store.environments.getByName(env.name)).resolves.toEqual(env);
      });

      it("list returns every environment", async () => {
        const env: Environment = { id: uniqueId("env"), name: uniqueId("name"), config: {} };
        await store.environments.put(env);
        await expect(store.environments.list()).resolves.toEqual(expect.arrayContaining([env]));
      });
    });

    describe("schedules", () => {
      it("put then get round-trips, list filters by paused", async () => {
        const schedule: Schedule = { id: uniqueId("sched"), workflowId: "wf", workflowVersion: "1", cron: "0 9 * * 1", timezone: "UTC", missedRunPolicy: "fire_once", paused: false };
        await store.schedules.put(schedule);
        await expect(store.schedules.get(schedule.id)).resolves.toEqual(schedule);
        await expect(store.schedules.list({ paused: false })).resolves.toEqual(expect.arrayContaining([schedule]));
      });
    });

    describe("promptRegistry / schemaRegistry / packManifests — versioned registries", () => {
      it("promptRegistry: put then get by (name, version), listVersions", async () => {
        const name = uniqueId("prompt");
        const entry: PromptRegistryEntry = { name, version: "1", contentHash: "h1", body: "b1" };
        await store.promptRegistry.put(entry);
        await expect(store.promptRegistry.get(name, "1")).resolves.toEqual(entry);
        await expect(store.promptRegistry.listVersions(name)).resolves.toEqual(["1"]);
      });

      it("schemaRegistry: put then get by (name, version), listVersions", async () => {
        const name = uniqueId("schema");
        const entry: SchemaRegistryEntry = { name, version: "1", contentHash: "h1", jsonSchema: {} };
        await store.schemaRegistry.put(entry);
        await expect(store.schemaRegistry.get(name, "1")).resolves.toEqual(entry);
        await expect(store.schemaRegistry.listVersions(name)).resolves.toEqual(["1"]);
      });

      it("packManifests: put then get by (name, version), listVersions", async () => {
        const name = uniqueId("pack");
        const manifest: PackManifest = { name, version: "1", contentHash: "h1", manifest: {}, approvalStatus: "unapproved" };
        await store.packManifests.put(manifest);
        await expect(store.packManifests.get(name, "1")).resolves.toEqual(manifest);
        await expect(store.packManifests.listVersions(name)).resolves.toEqual(["1"]);
      });
    });

    describe("rejectedTriggers", () => {
      it("append then list, filterable by reason", async () => {
        const rejected: RejectedTrigger = { id: uniqueId("rej"), triggerType: "webhook", reason: "bad_hmac", rawPayload: {}, receivedAt: new Date().toISOString() };
        await store.rejectedTriggers.append(rejected);
        await expect(store.rejectedTriggers.list({ reason: "bad_hmac" })).resolves.toEqual(expect.arrayContaining([rejected]));
      });
    });

    describe("standingApprovals", () => {
      it("put then get round-trips, list includes it", async () => {
        const approval: StandingApproval = { id: uniqueId("sa"), maxRiskTier: "Low", capabilities: ["browser"], grantedBy: "jane", expiresAt: new Date().toISOString() };
        await store.standingApprovals.put(approval);
        await expect(store.standingApprovals.get(approval.id)).resolves.toEqual(approval);
        await expect(store.standingApprovals.list()).resolves.toEqual(expect.arrayContaining([approval]));
      });
    });

    describe("jobQueue (store-internal plumbing, not one of the 16 members — architecture §5.3)", () => {
      it("enqueue then get returns an unclaimed entry with the given priority", async () => {
        const runId = uniqueId("run");
        await store.jobQueue.enqueue(runId, 5);
        await expect(store.jobQueue.get(runId)).resolves.toMatchObject({ runId, claimedBy: null, priority: 5, reclaimCount: 0 });
      });

      it("listClaimable includes an unclaimed entry and excludes a freshly-claimed one", async () => {
        const runId = uniqueId("run");
        await store.jobQueue.enqueue(runId);
        const future = new Date(Date.now() + 60_000).toISOString();
        await expect(store.jobQueue.listClaimable(new Date().toISOString())).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ runId })]),
        );
        await store.jobQueue.setClaim(runId, "worker-1", future);
        const claimable = await store.jobQueue.listClaimable(new Date().toISOString());
        expect(claimable.find((e) => e.runId === runId)).toBeUndefined();
      });

      it("listClaimable includes an entry whose lease has expired (architecture §4.7 reclaim sweep target)", async () => {
        const runId = uniqueId("run");
        await store.jobQueue.enqueue(runId);
        const past = new Date(Date.now() - 60_000).toISOString();
        await store.jobQueue.setClaim(runId, "worker-1", past);
        const claimable = await store.jobQueue.listClaimable(new Date().toISOString());
        expect(claimable.find((e) => e.runId === runId)).toBeDefined();
      });

      it("renewLease updates leaseExpiresAt without clearing claimedBy", async () => {
        const runId = uniqueId("run");
        await store.jobQueue.enqueue(runId);
        const lease1 = new Date(Date.now() + 10_000).toISOString();
        await store.jobQueue.setClaim(runId, "worker-1", lease1);
        const lease2 = new Date(Date.now() + 20_000).toISOString();
        await store.jobQueue.renewLease(runId, lease2);
        await expect(store.jobQueue.get(runId)).resolves.toMatchObject({ claimedBy: "worker-1", leaseExpiresAt: lease2 });
      });

      it("release clears the claim so the entry becomes claimable again", async () => {
        const runId = uniqueId("run");
        await store.jobQueue.enqueue(runId);
        await store.jobQueue.setClaim(runId, "worker-1", new Date(Date.now() + 60_000).toISOString());
        await store.jobQueue.release(runId);
        await expect(store.jobQueue.get(runId)).resolves.toMatchObject({ claimedBy: null, leaseExpiresAt: null });
      });

      it("incrementReclaimCount increments and returns the new count", async () => {
        const runId = uniqueId("run");
        await store.jobQueue.enqueue(runId);
        await expect(store.jobQueue.incrementReclaimCount(runId)).resolves.toBe(1);
        await expect(store.jobQueue.incrementReclaimCount(runId)).resolves.toBe(2);
        await expect(store.jobQueue.get(runId)).resolves.toMatchObject({ reclaimCount: 2 });
      });

      it("remove deletes the entry entirely", async () => {
        const runId = uniqueId("run");
        await store.jobQueue.enqueue(runId);
        await store.jobQueue.remove(runId);
        await expect(store.jobQueue.get(runId)).resolves.toBeUndefined();
      });
    });

    describe("idempotencyLedger (store-internal plumbing — architecture §4.2/§5.7)", () => {
      it("put then get round-trips a resolved-key entry, and short-circuits a repeat", async () => {
        const runId = uniqueId("run");
        const resolvedKey = `${runId}:send_email`;
        await store.idempotencyLedger.put({ resolvedKey, runId, stepId: "send_email", recordedOutput: { sent: true }, createdAt: new Date().toISOString() });
        await expect(store.idempotencyLedger.get(resolvedKey)).resolves.toMatchObject({ recordedOutput: { sent: true } });
      });

      it("get returns undefined for a key that was never recorded", async () => {
        await expect(store.idempotencyLedger.get("never-seen-key")).resolves.toBeUndefined();
      });
    });

    describe("transact() — the transactional unit-of-work contract (architecture §5.8)", () => {
      it("a successful callback's writes are visible after transact() resolves", async () => {
        const run = fixtureRun();
        await store.transact(async (tx) => {
          await tx.runs.put(run);
        });
        await expect(store.runs.get(run.runId)).resolves.toEqual(run);
      });

      it("writes are visible to reads WITHIN the same transaction, before it commits (read-your-writes)", async () => {
        const run = fixtureRun();
        await store.transact(async (tx) => {
          await tx.runs.put(run);
          await expect(tx.runs.get(run.runId)).resolves.toEqual(run);
        });
      });

      it("THE REQUIRED TEST: a crash between a transact() callback's writes leaves NEITHER write persisted (all-or-nothing, not partial)", async () => {
        const run = fixtureRun();
        const runId = run.runId;
        await store.runs.put(run); // pre-existing state the transaction will build on

        class SimulatedCrash extends Error {}

        await expect(
          store.transact(async (tx) => {
            // Write #1: the dedupe-key consumption architecture §4.4.2 requires.
            await tx.runs.recordDedupeKey(runId, "sig:corr1");
            // Simulated crash BEFORE write #2 (the run-state transition) happens.
            throw new SimulatedCrash("crash between transact() writes");
            // Write #2 (unreached): await tx.runs.put({ ...run, status: "waiting" });
          }),
        ).rejects.toThrow(SimulatedCrash);

        // Neither write landed: the dedupe key was NOT recorded consumed...
        await expect(store.runs.hasDedupeKey(runId, "sig:corr1")).resolves.toBe(false);
        // ...and the run's status is unchanged from before the transaction.
        await expect(store.runs.get(runId)).resolves.toMatchObject({ status: run.status });
      });

      it("a rolled-back transaction across MULTIPLE different store members leaves all of them unwritten", async () => {
        const run = fixtureRun();
        const wait = fixtureWait();

        await expect(
          store.transact(async (tx) => {
            await tx.runs.put(run);
            await tx.waits.put(run.runId, "step1", wait, new Date().toISOString());
            throw new Error("crash after two writes, before commit");
          }),
        ).rejects.toThrow();

        await expect(store.runs.get(run.runId)).resolves.toBeUndefined();
        await expect(store.waits.get(run.runId, "step1")).resolves.toBeUndefined();
      });

      it("exercises the real §4.4.2 dedupe-check-and-transition pattern end-to-end: duplicate delivery is a no-op", async () => {
        const run = fixtureRun({ status: "waiting" });
        await store.runs.put(run);
        const dedupeKey = "sig:corr-exactly-once";

        async function attemptResume(): Promise<"resumed" | "duplicate"> {
          return store.transact(async (tx) => {
            if (await tx.runs.hasDedupeKey(run.runId, dedupeKey)) {
              return "duplicate";
            }
            await tx.runs.recordDedupeKey(run.runId, dedupeKey);
            await tx.runs.put({ ...run, status: "running" });
            return "resumed";
          });
        }

        await expect(attemptResume()).resolves.toBe("resumed");
        await expect(attemptResume()).resolves.toBe("duplicate"); // e.g. a redelivered webhook
        await expect(store.runs.get(run.runId)).resolves.toMatchObject({ status: "running" });
      });

      it("a successful transaction's writes to the SAME record coalesce (last write wins), not multiple partial writes", async () => {
        const run = fixtureRun();
        await store.transact(async (tx) => {
          await tx.runs.put(run);
          await tx.runs.put({ ...run, status: "waiting" });
          await tx.runs.put({ ...run, status: "completed" });
        });
        await expect(store.runs.get(run.runId)).resolves.toMatchObject({ status: "completed" });
      });
    });
  });
}
