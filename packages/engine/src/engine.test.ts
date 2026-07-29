import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStore, type AartStore } from "@aart/store";
import { openSqliteStore } from "@aart/store/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { alwaysAllowCapabilityCheck } from "./capability.js";
import { createEngine } from "./engine.js";
import { identityRedactFn } from "./redaction.js";
import { CURRENT_ENGINE_SCHEMA_VERSION, SchemaVersionMismatchError } from "./schema-version.js";
import { createTestStore, echoBlock, fixtureTrigger, fixtureWorkflow } from "./test-utils/fixtures.js";
import { createBlockRegistry } from "./types.js";

/** Like `createTestStore`, but also returns the on-disk `root` path — needed by the restart/reclaim tests below, which must construct a SECOND, fully independent `createFsStore()` instance pointed at the same directory (simulating a genuine process restart: no in-memory object is shared between the two `AartStore`s, only the filesystem). */
async function createTestStoreWithRoot(): Promise<{ root: string; store: AartStore; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-engine-durability-test-"));
  return { root, store: createFsStore(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function createSqliteTestStore(): Promise<{ store: AartStore; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-engine-sqlite-test-"));
  const handle = await openSqliteStore(join(root, "aart.sqlite"), {
    blobsDir: join(root, "blobs"),
  });
  return {
    store: handle.store,
    cleanup: async () => {
      handle.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(): Promise<{ store: AartStore; engine: ReturnType<typeof createEngine> }> {
  const { store, cleanup } = await createTestStore();
  cleanups.push(cleanup);
  const engine = createEngine({ store, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: createBlockRegistry([echoBlock]), computeRetryDelayMs: () => 0 });
  return { store, engine };
}

describe("createEngine — wiring", () => {
  it("triggerRun + executeRun run a full workflow to completion", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await engine.executeRun(run.runId);
    expect(finished.status).toBe("completed");
  });

  it("cancelRun is wired through", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    const cancelled = await engine.cancelRun(run.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("createEngine — resume wrappers continue execution past the resumed step", () => {
  it("resumeManual continues to the NEXT step after the wait, not just completing the wait step itself", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "wait_step", uses: "wait.manual" }, { id: "after", uses: "test.echo", with: { note: "reached-after-resume" } }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    const waiting = await engine.executeRun(run.runId);
    expect(waiting.status).toBe("waiting");

    const outcome = await engine.resumeManual(run.runId, "wait_step", { approvedBy: "operator" });
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("completed"); // ran past "after" to completion
    expect(outcome.run.trace.find((t) => t.stepId === "after")).toMatchObject({ status: "completed", inputs: { note: "reached-after-resume" } });
  });

  it("commits a completed wait event before failing a broken post-resume until", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "wait_step",
            uses: "wait.manual",
            next: "wait_step",
            until: "{{ steps.wait_step.outputs.missing }}",
            maxIterations: 2,
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    const waiting = await engine.executeRun(run.runId);
    expect(waiting.status).toBe("waiting");

    const outcome = await engine.resumeManual(
      run.runId,
      "wait_step",
      { received: true },
    );

    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.error).toMatch(/resolved to undefined/);
    expect(outcome.run.trace).toHaveLength(1);
    expect(outcome.run.trace[0]).toMatchObject({
      stepId: "wait_step",
      status: "completed",
      outputs: { received: true },
    });
    await expect(
      store.waits.get(run.runId, "wait_step"),
    ).resolves.toBeUndefined();
  });

  it("re-redacts an earlier text artifact when wait resume first discovers its secret", async () => {
    const { store, cleanup } = await createTestStore();
    cleanups.push(cleanup);
    const redact = (
      record: unknown,
      resolvedSecretRefs: ReadonlySet<string>,
    ): unknown => {
      let json = JSON.stringify(record);
      for (const secret of resolvedSecretRefs) {
        json = json.replaceAll(secret, "[REDACTED]");
      }
      return JSON.parse(json);
    };
    const engine = createEngine({
      store,
      redact,
      resolveSecret: () => "late-secret",
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock]),
      computeRetryDelayMs: () => 0,
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "pause",
            uses: "wait.manual",
            next: "pause",
            until: "{{ secrets.STOP }}",
            maxIterations: 1,
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(run.runId);
    const rawBytes = new TextEncoder().encode("late-secret");
    await store.artifacts.put(
      {
        id: "artifact-before-resume",
        runId: run.runId,
        stepId: "earlier",
        name: "earlier.txt",
        kind: "report",
        mime: "text/plain",
        path: `artifacts/${run.runId}/artifact-before-resume`,
        bytes: rawBytes.byteLength,
        createdAt: new Date().toISOString(),
      },
      rawBytes,
    );

    const outcome = await engine.resumeManual(run.runId, "pause", {
      received: true,
    });

    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    const protectedBytes = await store.artifacts.getBytes(
      "artifact-before-resume",
    );
    if (protectedBytes === undefined) {
      throw new Error("artifact bytes missing");
    }
    expect(new TextDecoder().decode(protectedBytes)).toBe("[REDACTED]");
    expect(outcome.run.artifacts).toContainEqual(
      await store.artifacts.getMetadata("artifact-before-resume"),
    );
  });

  it("resumes and re-redacts a text artifact without re-entering the SQLite transaction", async () => {
    const { store, cleanup } = await createSqliteTestStore();
    cleanups.push(cleanup);
    const redact = (
      record: unknown,
      resolvedSecretRefs: ReadonlySet<string>,
    ): unknown => {
      let json = JSON.stringify(record);
      for (const secret of resolvedSecretRefs) {
        json = json.replaceAll(secret, "[REDACTED]");
      }
      return JSON.parse(json);
    };
    const engine = createEngine({
      store,
      redact,
      resolveSecret: () => "late-secret",
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock]),
      computeRetryDelayMs: () => 0,
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "pause",
            uses: "wait.manual",
            next: "pause",
            until: "{{ secrets.STOP }}",
            maxIterations: 1,
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(run.runId);
    const rawBytes = new TextEncoder().encode("late-secret");
    await store.artifacts.put(
      {
        id: "sqlite-artifact-before-resume",
        runId: run.runId,
        stepId: "earlier",
        name: "earlier.txt",
        kind: "report",
        mime: "text/plain",
        path: `artifacts/${run.runId}/sqlite-artifact-before-resume`,
        bytes: rawBytes.byteLength,
        createdAt: new Date().toISOString(),
      },
      rawBytes,
    );

    const outcome = await engine.resumeManual(run.runId, "pause", {
      received: true,
    });

    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    const protectedBytes = await store.artifacts.getBytes(
      "sqlite-artifact-before-resume",
    );
    if (protectedBytes === undefined) {
      throw new Error("artifact bytes missing");
    }
    expect(new TextDecoder().decode(protectedBytes)).toBe("[REDACTED]");
    expect(outcome.run.artifacts).toContainEqual(
      await store.artifacts.getMetadata("sqlite-artifact-before-resume"),
    );
  });

  it("completes an early-arrival signal without re-entering the SQLite transaction", async () => {
    const { store, cleanup } = await createSqliteTestStore();
    cleanups.push(cleanup);
    const engine = createEngine({
      store,
      redact: identityRedactFn,
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock]),
      computeRetryDelayMs: () => 0,
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "pause",
            uses: "wait.for_signal",
            with: { name: "ready", correlationId: "sqlite-early" },
          },
          {
            id: "after",
            uses: "test.echo",
            with: { note: "continued-after-early-arrival" },
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    await store.signals.append({
      id: "sqlite-early-signal",
      name: "ready",
      correlationId: "sqlite-early",
      payload: { received: true },
      receivedAt: new Date().toISOString(),
    });
    const run = await engine.triggerRun({
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await engine.executeRun(run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.trace).toEqual([
      expect.objectContaining({
        stepId: "pause",
        status: "completed",
        outputs: { received: true },
      }),
      expect.objectContaining({
        stepId: "after",
        status: "completed",
      }),
    ]);
    await expect(
      store.signals.findUnconsumedMatch("ready", "sqlite-early"),
    ).resolves.toBeUndefined();
  });

  it("carries secret taint through a persisted wait and rejects its public output after resume", async () => {
    const { store, cleanup } = await createTestStore();
    cleanups.push(cleanup);
    const redact = (record: unknown, resolvedSecretRefs: ReadonlySet<string>): unknown => {
      let json = JSON.stringify(record);
      for (const secret of resolvedSecretRefs) {
        json = json.replaceAll(secret, "[REDACTED]");
      }
      return JSON.parse(json);
    };
    const engine = createEngine({
      store,
      redact,
      resolveSecret: () => "secret-value",
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock]),
      computeRetryDelayMs: () => 0,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          { id: "source", uses: "test.echo", with: { secret: "{{ secrets.API_KEY }}" } },
          {
            id: "pause",
            uses: "wait.manual",
            with: { correlation: "{{ steps.source.outputs.echoed.secret }}" },
          },
        ],
        outputMapping: { result: "{{ steps.pause.outputs.result }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });

    const waiting = await engine.executeRun(run.runId);
    expect(waiting.status).toBe("waiting");
    expect(waiting.trace.find((trace) => trace.stepId === "pause")).toMatchObject({
      secretTainted: true,
    });

    const outcome = await engine.resumeManual(run.runId, "pause", {
      result: "[REDACTED]",
    });
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.error).toMatch(/secret-tainted step "pause"/);
  });

  it("resolves resume control secrets before the completed wait is first redacted for persistence", async () => {
    const { store, cleanup } = await createTestStore();
    cleanups.push(cleanup);
    let sawUnprotectedCompletedPayload = false;
    const redact = (
      record: unknown,
      resolvedSecretRefs: ReadonlySet<string>,
    ): unknown => {
      if (
        record !== null &&
        typeof record === "object" &&
        (record as { value?: unknown }).value === true &&
        resolvedSecretRefs.size === 0
      ) {
        sawUnprotectedCompletedPayload = true;
      }
      const visit = (value: unknown): unknown => {
        if (
          (typeof value === "boolean" ||
            typeof value === "number" ||
            typeof value === "string") &&
          resolvedSecretRefs.has(String(value))
        ) {
          return "[REDACTED]";
        }
        if (Array.isArray(value)) return value.map(visit);
        if (value !== null && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [
              key,
              visit(nested),
            ]),
          );
        }
        return value;
      };
      return visit(record);
    };
    const engine = createEngine({
      store,
      redact,
      resolveSecret: () => true,
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock]),
      computeRetryDelayMs: () => 0,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "json", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "pause",
            uses: "wait.manual",
            next: "pause",
            maxIterations: 1,
            until: "{{ secrets.STOP }}",
          },
        ],
        outputMapping: { result: "{{ steps.pause.outputs.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(run.runId);

    const outcome = await engine.resumeManual(run.runId, "pause", {
      value: true,
    });

    expect(outcome.kind).toBe("resumed");
    expect(sawUnprotectedCompletedPayload).toBe(false);
    const persisted = await store.runs.get(run.runId);
    expect(persisted?.trace[0]?.outputs?.["value"]).toMatch(/REDACTED/);
  });

  it("resumeBySignal continues execution and reaches the workflow's actual completion", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "wait_step", uses: "wait.for_signal", with: { name: "quote.received", correlationId: "corr1" } }, { id: "after", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    await engine.executeRun(run.runId);

    const outcome = await engine.resumeBySignal({ id: "sig1", name: "quote.received", correlationId: "corr1", payload: { price: 42 }, receivedAt: new Date().toISOString() });
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("completed");
  });

  it("resumeTimerWait continues execution to completion", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "wait_step", uses: "wait.until", with: { resumeAt: new Date(Date.now() - 1000).toISOString() } }, { id: "after", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    await engine.executeRun(run.runId);

    const due = await engine.getDueWaits();
    expect(due.map((d) => d.runId)).toContain(run.runId);

    const outcome = await engine.resumeTimerWait(run.runId, "wait_step");
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("completed");
  });

  it("resumeApproval continues execution to completion", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "review", uses: "human.approval", with: { title: "Please review" } }, { id: "after", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    const waiting = await engine.executeRun(run.runId);
    const waitCondition = waiting.trace.find((t) => t.stepId === "review");
    expect(waitCondition?.status).toBe("waiting");

    const approvals = await store.approvals.list({ runId: run.runId });
    expect(approvals).toHaveLength(1);
    const task = approvals[0]!;
    expect(task.title).toBe("Please review");

    const outcome = await engine.resumeApproval(run.runId, "review", { id: task.id, status: "approved", reviewer: "jane@example.com" });
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("completed");
  });

  it("resumeExternalJobResult continues execution to completion", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "wait_batch", uses: "wait.for_external_job", with: { provider: "openai_batch", jobId: "job-1" } }, { id: "after", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    await engine.executeRun(run.runId);

    const jobs = await engine.listExternalJobWaits();
    expect(jobs.map((j) => j.runId)).toContain(run.runId);

    const outcome = await engine.resumeExternalJobResult(run.runId, "wait_batch", { itemsProcessed: 10 });
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("completed");
  });

  it("failExpiredWait finalizes the WHOLE RUN as failed (architecture §4.1's lifecycle diagram: waiting -> [timeout, no resolving event] -> failed), not just the step trace", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "wait_step", uses: "wait.for_signal", with: { name: "quote.received", correlationId: "corr1", timeout: "5s" } }, { id: "never_reached", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    const waiting = await engine.executeRun(run.runId);
    expect(waiting.status).toBe("waiting");

    const past = new Date(Date.now() + 10_000); // "now" 10s after entry — past the 5s timeout
    const expired = await engine.getExpiredWaits(past);
    expect(expired.map((e) => e.stepId)).toContain("wait_step");

    const outcome = await engine.failExpiredWait(run.runId, "wait_step");
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("failed"); // the RUN, not just the step
    expect(outcome.run.error).toMatch(/expired/i);
    expect(outcome.run.endedAt).toBeTruthy();
    expect(outcome.run.snapshot.capturedAt).not.toBe(""); // finalization captured the snapshot
    expect(outcome.run.trace.find((t) => t.stepId === "never_reached")).toBeUndefined(); // never dispatched

    // A resolving signal arriving after expiry finds nothing left to resume.
    const lateSignal = await engine.resumeBySignal({ id: "sig1", name: "quote.received", correlationId: "corr1", payload: {}, receivedAt: new Date().toISOString() });
    expect(lateSignal.kind).toBe("unmatched");
  });

  it("continues correctly through an if/then branch chosen at the wait step itself", async () => {
    const { store, engine } = await setup();
    // Both branches explicitly `next: "done"` to a shared join step — this
    // is what makes them genuinely mutually exclusive (with no `next`, a
    // step with no if/until falls through SEQUENTIALLY to the next step in
    // array order regardless of how it was reached, so "approved-path"
    // immediately followed by "skip-path" in the array would otherwise run
    // BOTH — correct behavior, not a bug, but not what this test means to
    // exercise).
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          { id: "wait_step", uses: "wait.manual", if: "{{ inputs.needsApproval }}", then: "approved-path", else: "skip-path" },
          { id: "skip-path", uses: "test.echo", with: { branch: "skip" }, next: "done" },
          { id: "approved-path", uses: "test.echo", with: { branch: "approved" }, next: "done" },
          { id: "done", uses: "test.echo" },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: { needsApproval: true } });
    await engine.executeRun(run.runId);

    const outcome = await engine.resumeManual(run.runId, "wait_step");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.trace.find((t) => t.stepId === "approved-path")).toBeDefined();
    expect(outcome.run.trace.find((t) => t.stepId === "skip-path")).toBeUndefined();
  });
});

describe("createEngine — THE durable-execution proof: a real process restart, not just an in-memory resume call", () => {
  it("a run that waits, gets its store reloaded completely fresh (a brand-new Engine + a brand-new createFsStore() call against the same on-disk root — no in-memory object is shared), resumes correctly from a fresh load", async () => {
    const { root, store: originalStore, cleanup } = await createTestStoreWithRoot();
    cleanups.push(cleanup);

    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [{ id: "s1", uses: "test.echo" }, { id: "wait_step", uses: "wait.for_signal", with: { name: "quote.received", correlationId: "corr-restart" } }, { id: "s3", uses: "test.echo" }],
      },
    });
    await originalStore.workflows.put(workflow);

    // "Process 1": trigger, execute to the wait, then the process (and
    // every in-memory object it held — the Engine, its AartStore adapter,
    // any closures) is discarded. Nothing from `engine1`/`originalStore` is
    // referenced again below.
    const engine1 = createEngine({ store: originalStore, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: createBlockRegistry([echoBlock]) });
    const run = await engine1.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    const waiting = await engine1.executeRun(run.runId);
    expect(waiting.status).toBe("waiting");
    expect(waiting.trace.map((t) => t.stepId)).toEqual(["s1", "wait_step"]);

    // "Process 2, after a restart": a GENUINELY FRESH `createFsStore(root)`
    // call — a new adapter instance with no shared state — and a brand-new
    // `createEngine`. This is what makes the test real: resuming via the
    // SAME `engine1`/`originalStore` objects would prove nothing about
    // durability (in-memory state could paper over a persistence bug); a
    // second, independent store instance reading the SAME directory proves
    // the wait genuinely survived to disk.
    const reloadedStore = createFsStore(root);
    const engine2 = createEngine({ store: reloadedStore, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: createBlockRegistry([echoBlock]) });

    const outcome = await engine2.resumeBySignal({ id: "sig-restart", name: "quote.received", correlationId: "corr-restart", payload: { approved: true }, receivedAt: new Date().toISOString() });
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("completed");
    expect(outcome.run.trace.map((t) => t.stepId)).toEqual(["s1", "wait_step", "s3"]);
    expect(outcome.run.trace.find((t) => t.stepId === "wait_step")?.outputs).toEqual({ approved: true });

    // Re-verify via a THIRD, independent read against the same root — the
    // completion is genuinely durable, not an artifact of engine2's own
    // in-memory return value.
    const verifyStore = createFsStore(root);
    const verifyRun = await verifyStore.runs.get(run.runId);
    expect(verifyRun?.status).toBe("completed");
  });

  it("reclaim-safety: a DIFFERENT engine instance (a different worker) resumes a run the original claimant never released cleanly — a different code path than a clean same-worker restart", async () => {
    const { root, store: originalStore, cleanup } = await createTestStoreWithRoot();
    cleanups.push(cleanup);

    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }, { id: "s2", uses: "test.echo" }, { id: "s3", uses: "test.echo" }] } });
    await originalStore.workflows.put(workflow);

    const engine1 = createEngine({ store: originalStore, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: createBlockRegistry([echoBlock]) });
    const run = await engine1.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });

    // Simulate "worker 1 claimed the run, completed s1, then was killed
    // mid-step (before s2) without releasing its claim cleanly" — the
    // run's OWN persisted state (status: running, one completed trace
    // entry) is exactly what a real crash-mid-step leaves behind
    // (architecture §4.7); this test doesn't simulate job_queue lease
    // mechanics themselves (S2's scope) — only that this package's OWN
    // executeRun() correctly continues from whatever the store shows,
    // regardless of which Engine instance calls it.
    await originalStore.runs.put({
      ...run,
      status: "running",
      trace: [{ seq: 0, stepId: "s1", block: "test.echo", status: "completed", inputs: {}, outputs: { echoed: {} }, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }],
    });

    // "Worker 2" — a fully independent Engine + store instance, as a real
    // reclaiming worker process would be.
    const reclaimingStore = createFsStore(root);
    const engine2 = createEngine({ store: reclaimingStore, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: createBlockRegistry([echoBlock]) });

    const finished = await engine2.executeRun(run.runId);
    expect(finished.status).toBe("completed");
    // s1 was NOT re-executed (still exactly one trace entry for it); s2/s3
    // ran to completion under the NEW worker.
    expect(finished.trace.map((t) => t.stepId)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("createEngine — engine-code schema-version tag (architecture §4.7): resume-across-engine-version", () => {
  it("a compatible-version resume proceeds normally", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "wait_step", uses: "wait.manual" }, { id: "after", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    await engine.executeRun(run.runId);
    const outcome = await engine.resumeManual(run.runId, "wait_step");
    expect(outcome.kind).toBe("resumed");
  });

  it("a run created under an incompatible engine schemaVersion fails loudly on executeRun rather than silently misinterpreting it", async () => {
    const { store } = await setup();
    const olderEngine = createEngine({ store, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: createBlockRegistry([echoBlock]), schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION + 1 });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await olderEngine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    expect(run.schemaVersion).toBe(CURRENT_ENGINE_SCHEMA_VERSION + 1);

    // A DIFFERENT engine instance, at THIS build's actual current version,
    // tries to resume/execute the run created under the newer tag.
    const currentEngine = createEngine({ store, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: createBlockRegistry([echoBlock]) });
    await expect(currentEngine.executeRun(run.runId)).rejects.toThrow(SchemaVersionMismatchError);
  });

  it("an incompatible WaitCondition schemaVersion also fails loudly at resume time", async () => {
    const { store, engine } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "wait_step", uses: "wait.manual" }] } });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: fixtureTrigger(), inputs: {} });
    await engine.executeRun(run.runId);

    // Tamper with the persisted WaitCondition's schemaVersion directly,
    // simulating a record written by an incompatible engine build.
    const wait = await store.waits.get(run.runId, "wait_step");
    if (!wait) throw new Error("test setup: expected an outstanding wait");
    await store.waits.put(run.runId, "wait_step", { ...wait, schemaVersion: 999 } as typeof wait, new Date().toISOString());

    await expect(engine.resumeManual(run.runId, "wait_step")).rejects.toThrow(SchemaVersionMismatchError);
  });
});
