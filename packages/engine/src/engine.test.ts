import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStore, type AartStore } from "@aart/store";
import { openSqliteStore } from "@aart/store/sqlite";
import type { BlockImplementation } from "@aart/types";
import { afterEach, describe, expect, it } from "vitest";
import { alwaysAllowCapabilityCheck } from "./capability.js";
import { createEngine } from "./engine.js";
import { idempotencyStorageKey } from "./idempotency.js";
import {
  identityRedactFn,
  repairGlobalAuditsForNewSecrets,
} from "./redaction.js";
import { CURRENT_ENGINE_SCHEMA_VERSION, SchemaVersionMismatchError } from "./schema-version.js";
import { createTestStore, echoBlock, fixtureTrigger, fixtureWorkflow } from "./test-utils/fixtures.js";
import { createBlockRegistry } from "./types.js";
import { resumeManual as resumeManualMechanism } from "./wait/wait-machine.js";

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
            uses: "wait.for_signal",
            with: { name: "ready", correlationId: "sqlite-early" },
            next: "pause",
            until: "{{ secrets.STOP }}",
            maxIterations: 1,
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
      payload: { received: "late-secret" },
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
        outputs: { received: "[REDACTED]" },
      }),
      expect.objectContaining({
        stepId: "after",
        status: "completed",
      }),
    ]);
    await expect(
      store.signals.findUnconsumedMatch("ready", "sqlite-early"),
    ).resolves.toBeUndefined();
    await expect(store.signals.list()).resolves.toContainEqual({
      id: "sqlite-early-signal",
      name: "ready",
      correlationId: "sqlite-early",
      payload: { received: "[REDACTED]" },
      receivedAt: expect.any(String),
    });
  });

  it("repairs every persisted consumer in a transitive global-cache lineage", async () => {
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
    let sourceExecutions = 0;
    let derivativeExecutions = 0;
    const sourceBlock: BlockImplementation = {
      manifest: {
        id: "test.late-secret-source",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a value before another step identifies it as secret.",
      },
      execute: async () => {
        sourceExecutions += 1;
        return { value: "late-secret" };
      },
    };
    const derivativeBlock: BlockImplementation = {
      manifest: {
        id: "test.cached-secret-derivative",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Caches a non-literal derivative of a replayed value.",
      },
      execute: async (inputs) => {
        derivativeExecutions += 1;
        return {
          length: String(
            (inputs as Record<string, unknown>)["source"],
          ).length,
        };
      },
    };
    const engine = createEngine({
      store,
      redact,
      resolveSecret: () => "late-secret",
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([
        echoBlock,
        sourceBlock,
        derivativeBlock,
      ]),
      computeRetryDelayMs: () => 0,
    });
    const sourceWorkflow = fixtureWorkflow({
      id: "wf-cache-source",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "cached",
            uses: sourceBlock.manifest.id,
            idempotencyKey: "shared-secret",
          },
          { id: "pause", uses: "wait.manual" },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
      },
    });
    const derivativeWorkflow = fixtureWorkflow({
      id: "wf-cache-derivative",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "cached",
            uses: sourceBlock.manifest.id,
            idempotencyKey: "shared-secret",
          },
          {
            id: "derive",
            uses: derivativeBlock.manifest.id,
            with: {
              source: "{{ steps.cached.outputs.value }}",
            },
            idempotencyKey: "shared-derivative",
          },
          { id: "pause", uses: "wait.manual" },
        ],
      },
    });
    const transitiveConsumerWorkflow = fixtureWorkflow({
      id: "wf-cache-transitive-consumer",
      outputs: [
        { name: "result", type: "integer", required: true },
      ],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "derive",
            uses: derivativeBlock.manifest.id,
            idempotencyKey: "shared-derivative",
          },
        ],
        outputMapping: {
          result: "{{ steps.derive.outputs.length }}",
        },
      },
    });
    const waitingSignalConsumerWorkflow = fixtureWorkflow({
      id: "wf-cache-wait-consumer",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "cached",
            uses: sourceBlock.manifest.id,
            idempotencyKey: "shared-secret",
          },
          {
            id: "pause",
            uses: "wait.for_signal",
            with: {
              name: "cache-ready",
              correlationId: "{{ steps.cached.outputs.value }}",
            },
          },
        ],
      },
    });
    await Promise.all([
      store.workflows.put(sourceWorkflow),
      store.workflows.put(derivativeWorkflow),
      store.workflows.put(transitiveConsumerWorkflow),
      store.workflows.put(waitingSignalConsumerWorkflow),
    ]);

    const sourceRun = await engine.triggerRun({
      workflow: sourceWorkflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(sourceRun.runId);
    const derivativeRun = await engine.triggerRun({
      workflow: derivativeWorkflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(derivativeRun.runId);
    const transitiveRun = await engine.triggerRun({
      workflow: transitiveConsumerWorkflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(transitiveRun.runId);
    const waitingSignalRun = await engine.triggerRun({
      workflow: waitingSignalConsumerWorkflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(waitingSignalRun.runId);

    expect(sourceExecutions).toBe(1);
    expect(derivativeExecutions).toBe(1);
    const resumedSource = await engine.resumeManual(
      sourceRun.runId,
      "pause",
    );

    expect(resumedSource.kind).toBe("resumed");
    await expect(
      store.idempotencyLedger.get(idempotencyStorageKey("shared-secret")),
    ).resolves.toBeUndefined();
    await expect(
      store.idempotencyLedger.get(
        idempotencyStorageKey("shared-derivative"),
      ),
    ).resolves.toBeUndefined();
    const repairedDerivative = await store.runs.get(derivativeRun.runId);
    expect(repairedDerivative?.status).toBe("waiting");
    expect(
      repairedDerivative?.trace.find((trace) => trace.stepId === "cached"),
    ).toMatchObject({
      outputs: { value: "[REDACTED]" },
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
    expect(
      repairedDerivative?.trace.find((trace) => trace.stepId === "derive"),
    ).toMatchObject({
      outputs: { length: 11 },
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
    const repairedTransitive = await store.runs.get(transitiveRun.runId);
    expect(repairedTransitive?.status).toBe("failed");
    expect(repairedTransitive?.outputs).toBeUndefined();
    expect(repairedTransitive?.error).toMatch(
      /replayed cache result was later identified as secret-derived/,
    );
    expect(
      repairedTransitive?.trace.find((trace) => trace.stepId === "derive"),
    ).toMatchObject({
      outputs: { length: 11 },
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
    await expect(store.waits.list()).resolves.toContainEqual(
      expect.objectContaining({
        runId: waitingSignalRun.runId,
        stepId: "pause",
        wait: expect.objectContaining({
          type: "signal",
          name: "cache-ready",
          correlationId: "[REDACTED]",
        }),
      }),
    );
    const repairedWaitResume = await engine.resumeBySignal({
      id: "repaired-wait-signal",
      name: "cache-ready",
      correlationId: "late-secret",
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    expect(repairedWaitResume.kind).toBe("resumed");
  });

  it("reconstructs persisted producers before declaring a non-literal cache entry safe", async () => {
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
    let executions = 0;
    const derivativeBlock: BlockImplementation = {
      manifest: {
        id: "test.input-derivative",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a non-literal derivative of its input.",
      },
      execute: async (inputs) => {
        executions += 1;
        return {
          length: String(
            (inputs as Record<string, unknown>)["source"],
          ).length,
        };
      },
    };
    const engine = createEngine({
      store,
      redact,
      resolveSecret: () => "late-secret",
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock, derivativeBlock]),
      computeRetryDelayMs: () => 0,
    });
    const producerWorkflow = fixtureWorkflow({
      id: "wf-root-derived-producer",
      inputs: [{ name: "raw", type: "string", required: true }],
      outputs: [{ name: "result", type: "integer", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "derive",
            uses: derivativeBlock.manifest.id,
            with: { source: "{{ inputs.raw }}" },
            idempotencyKey: "root-derived",
          },
        ],
        outputMapping: {
          result: "{{ steps.derive.outputs.length }}",
        },
      },
    });
    const consumerWorkflow = fixtureWorkflow({
      id: "wf-root-derived-consumer",
      outputs: [{ name: "result", type: "integer", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "derive",
            uses: derivativeBlock.manifest.id,
            idempotencyKey: "root-derived",
          },
        ],
        outputMapping: {
          result: "{{ steps.derive.outputs.length }}",
        },
      },
    });
    const discoverWorkflow = fixtureWorkflow({
      id: "wf-unrelated-secret-discovery",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "discover",
            uses: "test.echo",
            with: { value: "{{ secrets.API_KEY }}" },
          },
        ],
      },
    });
    await Promise.all([
      store.workflows.put(producerWorkflow),
      store.workflows.put(consumerWorkflow),
      store.workflows.put(discoverWorkflow),
    ]);
    const producerRun = await engine.triggerRun({
      workflow: producerWorkflow,
      trigger: fixtureTrigger(),
      inputs: { raw: "late-secret" },
    });
    await engine.executeRun(producerRun.runId);
    const consumerRun = await engine.triggerRun({
      workflow: consumerWorkflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(consumerRun.runId);
    expect(executions).toBe(1);

    const discoverRun = await engine.triggerRun({
      workflow: discoverWorkflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(discoverRun.runId);

    await expect(
      store.idempotencyLedger.get(
        idempotencyStorageKey("root-derived"),
      ),
    ).resolves.toBeUndefined();
    await expect(store.runs.get(producerRun.runId)).resolves.toMatchObject({
      status: "failed",
      outputs: undefined,
      secretTaintedInputPaths: ["/raw"],
    });
    await expect(store.runs.get(consumerRun.runId)).resolves.toMatchObject({
      status: "failed",
      outputs: undefined,
    });
  });

  it("returns repaired taint to the active cache consumer before its authoritative write", async () => {
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
    let executions = 0;
    const derivativeBlock: BlockImplementation = {
      manifest: {
        id: "test.active-cache-derivative",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a non-literal derivative.",
      },
      execute: async (inputs) => {
        executions += 1;
        return {
          length: String(
            (inputs as Record<string, unknown>)["source"],
          ).length,
        };
      },
    };
    const engine = createEngine({
      store,
      redact,
      resolveSecret: () => "late-secret",
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock, derivativeBlock]),
      computeRetryDelayMs: () => 0,
    });
    const producerWorkflow = fixtureWorkflow({
      id: "wf-active-consumer-producer",
      inputs: [{ name: "raw", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "derive",
            uses: derivativeBlock.manifest.id,
            with: { source: "{{ inputs.raw }}" },
            idempotencyKey: "active-consumer-shared",
          },
        ],
      },
    });
    const activeConsumerWorkflow = fixtureWorkflow({
      id: "wf-active-consumer",
      outputs: [{ name: "result", type: "integer", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "replay",
            uses: derivativeBlock.manifest.id,
            idempotencyKey: "active-consumer-shared",
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { value: "{{ secrets.API_KEY }}" },
          },
        ],
        outputMapping: {
          result: "{{ steps.replay.outputs.length }}",
        },
      },
    });
    await Promise.all([
      store.workflows.put(producerWorkflow),
      store.workflows.put(activeConsumerWorkflow),
    ]);
    const producer = await engine.triggerRun({
      workflow: producerWorkflow,
      trigger: fixtureTrigger(),
      inputs: { raw: "late-secret" },
    });
    await engine.executeRun(producer.runId);
    const activeConsumer = await engine.triggerRun({
      workflow: activeConsumerWorkflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    const finished = await engine.executeRun(activeConsumer.runId);

    expect(executions).toBe(1);
    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(
      finished.trace.find((trace) => trace.stepId === "replay"),
    ).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
  });

  it("propagates repaired cache taint from forEach children into the persisted aggregate", async () => {
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
    let sourceExecutions = 0;
    const sourceBlock: BlockImplementation = {
      manifest: {
        id: "test.foreach-cache-source",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a value before it is known to be secret.",
      },
      execute: async () => {
        sourceExecutions += 1;
        return { value: "late-secret" };
      },
    };
    const engine = createEngine({
      store,
      redact,
      resolveSecret: () => "late-secret",
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock, sourceBlock]),
      computeRetryDelayMs: () => 0,
    });
    const sourceWorkflow = fixtureWorkflow({
      id: "wf-foreach-cache-source",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "cached",
            uses: sourceBlock.manifest.id,
            idempotencyKey: "foreach-shared",
          },
          { id: "pause", uses: "wait.manual" },
          {
            id: "discover",
            uses: "test.echo",
            with: { value: "{{ secrets.API_KEY }}" },
          },
        ],
      },
    });
    const consumerWorkflow = fixtureWorkflow({
      id: "wf-foreach-cache-consumer",
      inputs: [{ name: "items", type: "json", required: true }],
      outputs: [{ name: "result", type: "json", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "map",
            uses: sourceBlock.manifest.id,
            forEach: "{{ inputs.items }}",
            idempotencyKey: "foreach-shared",
          },
        ],
        outputMapping: {
          result: "{{ steps.map.outputs.items }}",
        },
      },
    });
    await Promise.all([
      store.workflows.put(sourceWorkflow),
      store.workflows.put(consumerWorkflow),
    ]);
    const sourceRun = await engine.triggerRun({
      workflow: sourceWorkflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(sourceRun.runId);
    const consumerRun = await engine.triggerRun({
      workflow: consumerWorkflow,
      trigger: fixtureTrigger(),
      inputs: { items: [1] },
    });
    await engine.executeRun(consumerRun.runId);
    expect(sourceExecutions).toBe(1);

    await engine.resumeManual(sourceRun.runId, "pause");

    const repaired = await store.runs.get(consumerRun.runId);
    expect(repaired?.status).toBe("failed");
    expect(repaired?.outputs).toBeUndefined();
    expect(
      repaired?.trace.find((trace) => trace.stepId === "map[0]"),
    ).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
    expect(
      repaired?.trace.find((trace) => trace.stepId === "map"),
    ).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: expect.arrayContaining([
        "/items/0",
        "/items/0/value",
      ]),
    });
  });

  it("omits an optional output for a skipped secret-input step without failing the workflow", async () => {
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
      resolveSecret: () => "unused-secret",
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock]),
      computeRetryDelayMs: () => 0,
    });
    const workflow = fixtureWorkflow({
      inputs: [
        { name: "shouldRun", type: "boolean", required: true },
      ],
      outputs: [
        { name: "result", type: "string", required: false },
      ],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "lookup",
            uses: "test.echo",
            with: { value: "{{ secrets.API_KEY }}" },
            if: "{{ inputs.shouldRun }}",
          },
        ],
        outputMapping: {
          result: "{{ steps.lookup.outputs.echoed.value }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({
      workflow,
      trigger: fixtureTrigger(),
      inputs: { shouldRun: false },
    });

    const finished = await engine.executeRun(run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.outputs).toEqual({});
    expect(finished.trace).toEqual([
      expect.objectContaining({
        stepId: "lookup",
        status: "skipped",
      }),
    ]);
    expect(finished.trace[0]?.secretTainted).toBeUndefined();
    expect(JSON.stringify(finished)).not.toContain("unused-secret");
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

  it("consumes a late-redacted early signal without re-exposing its protected payload", async () => {
    const { store, cleanup } = await createTestStore();
    cleanups.push(cleanup);
    const secret = "early-arrival-secret";
    const redact = (
      record: unknown,
      refs: ReadonlySet<string>,
    ): unknown => {
      let json = JSON.stringify(record);
      for (const value of refs) {
        json = json.replaceAll(value, "[REDACTED]");
      }
      return JSON.parse(json);
    };
    const signal = {
      id: "early-arrival",
      name: secret,
      correlationId: secret,
      payload: { echoed: secret },
      receivedAt: new Date().toISOString(),
    };
    await store.signals.append(signal);
    await repairGlobalAuditsForNewSecrets(
      store,
      redact,
      new Set([secret]),
    );
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "pause",
            uses: "wait.for_signal",
            with: {
              name: secret,
              correlationId: secret,
            },
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const engine = createEngine({
      store,
      redact,
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([echoBlock]),
    });
    const run = await engine.triggerRun({
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    const completed = await engine.executeRun(run.runId);

    expect(completed.status).toBe("completed");
    expect(completed.trace[0]?.outputs).toEqual({
      echoed: "[REDACTED]",
    });
    expect(JSON.stringify(completed)).not.toContain(secret);
  });

  it("redacts the consumed signal audit payload when resume control first discovers its secret", async () => {
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
            id: "wait_step",
            uses: "wait.for_signal",
            with: {
              name: "quote.received",
              correlationId: "secret-audit",
            },
            next: "wait_step",
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
    const signal = {
      id: "signal-secret-audit",
      name: "quote.received",
      correlationId: "secret-audit",
      payload: { value: "late-secret" },
      receivedAt: new Date().toISOString(),
    };
    await store.signals.append(signal);

    const outcome = await engine.resumeBySignal(signal);

    expect(outcome.kind).toBe("resumed");
    await expect(store.signals.list()).resolves.toContainEqual({
      ...signal,
      payload: { value: "[REDACTED]" },
    });
    await expect(
      store.signals.findUnconsumedMatch(
        "quote.received",
        "secret-audit",
      ),
    ).resolves.toBeUndefined();
  });

  it("re-redacts a consumed signal audit when a later workflow step discovers its secret", async () => {
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
      id: "wf-late-signal-audit",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "pause",
            uses: "wait.for_signal",
            with: {
              name: "late-secret",
              correlationId: "late-secret",
            },
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
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
    const signal = {
      id: "late-signal-audit",
      name: "late-secret",
      correlationId: "late-secret",
      payload: { value: "late-secret" },
      receivedAt: new Date().toISOString(),
    };
    await store.signals.append(signal);

    const outcome = await engine.resumeBySignal(signal);

    expect(outcome.kind).toBe("resumed");
    await expect(store.signals.list()).resolves.toContainEqual({
      ...signal,
      name: "[REDACTED]",
      correlationId: "[REDACTED]",
      payload: { value: "[REDACTED]" },
    });
    await expect(
      store.signals.listConsumedByRun(run.runId),
    ).resolves.toContainEqual({
      ...signal,
      name: "[REDACTED]",
      correlationId: "[REDACTED]",
      payload: { value: "[REDACTED]" },
    });
  });

  it("conservatively repairs a pre-provenance consumed signal after upgrade", async () => {
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
    const legacySignal = {
      id: "legacy-consumed-signal",
      name: "late-secret",
      correlationId: "late-secret",
      payload: { value: "late-secret" },
      receivedAt: new Date().toISOString(),
    };
    await store.signals.append(legacySignal);
    await store.signals.markConsumed(legacySignal.id);
    const workflow = fixtureWorkflow({
      id: "wf-repair-legacy-signal",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
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

    await expect(store.signals.list()).resolves.toContainEqual({
      ...legacySignal,
      name: "[REDACTED]",
      correlationId: "[REDACTED]",
      payload: { value: "[REDACTED]" },
    });
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

  it("re-redacts approval copy and decision when a later workflow step discovers their secret", async () => {
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
      id: "wf-late-approval-audit",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "review",
            uses: "human.approval",
            with: {
              title: "Review late-secret",
              description: "Decision may contain late-secret",
            },
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
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
    const [task] = await store.approvals.list({ runId: run.runId });
    if (!task) throw new Error("approval task missing");
    const decided = {
      ...task,
      status: "approved" as const,
      reviewer: "late-secret",
      decision: { note: "late-secret" },
      authenticatedAs: "late-secret",
      decidedAt: new Date().toISOString(),
    };
    await store.approvals.put(decided);
    await store.corrections.put({
      runId: run.runId,
      stepId: "review",
      fieldPath: "outputs.late-secret",
      observed: { note: "late-secret" },
      corrected: { note: "late-secret" },
      reason: "remove late-secret",
      reviewer: "late-secret",
      createdAt: new Date().toISOString(),
    });
    await store.events.append({
      id: "late-approval-event",
      type: "approval.decided",
      occurredAt: new Date().toISOString(),
      summary: "late-secret approved by late-secret",
      runId: run.runId,
      actor: "late-secret",
    });
    await store.artifacts.put(
      {
        id: "late-approval-artifact",
        runId: run.runId,
        stepId: "review",
        name: "late-secret",
        kind: "late-secret",
        mime: "text/late-secret",
        path: "late-secret/report.txt",
        bytes: 11,
        createdAt: new Date().toISOString(),
      },
      new TextEncoder().encode("late-secret"),
    );

    const outcome = await engine.resumeApproval(
      run.runId,
      "review",
      decided,
    );

    expect(outcome.kind).toBe("resumed");
    await expect(store.approvals.get(task.id)).resolves.toMatchObject({
      title: "Review [REDACTED]",
      description: "Decision may contain [REDACTED]",
      reviewer: "[REDACTED]",
      decision: { note: "[REDACTED]" },
      authenticatedAs: "[REDACTED]",
    });
    await expect(
      store.corrections.list({ runId: run.runId }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        fieldPath: "outputs.[REDACTED]",
        observed: { note: "[REDACTED]" },
        corrected: { note: "[REDACTED]" },
        reason: "remove [REDACTED]",
        reviewer: "[REDACTED]",
      }),
    );
    await expect(store.events.list()).resolves.toContainEqual(
      expect.objectContaining({
        id: "late-approval-event",
        summary: "[REDACTED] approved by [REDACTED]",
        actor: "[REDACTED]",
      }),
    );
    await expect(
      store.artifacts.getMetadata("late-approval-artifact"),
    ).resolves.toMatchObject({
      name: "[REDACTED]",
      kind: "[REDACTED]",
      mime: "text/[REDACTED]",
      path: "[REDACTED]/report.txt",
      bytes: 10,
    });
    await expect(
      store.artifacts.getBytes("late-approval-artifact"),
    ).resolves.toEqual(new TextEncoder().encode("[REDACTED]"));
  });

  it("redacts unrelated non-cached durable audits when another run first discovers the literal secret", async () => {
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
    const oldWorkflow = fixtureWorkflow({
      id: "wf-old-noncached-audits",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "echo",
            uses: "test.echo",
            with: { value: "{{ inputs.value }}" },
          },
        ],
      },
    });
    await store.workflows.put(oldWorkflow);
    const oldRun = await engine.triggerRun({
      workflow: oldWorkflow,
      trigger: fixtureTrigger(),
      inputs: { value: "late-secret" },
    });
    await engine.executeRun(oldRun.runId);
    const createdAt = "2026-01-01T00:00:00.000Z";
    await store.artifacts.put(
      {
        id: "old-global-artifact",
        runId: oldRun.runId,
        stepId: "echo",
        name: "late-secret",
        kind: "late-secret",
        mime: "text/late-secret",
        path: "late-secret/report.txt",
        bytes: 11,
        createdAt,
      },
      new TextEncoder().encode("late-secret"),
    );
    await store.approvals.put({
      id: "old-global-approval",
      runId: oldRun.runId,
      stepId: "echo",
      title: "late-secret",
      description: "late-secret",
      status: "approved",
      reviewer: "late-secret",
      authenticatedAs: "late-secret",
      createdAt,
      decidedAt: createdAt,
    });
    await store.corrections.put({
      runId: oldRun.runId,
      stepId: "echo",
      fieldPath: "outputs.late-secret",
      observed: "late-secret",
      corrected: "late-secret",
      reason: "late-secret",
      reviewer: "late-secret",
      createdAt,
    });
    await store.events.append({
      id: "old-global-event",
      type: "run.completed",
      occurredAt: createdAt,
      summary: "late-secret",
      runId: oldRun.runId,
      actor: "late-secret",
    });
    const operationalWait = {
      type: "external_job" as const,
      provider: "late-secret",
      jobId: "late-secret",
      timeout: "late-secret",
      schemaVersion: 1,
    };
    await store.waits.put(
      oldRun.runId,
      "old-global-wait",
      operationalWait,
      createdAt,
    );
    await store.signals.append({
      id: "old-global-signal",
      name: "late-secret",
      correlationId: "late-secret",
      payload: { value: "late-secret" },
      receivedAt: createdAt,
    });
    await store.signals.markConsumed("old-global-signal", {
      consumedBy: {
        runId: oldRun.runId,
        stepId: "echo",
      },
    });

    const discoveringWorkflow = fixtureWorkflow({
      id: "wf-discovers-unrelated-secret",
      execution: {
        type: "workflow",
        steps: [
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
      },
    });
    await store.workflows.put(discoveringWorkflow);
    const discoveringRun = await engine.triggerRun({
      workflow: discoveringWorkflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine.executeRun(discoveringRun.runId);

    const customerVisible = [
      await store.runs.get(oldRun.runId),
      await store.artifacts.getMetadata("old-global-artifact"),
      await store.approvals.get("old-global-approval"),
      await store.corrections.list({ runId: oldRun.runId }),
      await store.events.list({ runId: oldRun.runId }),
      await store.waits.list({ runId: oldRun.runId }),
      await store.signals.list(),
    ];
    expect(JSON.stringify(customerVisible)).not.toContain(
      "late-secret",
    );
    await expect(
      store.artifacts.getBytes("old-global-artifact"),
    ).resolves.toEqual(new TextEncoder().encode("[REDACTED]"));
    await expect(
      store.waits.listOperational({ runId: oldRun.runId }),
    ).resolves.toEqual([
      expect.objectContaining({ wait: operationalWait }),
    ]);
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

  it("rehydrates the pre-wait secret set and exact workflow snapshot without exposing an echoed secret after restart", async () => {
    const { root, store: originalStore, cleanup } =
      await createTestStoreWithRoot();
    cleanups.push(cleanup);
    const secret = "restart-only-secret";
    const requireSecretBlock: BlockImplementation = {
      manifest: {
        id: "test.require-secret",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description:
          "Fails unless protected pre-wait values were restored.",
      },
      execute: async (inputs) => {
        const values = inputs as Record<string, unknown>;
        if (
          values["prior"] !== secret ||
          values["literalFromFrozenWorkflow"] !== secret
        ) {
          throw new Error("protected continuation was not restored");
        }
        return inputs;
      },
    };
    const redact = (
      record: unknown,
      resolved: ReadonlySet<string>,
    ): unknown => {
      let json = JSON.stringify(record);
      for (const value of resolved) {
        json = json.replaceAll(value, "[REDACTED]");
      }
      return JSON.parse(json);
    };
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "source",
            uses: "test.echo",
            with: { value: "{{ secrets.API_KEY }}" },
          },
          {
            id: "pause",
            uses: "wait.manual",
            with: {
              prior:
                "{{ steps.source.outputs.echoed.value }}",
            },
          },
          {
            id: "after",
            uses: "test.require-secret",
            with: {
              prior:
                "{{ steps.source.outputs.echoed.value }}",
              literalFromFrozenWorkflow: secret,
            },
          },
        ],
      },
    });
    await originalStore.workflows.put(workflow);
    const engine1 = createEngine({
      store: originalStore,
      redact,
      resolveSecret: () => secret,
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([
        echoBlock,
        requireSecretBlock,
      ]),
    });
    const run = await engine1.triggerRun({
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    const waiting = await engine1.executeRun(run.runId);
    expect(waiting.status).toBe("waiting");
    expect(waiting.snapshot.definitions).toBeNull();
    expect(JSON.stringify(waiting)).not.toContain(secret);
    const protectedState =
      await originalStore.waits.getOperationalRunState(
        run.runId,
        "pause",
      );
    expect(protectedState?.run.snapshot.definitions).toEqual(
      workflow,
    );
    expect(protectedState?.resolvedSecretValues).toContain(secret);

    const reloadedStore = createFsStore(root);
    const engine2 = createEngine({
      store: reloadedStore,
      redact,
      resolveSecret: () => {
        throw new Error(
          "resume must use the sealed pre-wait secret set",
        );
      },
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([
        echoBlock,
        requireSecretBlock,
      ]),
    });
    const outcome = await engine2.resumeManual(
      run.runId,
      "pause",
      { echoedAfterRestart: secret },
    );

    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("completed");
    expect(outcome.run.trace.map((trace) => trace.stepId)).toEqual([
      "source",
      "pause",
      "after",
    ]);
    expect(JSON.stringify(outcome.run)).not.toContain(secret);
    expect(
      JSON.stringify(await reloadedStore.runs.get(run.runId)),
    ).not.toContain(secret);
  });

  it("reclaims the exact protected continuation after a crash immediately following wait resumption", async () => {
    const { root, store, cleanup } =
      await createTestStoreWithRoot();
    cleanups.push(cleanup);
    const secret = "post-resume-crash-secret";
    const redact = (
      record: unknown,
      refs: ReadonlySet<string>,
    ): unknown => {
      let json = JSON.stringify(record);
      for (const value of refs) {
        json = json.replaceAll(value, "[REDACTED]");
      }
      return JSON.parse(json);
    };
    const requireSecretBlock: BlockImplementation = {
      manifest: {
        id: "test.require-post-resume-secret",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description:
          "Fails unless active protected state survives a post-resume crash.",
      },
      execute: async (inputs) => {
        if (
          (inputs as Record<string, unknown>)["prior"] !== secret
        ) {
          throw new Error(
            "post-resume protected continuation was not restored",
          );
        }
        return { restored: true };
      },
    };
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "source",
            uses: "test.echo",
            with: { value: "{{ secrets.API_KEY }}" },
          },
          { id: "pause", uses: "wait.manual" },
          {
            id: "after",
            uses: requireSecretBlock.manifest.id,
            with: {
              prior:
                "{{ steps.source.outputs.echoed.value }}",
            },
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const engine1 = createEngine({
      store,
      redact,
      resolveSecret: () => secret,
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([
        echoBlock,
        requireSecretBlock,
      ]),
    });
    const triggered = await engine1.triggerRun({
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await engine1.executeRun(triggered.runId);

    const resumeStore = createFsStore(root);
    const resumed = await resumeManualMechanism(
      {
        store: resumeStore,
        redact,
        now: () => new Date(),
      },
      triggered.runId,
      "pause",
      {},
      new Set(),
      async (run) => run,
    );
    expect(resumed.kind).toBe("resumed");
    expect(JSON.stringify(await resumeStore.runs.get(triggered.runId))).not.toContain(
      secret,
    );
    await expect(
      resumeStore.runs.getOperationalState(triggered.runId),
    ).resolves.toMatchObject({
      run: {
        status: "running",
        trace: [
          expect.objectContaining({
            outputs: { echoed: { value: secret } },
          }),
          expect.objectContaining({ status: "completed" }),
        ],
      },
      resolvedSecretValues: expect.arrayContaining([secret]),
    });

    // The resuming process crashes here, before runStepsLoop can write
    // another suspension or terminal state.
    const reclaimStore = createFsStore(root);
    const engineAfterCrash = createEngine({
      store: reclaimStore,
      redact,
      resolveSecret: () => {
        throw new Error("must rehydrate the sealed active state");
      },
      capabilityCheck: alwaysAllowCapabilityCheck,
      blocks: createBlockRegistry([
        echoBlock,
        requireSecretBlock,
      ]),
    });
    const finished = await engineAfterCrash.executeRun(
      triggered.runId,
    );

    expect(finished.status).toBe("completed");
    expect(
      finished.trace.find((trace) => trace.stepId === "after"),
    ).toMatchObject({ outputs: { restored: true } });
    await expect(
      reclaimStore.runs.getOperationalState(triggered.runId),
    ).resolves.toBeUndefined();
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
