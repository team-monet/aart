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
  EventLogEntry,
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

      it("keeps active operational state separate from the public run and preserves it across audit writes", async () => {
        const run = fixtureRun({
          inputs: { token: "[REDACTED]" },
        });
        const operationalRun = {
          ...run,
          inputs: { token: "exact-secret" },
        };
        await store.runs.put(run);
        await store.runs.putOperationalState(run.runId, {
          run: operationalRun,
          resolvedSecretValues: ["exact-secret"],
        });

        await store.runs.put({
          ...run,
          updatedAt: "audit-write",
        });
        await expect(
          store.runs.getOperationalState(run.runId),
        ).resolves.toEqual({
          run: operationalRun,
          resolvedSecretValues: ["exact-secret"],
        });
        await expect(store.runs.get(run.runId)).resolves.toMatchObject({
          inputs: { token: "[REDACTED]" },
          updatedAt: "audit-write",
        });

        const progressed = {
          ...operationalRun,
          updatedAt: "progressed",
        };
        await store.runs.replaceOperationalState(run.runId, {
          run: progressed,
          resolvedSecretValues: ["exact-secret"],
        });
        await expect(
          store.runs.getOperationalState(run.runId),
        ).resolves.toMatchObject({
          run: { updatedAt: "progressed" },
        });

        await store.runs.deleteOperationalState(run.runId);
        await expect(
          store.runs.getOperationalState(run.runId),
        ).resolves.toBeUndefined();
      });

      it("round-trips persisted input and trigger secret-taint paths", async () => {
        const run = fixtureRun({
          secretTaintedInputPaths: ["/token"],
          secretTaintedTriggerPaths: ["*"],
        });
        await store.runs.put(run);
        await expect(store.runs.get(run.runId)).resolves.toMatchObject({
          secretTaintedInputPaths: ["/token"],
          secretTaintedTriggerPaths: ["*"],
        });
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

      it("redacts the wait audit while preserving exact signal matching through a one-way key", async () => {
        const runId = uniqueId("run");
        const wait: WaitCondition = {
          type: "signal",
          name: "quote.received",
          correlationId: "late-secret-correlation",
          schemaVersion: 1,
        };
        await store.waits.put(
          runId,
          "wait_step",
          wait,
          new Date().toISOString(),
        );
        await store.waits.redactAudit(runId, "wait_step", {
          ...wait,
          correlationId: "[REDACTED]",
        });

        await expect(store.waits.list()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runId,
              stepId: "wait_step",
              wait: {
                ...wait,
                correlationId: "[REDACTED]",
              },
            }),
          ]),
        );
        await expect(
          store.waits.findSignalMatches(
            "quote.received",
            "late-secret-correlation",
          ),
        ).resolves.toEqual([{ runId, stepId: "wait_step" }]);
      });

      it("keeps redacted audit values separate from sealed operational scheduling values", async () => {
        const runId = uniqueId("run");
        const resumeAt = new Date(Date.now() - 60_000).toISOString();
        const wait: WaitCondition = {
          type: "timer",
          resumeAt,
          schemaVersion: 1,
        };
        await store.waits.put(
          runId,
          "timer_step",
          wait,
          new Date().toISOString(),
        );
        await store.waits.redactAudit(runId, "timer_step", {
          ...wait,
          resumeAt: "[REDACTED]",
        });
        await expect(
          store.waits.list({ runId }),
        ).resolves.toEqual([
          expect.objectContaining({
            wait: { ...wait, resumeAt: "[REDACTED]" },
          }),
        ]);
        await expect(
          store.waits.listOperational({ runId, type: "timer" }),
        ).resolves.toEqual([
          expect.objectContaining({ wait }),
        ]);
        await expect(
          store.waits.listDue(new Date().toISOString()),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runId,
              stepId: "timer_step",
              wait: { ...wait, resumeAt: "[REDACTED]" },
            }),
          ]),
        );
      });

      it("round-trips and replaces sealed run continuation state independently of the wait audit", async () => {
        const run = fixtureRun({
          status: "waiting",
          inputs: { token: "raw-secret" },
        });
        const wait = fixtureWait();
        await store.waits.put(
          run.runId,
          "pause",
          wait,
          new Date().toISOString(),
          {
            run,
            resolvedSecretValues: ["raw-secret"],
          },
        );
        await expect(
          store.waits.getOperationalRunState(
            run.runId,
            "pause",
          ),
        ).resolves.toEqual({
          run,
          resolvedSecretValues: ["raw-secret"],
        });

        const updated = {
          run: {
            ...run,
            trace: [
              {
                seq: 0,
                stepId: "source",
                block: "test.source",
                status: "completed" as const,
                inputs: {},
                outputs: { token: "raw-secret" },
                secretTainted: true,
                secretTaintedPaths: ["*"],
                startedAt: new Date().toISOString(),
              },
            ],
          },
          resolvedSecretValues: [
            "raw-secret",
            "second-secret",
          ],
        };
        await store.waits.replaceOperationalRunState(
          run.runId,
          updated,
        );
        await expect(
          store.waits.getOperationalRunState(
            run.runId,
            "pause",
          ),
        ).resolves.toEqual(updated);
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

      it("markConsumed can replace the persisted audit payload", async () => {
        const signal: Signal = {
          id: uniqueId("sig"),
          name: "x",
          correlationId: "corr-redacted",
          payload: { token: "plaintext" },
          receivedAt: new Date().toISOString(),
        };
        await store.signals.append(signal);
        await store.signals.markConsumed(signal.id, {
          payload: { token: "[REDACTED]" },
        });
        await expect(store.signals.list()).resolves.toEqual(
          expect.arrayContaining([
            { ...signal, payload: { token: "[REDACTED]" } },
          ]),
        );
        await expect(
          store.signals.findUnconsumedMatch("x", "corr-redacted"),
        ).resolves.toBeUndefined();
      });

      it("records the consuming run without exposing provenance in the public Signal shape", async () => {
        const runId = uniqueId("run");
        const signal: Signal = {
          id: uniqueId("sig"),
          name: "x",
          correlationId: uniqueId("corr"),
          payload: { token: "plaintext" },
          receivedAt: new Date().toISOString(),
        };
        await store.signals.append(signal);
        await store.signals.markConsumed(signal.id, {
          consumedBy: { runId, stepId: "pause" },
        });
        await expect(
          store.signals.listConsumedByRun(runId),
        ).resolves.toEqual([signal]);
        await expect(store.signals.list()).resolves.toEqual(
          expect.arrayContaining([signal]),
        );
      });

      it("replaces every consumed-signal audit field while preserving identity and consumption", async () => {
        const signal: Signal = {
          id: uniqueId("sig"),
          name: "late-secret",
          correlationId: "late-secret",
          payload: { value: "late-secret" },
          receivedAt: new Date().toISOString(),
        };
        await store.signals.append(signal);
        await store.signals.markConsumed(signal.id, {
          consumedBy: { runId: uniqueId("run"), stepId: "pause" },
        });
        await store.signals.replaceAudit(signal.id, {
          name: "[REDACTED]",
          correlationId: "[REDACTED]",
          payload: { value: "[REDACTED]" },
        });
        await expect(store.signals.list()).resolves.toEqual(
          expect.arrayContaining([
            {
              ...signal,
              name: "[REDACTED]",
              correlationId: "[REDACTED]",
              payload: { value: "[REDACTED]" },
            },
          ]),
        );
        await expect(
          store.signals.findUnconsumedMatch(
            "[REDACTED]",
            "[REDACTED]",
          ),
        ).resolves.toBeUndefined();
      });

      it("redacts an unconsumed signal audit without breaking its exact early-arrival match", async () => {
        const signal: Signal = {
          id: uniqueId("sig"),
          name: "late-secret-name",
          correlationId: "late-secret-correlation",
          payload: { value: "late-secret-payload" },
          receivedAt: new Date().toISOString(),
        };
        await store.signals.append(signal);
        await store.signals.replaceAudit(signal.id, {
          name: "[REDACTED]",
          correlationId: "[REDACTED]",
          payload: { value: "[REDACTED]" },
        }, ["late-secret-name", "late-secret-correlation"]);

        await expect(store.signals.list()).resolves.toEqual(
          expect.arrayContaining([
            {
              ...signal,
              name: "[REDACTED]",
              correlationId: "[REDACTED]",
              payload: { value: "[REDACTED]" },
            },
          ]),
        );
        await expect(
          store.signals.findUnconsumedMatch(
            signal.name,
            signal.correlationId,
          ),
        ).resolves.toEqual(signal);
        await expect(
          store.signals.getOperationalSecretValues(signal.id),
        ).resolves.toEqual([
          "late-secret-name",
          "late-secret-correlation",
        ]);
        await expect(
          store.signals.findUnconsumedMatch(
            "[REDACTED]",
            "[REDACTED]",
          ),
        ).resolves.toBeUndefined();
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
        await expect(store.artifacts.list()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ runId }),
            expect.objectContaining({ runId: other }),
          ]),
        );
      });

      it("replaces artifact audit metadata and text bytes without changing structural ownership", async () => {
        const runId = uniqueId("run");
        const artifact: Artifact = {
          id: uniqueId("art"),
          runId,
          stepId: "capture",
          name: "late-secret",
          kind: "late-secret",
          mime: "text/late-secret",
          path: "late-secret/report.txt",
          bytes: 11,
          createdAt: new Date().toISOString(),
        };
        await store.artifacts.put(
          artifact,
          new TextEncoder().encode("late-secret"),
        );
        await expect(
          store.artifacts.isTextEligible(artifact.id),
        ).resolves.toBe(true);
        const updated = await store.artifacts.replaceAudit(
          artifact.id,
          {
            name: "[REDACTED]",
            kind: "[REDACTED]",
            mime: "[REDACTED]",
            path: "[REDACTED]",
          },
          new TextEncoder().encode("[REDACTED]"),
        );
        expect(updated).toEqual({
          ...artifact,
          name: "[REDACTED]",
          kind: "[REDACTED]",
          mime: "[REDACTED]",
          path: "[REDACTED]",
          bytes: new TextEncoder().encode("[REDACTED]").byteLength,
        });
        await expect(
          store.artifacts.isTextEligible(artifact.id),
        ).resolves.toBe(true);
        await expect(
          store.artifacts.getBytes(artifact.id),
        ).resolves.toEqual(new TextEncoder().encode("[REDACTED]"));
      });

      it("retains text eligibility captured before the public MIME is redacted", async () => {
        const runId = uniqueId("run");
        const artifact: Artifact = {
          id: uniqueId("art"),
          runId,
          name: "result.txt",
          kind: "report",
          mime: "[REDACTED]",
          path: `artifacts/${runId}/result.txt`,
          bytes: 12,
          createdAt: new Date().toISOString(),
        };
        await store.artifacts.put(
          artifact,
          new TextEncoder().encode("future-value"),
          { redactionTextEligible: true },
        );

        await expect(
          store.artifacts.isTextEligible(artifact.id),
        ).resolves.toBe(true);
      });

      it("withholds a secret-sized artifact from every public surface while retaining its repair source", async () => {
        const runId = uniqueId("run");
        const artifact: Artifact = {
          id: uniqueId("art"),
          runId,
          name: "secret-sized.bin",
          kind: "file",
          mime: "application/octet-stream",
          path: `artifacts/${runId}/secret-sized.bin`,
          bytes: 4,
          createdAt: new Date().toISOString(),
        };
        const bytes = new Uint8Array([1, 2, 3, 4]);
        await store.artifacts.put(artifact, bytes);

        await store.artifacts.replaceAudit(
          artifact.id,
          {
            name: artifact.name,
            kind: artifact.kind,
            mime: artifact.mime,
            path: artifact.path,
          },
          undefined,
          { auditVisible: false },
        );

        await expect(
          store.artifacts.getMetadata(artifact.id),
        ).resolves.toBeUndefined();
        await expect(
          store.artifacts.getBytes(artifact.id),
        ).resolves.toBeUndefined();
        await expect(store.artifacts.list()).resolves.not.toContainEqual(
          expect.objectContaining({ id: artifact.id }),
        );
        await expect(
          store.artifacts.listByRun(runId),
        ).resolves.not.toContainEqual(
          expect.objectContaining({ id: artifact.id }),
        );
        await expect(
          store.artifacts.listForRedaction(runId),
        ).resolves.toContainEqual({
          artifact,
          auditVisible: false,
        });
        await expect(
          store.artifacts.getBytesForRedaction(artifact.id),
        ).resolves.toEqual(bytes);

        await store.artifacts.replaceAudit(artifact.id, {
          name: "repaired.bin",
          kind: artifact.kind,
          mime: artifact.mime,
          path: artifact.path,
        });
        await expect(
          store.artifacts.getMetadata(artifact.id),
        ).resolves.toBeUndefined();
        await expect(
          store.artifacts.listForRedaction(runId),
        ).resolves.toContainEqual({
          artifact: { ...artifact, name: "repaired.bin" },
          auditVisible: false,
        });
      });

      it("can withhold an artifact atomically on its initial write", async () => {
        const runId = uniqueId("run");
        const artifact: Artifact = {
          id: uniqueId("art"),
          runId,
          name: "withheld-at-source.bin",
          kind: "file",
          mime: "application/octet-stream",
          path: `artifacts/${runId}/withheld-at-source.bin`,
          bytes: 3,
          createdAt: new Date().toISOString(),
        };
        const bytes = new Uint8Array([7, 8, 9]);

        await store.artifacts.put(artifact, bytes, {
          auditVisible: false,
        });

        await expect(
          store.artifacts.getMetadata(artifact.id),
        ).resolves.toBeUndefined();
        await expect(
          store.artifacts.getBytes(artifact.id),
        ).resolves.toBeUndefined();
        await expect(
          store.artifacts.listByRun(runId),
        ).resolves.toEqual([]);
        await expect(
          store.artifacts.listForRedaction(runId),
        ).resolves.toContainEqual({
          artifact,
          auditVisible: false,
        });
        await expect(
          store.artifacts.getBytesForRedaction(artifact.id),
        ).resolves.toEqual(bytes);
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

      // D2a security hardening, token-derived attribution (AMENDMENTS.md
      // A59) — an additive optional field (same pattern as A56's own
      // `promoted` round-trip test above); every adapter must round-trip
      // both "set" and "omitted" losslessly, never collapsing an omitted
      // value into an empty string.
      it("authenticatedAs round-trips when set, and stays undefined when omitted", async () => {
        const base = { runId: uniqueId("run"), stepId: "approve", title: "Approve", description: "desc", status: "pending" as const, createdAt: new Date().toISOString() };
        const withAuth: ApprovalTask = { ...base, id: uniqueId("at"), authenticatedAs: "deploy-token" };
        await store.approvals.put(withAuth);
        await expect(store.approvals.get(withAuth.id)).resolves.toEqual(withAuth);

        const withoutAuth: ApprovalTask = { ...base, id: uniqueId("at") };
        await store.approvals.put(withoutAuth);
        await expect(store.approvals.get(withoutAuth.id)).resolves.toEqual(withoutAuth);
        await expect(store.approvals.get(withoutAuth.id)).resolves.not.toHaveProperty("authenticatedAs", "");
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

      it("replaceAudit moves a correction whose redacted fieldPath changes its store key", async () => {
        const correction: Correction = {
          runId: uniqueId("run"),
          stepId: "extract",
          fieldPath: "outputs.late-secret",
          observed: "late-secret",
          corrected: "late-secret",
          reason: "late-secret",
          reviewer: "late-secret",
          createdAt: new Date().toISOString(),
        };
        // A pre-migration row has no sealed target. Its first retrospective
        // repair must capture the exact identity before moving the public
        // audit to a redacted key.
        await store.corrections.put(correction);
        const replacement =
          await store.corrections.replaceAudit(correction, {
            fieldPath: "outputs.[REDACTED]",
            observed: "[REDACTED]",
            corrected: "[REDACTED]",
            reason: "[REDACTED]",
            reviewer: "[REDACTED]",
          });
        expect(replacement).toMatchObject({
          fieldPath: "outputs.[REDACTED]",
        });
        await expect(
          store.corrections.list({ runId: correction.runId }),
        ).resolves.toEqual([
          {
            ...correction,
            fieldPath: "outputs.[REDACTED]",
            observed: "[REDACTED]",
            corrected: "[REDACTED]",
            reason: "[REDACTED]",
            reviewer: "[REDACTED]",
          },
        ]);
        await expect(
          store.corrections.getOperationalTarget(
            replacement!,
          ),
        ).resolves.toEqual({
          stepId: correction.stepId,
          fieldPath: correction.fieldPath,
        });
        await expect(
          store.corrections.findByOperationalTarget(
            correction.runId,
            correction.stepId,
            correction.fieldPath,
          ),
        ).resolves.toEqual(replacement);
      });

      it("replaceAudit preserves colliding redacted corrections without deriving a suffix from the secret path", async () => {
        const runId = uniqueId("run");
        const first: Correction = {
          runId,
          stepId: "extract",
          fieldPath: "outputs.first-secret",
          observed: "first-secret",
          corrected: "a",
          reason: "repair",
          reviewer: "reviewer",
          createdAt: "2026-01-01T00:00:00.000Z",
        };
        const second: Correction = {
          ...first,
          fieldPath: "outputs.second-secret",
          observed: "second-secret",
          corrected: "b",
          createdAt: "2026-01-01T00:00:01.000Z",
        };
        await store.corrections.put(first);
        await store.corrections.put(second);
        for (const correction of [first, second]) {
          await store.corrections.replaceAudit(correction, {
            fieldPath: "outputs.[REDACTED]",
            observed: "[REDACTED]",
            corrected: correction.corrected,
            reason: correction.reason,
            reviewer: correction.reviewer,
          });
        }
        const repaired = await store.corrections.list({ runId });
        expect(repaired).toHaveLength(2);
        expect(repaired.map((entry) => entry.fieldPath).sort()).toEqual([
          "outputs.[REDACTED]",
          "outputs.[REDACTED]#2",
        ]);
        expect(JSON.stringify(repaired)).not.toContain("first-secret");
        expect(JSON.stringify(repaired)).not.toContain("second-secret");
        await expect(
          store.corrections.findByOperationalTarget(
            runId,
            first.stepId,
            first.fieldPath,
          ),
        ).resolves.toMatchObject({
          fieldPath: "outputs.[REDACTED]",
        });
        await expect(
          store.corrections.findByOperationalTarget(
            runId,
            second.stepId,
            second.fieldPath,
          ),
        ).resolves.toMatchObject({
          fieldPath: "outputs.[REDACTED]#2",
        });
      });
    });

    describe("evals", () => {
      it("putSuite/getSuite/listSuites round-trip", async () => {
        const suite: EvalSuite = { id: uniqueId("suite"), name: "n", examples: [], scorer: { id: "s1", kind: "exact_match" }, tags: [] };
        await store.evals.putSuite(suite);
        await expect(store.evals.getSuite(suite.id)).resolves.toEqual(suite);
        await expect(store.evals.listSuites()).resolves.toEqual(expect.arrayContaining([suite]));
      });

      it("replaceExampleAudit atomically moves an example id", async () => {
        const example: EvalExample = {
          id: uniqueId("example"),
          suiteId: uniqueId("suite"),
          input: { value: "secret" },
          expected: "secret",
        };
        await store.evals.putExample(example);
        const repaired = {
          ...example,
          id: uniqueId("example-safe"),
          input: { value: "[REDACTED]" },
          expected: "[REDACTED]",
        };

        await store.evals.replaceExampleAudit(
          example.id,
          repaired,
        );

        await expect(
          store.evals.listExamples(example.suiteId),
        ).resolves.toEqual([repaired]);
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

      // D1 "remotes + push" (AMENDMENTS.md A56) — `promoted` is a tri-state
      // field (undefined/true/false); every adapter must round-trip all
      // three states losslessly, in particular never collapsing an omitted
      // `promoted` into `false` on the way back out (sqlite's own migration
      // test covers the NULL-column-on-a-pre-existing-row case specifically;
      // this proves the ordinary put/get path on every adapter).
      it("promoted round-trips undefined/true/false without collapsing undefined to false", async () => {
        const environmentId = uniqueId("env");
        const base = { workflowId: "wf", workflowVersion: "0.1.0", environmentId, triggerConfig: {}, createdAt: new Date().toISOString() };
        const omitted: Deployment = { ...base, id: uniqueId("dep") };
        const active: Deployment = { ...base, id: uniqueId("dep"), promoted: true };
        const inactive: Deployment = { ...base, id: uniqueId("dep"), promoted: false };

        await store.deployments.put(omitted);
        await store.deployments.put(active);
        await store.deployments.put(inactive);

        await expect(store.deployments.get(omitted.id)).resolves.toEqual(omitted);
        expect((await store.deployments.get(omitted.id))?.promoted).toBeUndefined();
        await expect(store.deployments.get(active.id)).resolves.toEqual(active);
        await expect(store.deployments.get(inactive.id)).resolves.toEqual(inactive);
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
        await expect(store.packManifests.listNames()).resolves.toContain(name);

        const delimitedName = `${name}__shared`;
        await store.packManifests.put({ ...manifest, name: delimitedName });
        await expect(store.packManifests.listNames()).resolves.toContain(delimitedName);
      });
    });

    describe("rejectedTriggers", () => {
      it("append then list, filterable by reason", async () => {
        const rejected: RejectedTrigger = { id: uniqueId("rej"), triggerType: "webhook", reason: "bad_hmac", rawPayload: {}, receivedAt: new Date().toISOString() };
        await store.rejectedTriggers.append(rejected);
        await expect(store.rejectedTriggers.list({ reason: "bad_hmac" })).resolves.toEqual(expect.arrayContaining([rejected]));
      });
    });

    describe("events (V1 event log foundation — AMENDMENTS.md A61)", () => {
      it("append then list round-trips an EventLogEntry, including every optional correlation field", async () => {
        const entry: EventLogEntry = {
          id: uniqueId("evt"),
          type: "deployment.promoted",
          occurredAt: new Date().toISOString(),
          summary: "invoice-scan@0.3.0 promoted to production",
          workflowId: "invoice-scan",
          workflowVersion: "0.3.0",
          runId: uniqueId("run"),
          deploymentId: uniqueId("dep"),
          environmentId: uniqueId("env"),
          approvalTaskId: uniqueId("at"),
          actor: "deploy-token",
        };
        await store.events.append(entry);
        await expect(store.events.list()).resolves.toEqual(expect.arrayContaining([entry]));
      });

      it("replaceAudit rewrites data fields without changing event identity or ordering", async () => {
        const entry: EventLogEntry = {
          id: uniqueId("evt"),
          type: "approval.decided",
          occurredAt: new Date().toISOString(),
          summary: "approved by late-secret",
          runId: uniqueId("run"),
          actor: "late-secret",
        };
        await store.events.append(entry);
        await store.events.replaceAudit(entry.id, {
          summary: "approved by [REDACTED]",
          actor: "[REDACTED]",
        });
        await expect(store.events.list()).resolves.toEqual(
          expect.arrayContaining([
            {
              ...entry,
              summary: "approved by [REDACTED]",
              actor: "[REDACTED]",
            },
          ]),
        );
      });

      it("append then list round-trips an EventLogEntry with every correlation field omitted — never collapsed into an explicit undefined/null value", async () => {
        const entry: EventLogEntry = { id: uniqueId("evt"), type: "eval.suite_created", occurredAt: new Date().toISOString(), summary: "eval suite created" };
        await store.events.append(entry);
        const [found] = (await store.events.list()).filter((e) => e.id === entry.id);
        // toEqual treats {} and {workflowId: undefined} as equal, but NOT
        // {} and {workflowId: "surprise"} — this is what actually proves no
        // stray correlation field leaked a populated value on the round trip.
        expect(found).toEqual(entry);
      });

      it("list returns newest-first (descending occurredAt), regardless of append order", async () => {
        const base = Date.now();
        const older: EventLogEntry = { id: uniqueId("evt"), type: "run.started", occurredAt: new Date(base - 60_000).toISOString(), summary: "older" };
        const newer: EventLogEntry = { id: uniqueId("evt"), type: "run.started", occurredAt: new Date(base).toISOString(), summary: "newer" };
        // Appended oldest-last, deliberately — proves list() sorts, doesn't just echo insertion order.
        await store.events.append(newer);
        await store.events.append(older);
        const list = await store.events.list();
        const olderIndex = list.findIndex((e) => e.id === older.id);
        const newerIndex = list.findIndex((e) => e.id === newer.id);
        expect(newerIndex).toBeLessThan(olderIndex);
      });

      it("list honors since (occurredAt >= since), excluding earlier entries", async () => {
        const base = Date.now();
        const before: EventLogEntry = { id: uniqueId("evt"), type: "run.started", occurredAt: new Date(base - 60_000).toISOString(), summary: "before" };
        const at: EventLogEntry = { id: uniqueId("evt"), type: "run.started", occurredAt: new Date(base).toISOString(), summary: "at" };
        const after: EventLogEntry = { id: uniqueId("evt"), type: "run.started", occurredAt: new Date(base + 60_000).toISOString(), summary: "after" };
        await store.events.append(before);
        await store.events.append(at);
        await store.events.append(after);
        const list = await store.events.list({ since: new Date(base).toISOString() });
        const ids = list.map((e) => e.id);
        expect(ids).toEqual(expect.arrayContaining([at.id, after.id]));
        expect(ids).not.toContain(before.id);
      });

      it("list honors limit, taking the newest N", async () => {
        const base = Date.now();
        const entries: EventLogEntry[] = Array.from({ length: 5 }, (_, i) => ({
          id: uniqueId("evt"),
          type: "run.started",
          occurredAt: new Date(base + i).toISOString(),
          summary: `event ${i}`,
        }));
        for (const entry of entries) await store.events.append(entry);
        const list = await store.events.list({ limit: 2 });
        expect(list).toHaveLength(2);
        // The newest two of the five (index 4 and 3, by construction above).
        expect(list.map((e) => e.id)).toEqual([entries[4]!.id, entries[3]!.id]);
      });

      it("since and limit combine — limit applies AFTER the since filter, not before", async () => {
        const base = Date.now();
        const before: EventLogEntry = { id: uniqueId("evt"), type: "run.started", occurredAt: new Date(base - 60_000).toISOString(), summary: "before" };
        const entries: EventLogEntry[] = Array.from({ length: 3 }, (_, i) => ({
          id: uniqueId("evt"),
          type: "run.started",
          occurredAt: new Date(base + i).toISOString(),
          summary: `event ${i}`,
        }));
        await store.events.append(before);
        for (const entry of entries) await store.events.append(entry);
        const list = await store.events.list({ since: new Date(base).toISOString(), limit: 1 });
        expect(list).toHaveLength(1);
        expect(list[0]?.id).toBe(entries[2]!.id); // the single newest entry at-or-after `since`
      });

      // D2b/V1 fix pass (AMENDMENTS.md A63, FIX 3) — pre-fix, the two
      // adapters DIVERGED on a negative limit instead of just both handling
      // it oddly: fs's `Array.prototype.slice(0, -1)` means "drop the last
      // 1" (so 3 entries -> 2 returned); sqlite's `LIMIT -1` means
      // "unlimited" (so 3 entries -> all 3 returned). Neither matches this
      // fix's chosen contract (a negative limit is never valid input — treat
      // it as "zero," the safe direction, identically on both adapters), so
      // this case fails against BOTH pre-fix adapters, just with two
      // different wrong lengths (2 and 3, never the fixed 0) — verified
      // directly by stashing the two adapters' `list()` methods and
      // re-running this suite before writing the fix.
      it("a negative limit never diverges between adapters — treated as zero, never 'unlimited' nor slice()'s own 'drop the last N' meaning", async () => {
        const base = Date.now();
        const entries: EventLogEntry[] = Array.from({ length: 3 }, (_, i) => ({
          id: uniqueId("evt"),
          type: "run.started",
          occurredAt: new Date(base + i).toISOString(),
          summary: `event ${i}`,
        }));
        for (const entry of entries) await store.events.append(entry);
        await expect(store.events.list({ limit: -1 })).resolves.toEqual([]);
      });

      // D2b/V1 fix pass (AMENDMENTS.md A63, FIX 4) — three events sharing the
      // EXACT same occurredAt (a tight burst — aart_approve's own 3-event
      // emission is the real-world shape this models) have no total order
      // pre-fix: fs falls back to Array.prototype.sort's stability, i.e.
      // whatever order readdir() returned the 3 files in; sqlite falls back
      // to whatever order a plain `ORDER BY occurred_at DESC` scan happens to
      // produce for tied rows. Fixed ids (not uniqueId()) so THIS test
      // controls the expected DESC-by-id tiebreak directly, rather than
      // depending on uniqueId()'s own seq counter (lexicographically
      // fragile across a 9->10 boundary). Appended in a scrambled order
      // deliberately, proving list() imposes its OWN deterministic tiebreak
      // rather than echoing append/readdir order — verified directly by
      // stashing the two adapters' `list()` methods and re-running this
      // suite before writing the fix (both failed: fs returned append order
      // [b, c, a], sqlite returned rowid/insertion order [b, c, a] — neither
      // is the fixed [c, b, a]).
      it("equal-occurredAt entries sort in one stable, adapter-identical order — tiebreak DESC on id, matching the (createdAt || id) discipline used elsewhere in this codebase", async () => {
        const tiedAt = new Date().toISOString();
        const a: EventLogEntry = { id: "evt_tie_a", type: "workflow.approved", occurredAt: tiedAt, summary: "a" };
        const b: EventLogEntry = { id: "evt_tie_b", type: "workflow.approved", occurredAt: tiedAt, summary: "b" };
        const c: EventLogEntry = { id: "evt_tie_c", type: "workflow.approved", occurredAt: tiedAt, summary: "c" };
        await store.events.append(b);
        await store.events.append(c);
        await store.events.append(a);
        const list = (await store.events.list()).filter((e) => e.occurredAt === tiedAt);
        expect(list.map((e) => e.id)).toEqual(["evt_tie_c", "evt_tie_b", "evt_tie_a"]); // id DESC tiebreak
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

    describe("jobQueue (store-internal plumbing, not one of the 17 members — architecture §5.3)", () => {
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

      it("lists all entries, lists entries by run, and deletes by resolved key", async () => {
        const runId = uniqueId("run");
        const resolvedKey = `${runId}:send_email`;
        await store.idempotencyLedger.put({
          resolvedKey,
          runId,
          stepId: "send_email",
          recordedOutput: { sent: true },
          createdAt: new Date().toISOString(),
          schemaVersion: 2,
        });
        await expect(
          store.idempotencyLedger.listByRun(runId),
        ).resolves.toEqual([
          expect.objectContaining({ resolvedKey, schemaVersion: 2 }),
        ]);
        await expect(store.idempotencyLedger.list()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ resolvedKey, schemaVersion: 2 }),
          ]),
        );
        await store.idempotencyLedger.delete(resolvedKey);
        await expect(
          store.idempotencyLedger.get(resolvedKey),
        ).resolves.toBeUndefined();
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

      it("stages artifact blobs plus signal and event audits with read-your-writes and rollback", async () => {
        const runId = uniqueId("run");
        const artifact: Artifact = {
          id: uniqueId("art"),
          runId,
          name: "transaction.txt",
          kind: "file",
          mime: "text/plain",
          path: `artifacts/${runId}/transaction.txt`,
          bytes: 4,
          createdAt: new Date().toISOString(),
        };
        const artifactBytes =
          new TextEncoder().encode("safe");
        const signal: Signal = {
          id: uniqueId("sig"),
          name: "transaction.signal",
          correlationId: uniqueId("corr"),
          payload: { safe: true },
          receivedAt: new Date().toISOString(),
        };
        const event: EventLogEntry = {
          id: uniqueId("evt"),
          type: "run.started",
          occurredAt: new Date().toISOString(),
          summary: "transaction event",
          runId,
        };

        await expect(
          store.transact(async (tx) => {
            await tx.artifacts.put(artifact, artifactBytes);
            await tx.signals.append(signal);
            await tx.events.append(event);

            await expect(
              tx.artifacts.getMetadata(artifact.id),
            ).resolves.toEqual(artifact);
            await expect(
              tx.artifacts.getBytes(artifact.id),
            ).resolves.toEqual(artifactBytes);
            await expect(
              tx.signals.list(),
            ).resolves.toContainEqual(signal);
            await expect(
              tx.events.list(),
            ).resolves.toContainEqual(event);
            throw new Error("rollback all audit members");
          }),
        ).rejects.toThrow(/rollback all audit members/);

        await expect(
          store.artifacts.getMetadata(artifact.id),
        ).resolves.toBeUndefined();
        await expect(
          store.artifacts.getBytesForRedaction(artifact.id),
        ).resolves.toBeUndefined();
        await expect(
          store.signals.list(),
        ).resolves.not.toContainEqual(
          expect.objectContaining({ id: signal.id }),
        );
        await expect(
          store.events.list(),
        ).resolves.not.toContainEqual(
          expect.objectContaining({ id: event.id }),
        );
      });

      it("rolls an existing artifact audit and blob back together", async () => {
        const runId = uniqueId("run");
        const artifact: Artifact = {
          id: uniqueId("art"),
          runId,
          name: "original.txt",
          kind: "file",
          mime: "text/plain",
          path: `artifacts/${runId}/original.txt`,
          bytes: 8,
          createdAt: new Date().toISOString(),
        };
        const originalBytes =
          new TextEncoder().encode("original");
        const repairedBytes =
          new TextEncoder().encode("[REDACTED]");
        await store.artifacts.put(
          artifact,
          originalBytes,
        );

        await expect(
          store.transact(async (tx) => {
            await tx.artifacts.replaceAudit(
              artifact.id,
              {
                name: "[REDACTED]",
                kind: artifact.kind,
                mime: artifact.mime,
                path: artifact.path,
              },
              repairedBytes,
            );
            await expect(
              tx.artifacts.getMetadata(artifact.id),
            ).resolves.toMatchObject({
              name: "[REDACTED]",
              bytes: repairedBytes.byteLength,
            });
            await expect(
              tx.artifacts.getBytes(artifact.id),
            ).resolves.toEqual(repairedBytes);
            throw new Error("rollback artifact repair");
          }),
        ).rejects.toThrow(/rollback artifact repair/);

        await expect(
          store.artifacts.getMetadata(artifact.id),
        ).resolves.toEqual(artifact);
        await expect(
          store.artifacts.getBytes(artifact.id),
        ).resolves.toEqual(originalBytes);
      });

      it("keeps a staged artifact blob when a later write in the same transaction changes only metadata", async () => {
        const runId = uniqueId("run");
        const artifact: Artifact = {
          id: uniqueId("art"),
          runId,
          name: "original.txt",
          kind: "file",
          mime: "text/plain",
          path: `artifacts/${runId}/original.txt`,
          bytes: 8,
          createdAt: new Date().toISOString(),
        };
        const originalBytes =
          new TextEncoder().encode("original");
        const repairedBytes =
          new TextEncoder().encode("[REDACTED]");
        await store.artifacts.put(artifact, originalBytes);

        await store.transact(async (tx) => {
          await tx.artifacts.replaceAudit(
            artifact.id,
            {
              name: "first-safe-name.txt",
              kind: artifact.kind,
              mime: artifact.mime,
              path: artifact.path,
            },
            repairedBytes,
          );
          await tx.artifacts.replaceAudit(
            artifact.id,
            {
              name: "final-safe-name.txt",
              kind: artifact.kind,
              mime: artifact.mime,
              path: `artifacts/${runId}/final-safe-name.txt`,
            },
          );
          await expect(
            tx.artifacts.getBytes(artifact.id),
          ).resolves.toEqual(repairedBytes);
        });

        await expect(
          store.artifacts.getMetadata(artifact.id),
        ).resolves.toMatchObject({
          name: "final-safe-name.txt",
          path: `artifacts/${runId}/final-safe-name.txt`,
          bytes: repairedBytes.byteLength,
        });
        await expect(
          store.artifacts.getBytes(artifact.id),
        ).resolves.toEqual(repairedBytes);
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
