// fs-adapter-specific behaviors not covered by the adapter-agnostic
// conformance suite: the documented non-atomic signals-audit-copy gap
// (architecture §5.8), atomic write-temp-then-rename hygiene, and the
// concrete .aart/ directory layout (architecture §5.2).
import { createCipheriv, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AartStore,
  WaitOperationalRunState,
} from "../../types.js";
import { createFsStore } from "./index.js";
import {
  createStagingBuffer,
  flushStagingBuffer,
  JsonFileHandle,
} from "./json-file.js";
import * as paths from "./paths.js";

let root: string;
let store: AartStore;

function continuationState(
  secret: string,
): WaitOperationalRunState {
  const now = new Date().toISOString();
  return {
    run: {
      runId: "run_state_replay",
      workflowId: "wf",
      workflowVersion: "1",
      status: "waiting",
      approved: true,
      approvalMode: "governed",
      trigger: {
        type: "manual",
        id: "trigger",
        source: "cli",
        payload: null,
        receivedAt: now,
      },
      inputs: { secret },
      trace: [],
      waits: [{ type: "manual", schemaVersion: 1 }],
      artifacts: [],
      snapshot: {
        definitions: {},
        resolvedVersions: {},
        packHashes: {},
        capturedAt: now,
      },
      startedAt: now,
      updatedAt: now,
      schemaVersion: 1,
    },
    resolvedSecretValues: [secret],
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aart-store-fs-"));
  store = createFsStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("fs adapter — .aart/ layout (architecture §5.2)", () => {
  it("writes a run under runs/<runId>.json", async () => {
    const run = {
      runId: "run_layout_1",
      workflowId: "wf",
      workflowVersion: "1",
      status: "running" as const,
      approved: true,
      approvalMode: "governed" as const,
      trigger: { type: "manual" as const, id: "t1", source: "cli", payload: null, receivedAt: new Date().toISOString() },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: new Date().toISOString() },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    await store.runs.put(run);
    const onDisk = await fs.readFile(join(paths.runsDir(root), "run_layout_1.json"), "utf8");
    expect(JSON.parse(onDisk).record.runId).toBe("run_layout_1");
  });

  it("keeps an active run continuation sealed beside its public audit record", async () => {
    const secret = "active-run-secret";
    const publicRun = continuationState(secret).run;
    publicRun.inputs = { secret: "[REDACTED]" };
    await store.runs.put(publicRun);
    await store.runs.putOperationalState(publicRun.runId, {
      run: {
        ...publicRun,
        inputs: { secret },
      },
      resolvedSecretValues: [secret],
    });

    const onDisk = await fs.readFile(
      join(paths.runsDir(root), `${publicRun.runId}.json`),
      "utf8",
    );
    expect(onDisk).not.toContain(secret);
    await expect(
      store.runs.getOperationalState(publicRun.runId),
    ).resolves.toMatchObject({
      run: { inputs: { secret } },
      resolvedSecretValues: [secret],
    });
  });

  it("shares one mutex across symlink aliases before the store directory exists", async () => {
    const container = await fs.mkdtemp(
      join(tmpdir(), "aart-store-fs-alias-"),
    );
    try {
      const physicalParent = join(container, "physical");
      const aliasParent = join(container, "alias");
      await fs.mkdir(physicalParent);
      await fs.symlink(physicalParent, aliasParent, "dir");
      const firstStore = createFsStore(
        join(physicalParent, ".aart"),
      );
      const aliasStore = createFsStore(join(aliasParent, ".aart"));
      let releaseFirst!: () => void;
      let markFirstEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        markFirstEntered = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = firstStore.transact(async () => {
        markFirstEntered();
        await firstGate;
      });
      await firstEntered;
      let secondEntered = false;
      const second = aliasStore.transact(async () => {
        secondEntered = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondEntered).toBe(false);

      releaseFirst();
      await Promise.all([first, second]);
      expect(secondEntered).toBe(true);
    } finally {
      await fs.rm(container, { recursive: true, force: true });
    }
  });

  it("keeps late-redacted wait operation values sealed on disk", async () => {
    const wait = {
      type: "external_job" as const,
      provider: "late-secret",
      jobId: "late-secret",
      timeout: "late-secret",
      schemaVersion: 1,
    };
    await store.waits.put(
      "run_wait_sealed",
      "wait_job",
      wait,
      new Date().toISOString(),
    );
    await store.waits.redactAudit(
      "run_wait_sealed",
      "wait_job",
      {
        ...wait,
        provider: "[REDACTED]",
        jobId: "[REDACTED]",
        timeout: "[REDACTED]",
      },
    );
    const persisted = await fs.readFile(
      join(
        paths.waitsDir(root),
        "run_wait_sealed__wait_job.json",
      ),
      "utf8",
    );
    expect(persisted).not.toContain("late-secret");
    await expect(
      store.waits.listOperational({ runId: "run_wait_sealed" }),
    ).resolves.toEqual([
      expect.objectContaining({ wait }),
    ]);
    const restartedStore = createFsStore(root);
    await expect(
      restartedStore.waits.listOperational({
        runId: "run_wait_sealed",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ wait }),
    ]);
    const keyStat = await fs.stat(
      join(paths.waitsDir(root), ".operational-key"),
    );
    expect(keyStat.mode & 0o777).toBe(0o600);
  });

  it("binds sealed wait operation state to its run and step identity", async () => {
    const first = {
      type: "timer" as const,
      resumeAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    };
    const second = {
      ...first,
      resumeAt: "2026-01-02T00:00:00.000Z",
    };
    await store.waits.put("run_a", "wait_a", first, first.resumeAt);
    await store.waits.put("run_b", "wait_b", second, second.resumeAt);
    const firstPath = join(
      paths.waitsDir(root),
      "run_a__wait_a.json",
    );
    const secondPath = join(
      paths.waitsDir(root),
      "run_b__wait_b.json",
    );
    const firstStored = JSON.parse(
      await fs.readFile(firstPath, "utf8"),
    ) as Record<string, unknown>;
    const secondStored = JSON.parse(
      await fs.readFile(secondPath, "utf8"),
    ) as Record<string, unknown>;
    firstStored["operationalWait"] =
      secondStored["operationalWait"];
    await fs.writeFile(
      firstPath,
      JSON.stringify(firstStored),
      "utf8",
    );
    await expect(
      createFsStore(root).waits.get("run_a", "wait_a"),
    ).rejects.toThrow();
  });

  it("rejects replay of an older generation for the same wait step", async () => {
    const waitPath = join(
      paths.waitsDir(root),
      "run_loop__wait_loop.json",
    );
    await store.waits.put(
      "run_loop",
      "wait_loop",
      {
        type: "timer",
        resumeAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      "2026-01-01T00:00:00.000Z",
    );
    const firstGeneration = JSON.parse(
      await fs.readFile(waitPath, "utf8"),
    ) as Record<string, unknown>;
    await store.waits.put(
      "run_loop",
      "wait_loop",
      {
        type: "timer",
        resumeAt: "2026-01-02T00:00:00.000Z",
        schemaVersion: 1,
      },
      "2026-01-02T00:00:00.000Z",
    );
    const secondGeneration = JSON.parse(
      await fs.readFile(waitPath, "utf8"),
    ) as Record<string, unknown>;
    secondGeneration["operationalWait"] =
      firstGeneration["operationalWait"];
    await fs.writeFile(
      waitPath,
      JSON.stringify(secondGeneration),
      "utf8",
    );
    await expect(
      createFsStore(root).waits.get(
        "run_loop",
        "wait_loop",
      ),
    ).rejects.toThrow();
  });

  it("rotates the authenticated generation when continuation state is replaced", async () => {
    const waitPath = join(
      paths.waitsDir(root),
      "run_state_replay__pause.json",
    );
    const wait = {
      type: "manual" as const,
      schemaVersion: 1,
    };
    const first = continuationState("first-secret");
    await store.waits.put(
      first.run.runId,
      "pause",
      wait,
      new Date().toISOString(),
      first,
    );
    const firstStored = JSON.parse(
      await fs.readFile(waitPath, "utf8"),
    ) as Record<string, unknown>;

    await store.waits.replaceOperationalRunState(
      first.run.runId,
      continuationState("second-secret"),
    );
    const secondStored = JSON.parse(
      await fs.readFile(waitPath, "utf8"),
    ) as Record<string, unknown>;
    expect(secondStored["operationalGeneration"]).not.toBe(
      firstStored["operationalGeneration"],
    );

    secondStored["operationalRunState"] =
      firstStored["operationalRunState"];
    await fs.writeFile(
      waitPath,
      JSON.stringify(secondStored),
      "utf8",
    );
    await expect(
      createFsStore(root).waits.getOperationalRunState(
        first.run.runId,
        "pause",
      ),
    ).rejects.toThrow();
  });

  it("rotates the authenticated generation when an unconsumed signal audit is replaced", async () => {
    const signal = {
      id: "signal_state_replay",
      name: "signal-name",
      correlationId: "signal-correlation",
      payload: { token: "first-secret" },
      receivedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.signals.append(signal);
    const originalPath = join(
      paths.signalsDir(root),
      "signal-correlation__2026-01-01T00_00_00.000Z.json",
    );
    const firstStored = JSON.parse(
      await fs.readFile(originalPath, "utf8"),
    ) as Record<string, unknown>;

    await store.signals.replaceAudit(
      signal.id,
      {
        name: "[REDACTED]",
        correlationId: "[REDACTED]",
        payload: { token: "[REDACTED]" },
      },
      ["first-secret"],
    );
    const replacementName = (
      await fs.readdir(paths.signalsDir(root))
    ).find((name) => name.endsWith(".json"));
    expect(replacementName).toBeDefined();
    const replacementPath = join(
      paths.signalsDir(root),
      replacementName!,
    );
    const secondStored = JSON.parse(
      await fs.readFile(replacementPath, "utf8"),
    ) as Record<string, unknown>;
    expect(secondStored["operationalGeneration"]).not.toBe(
      firstStored["operationalGeneration"],
    );

    secondStored["operationalSignal"] =
      firstStored["operationalSignal"];
    await fs.writeFile(
      replacementPath,
      JSON.stringify(secondStored),
      "utf8",
    );
    await expect(
      createFsStore(root).signals.findUnconsumedMatch(
        signal.name,
        signal.correlationId,
      ),
    ).rejects.toThrow();
  });

  it("reads a v1 wait seal and rotates it to a generation-bound v2 seal", async () => {
    const runId = "run-v1-wait";
    const stepId = "wait-v1";
    const createdAt = "2026-01-01T00:00:00.000Z";
    const wait = {
      type: "timer" as const,
      resumeAt: "2026-01-02T00:00:00.000Z",
      schemaVersion: 1,
    };
    await store.waits.put(runId, stepId, wait, createdAt);
    const keyPath = join(
      paths.waitsDir(root),
      ".operational-key",
    );
    const key = await fs.readFile(keyPath);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(
      Buffer.from(JSON.stringify([runId, stepId]), "utf8"),
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(wait), "utf8"),
      cipher.final(),
    ]);
    const v1 = [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
    const waitPath = join(
      paths.waitsDir(root),
      `${runId}__${stepId}.json`,
    );
    const stored = JSON.parse(
      await fs.readFile(waitPath, "utf8"),
    ) as Record<string, unknown>;
    stored["operationalWait"] = v1;
    delete stored["operationalGeneration"];
    await fs.writeFile(waitPath, JSON.stringify(stored), "utf8");

    await expect(
      createFsStore(root).waits.get(runId, stepId),
    ).resolves.toEqual(wait);
    const rotated = JSON.parse(
      await fs.readFile(waitPath, "utf8"),
    ) as Record<string, unknown>;
    expect(rotated["operationalWait"]).toEqual(
      expect.stringMatching(/^v2\./),
    );
    expect(typeof rotated["operationalGeneration"]).toBe("string");
  });

  it("recovers an interrupted artifact redaction before exposing metadata or bytes", async () => {
    const artifact = {
      id: "artifact-interrupted-redaction",
      runId: "run-artifact-recovery",
      stepId: "capture",
      name: "late-secret",
      kind: "late-secret",
      mime: "text/late-secret",
      path: "late-secret/report.txt",
      bytes: 11,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await store.artifacts.put(
      artifact,
      new TextEncoder().encode("late-secret"),
    );
    const runDir = join(
      paths.artifactsDir(root),
      artifact.runId,
    );
    const stagedBlobName = ".staged-redacted.blob";
    await fs.writeFile(
      join(runDir, stagedBlobName),
      new TextEncoder().encode("[REDACTED]"),
    );
    const journalDir = join(
      paths.artifactsDir(root),
      ".redaction-journal",
    );
    await fs.mkdir(journalDir, { recursive: true });
    await fs.writeFile(
      join(journalDir, "interrupted.json"),
      JSON.stringify({
        version: 1,
        artifactId: artifact.id,
        runId: artifact.runId,
        updated: {
          ...artifact,
          name: "[REDACTED]",
          kind: "[REDACTED]",
          mime: "text/[REDACTED]",
          path: "[REDACTED]/report.txt",
          bytes: 10,
          redactionTextEligible: true,
        },
        stagedBlobName,
      }),
      "utf8",
    );

    const restartedStore = createFsStore(root);
    await expect(
      restartedStore.artifacts.getMetadata(artifact.id),
    ).resolves.toMatchObject({
      name: "[REDACTED]",
      kind: "[REDACTED]",
      mime: "text/[REDACTED]",
      path: "[REDACTED]/report.txt",
      bytes: 10,
    });
    await expect(
      restartedStore.artifacts.getBytes(artifact.id),
    ).resolves.toEqual(
      new TextEncoder().encode("[REDACTED]"),
    );
    await expect(fs.readdir(journalDir)).resolves.toEqual([]);
  });

  it("writes a workflow under registry/workflows/<workflowId>/<version>.json", async () => {
    await store.workflows.put({
      id: "wf_layout",
      name: "n",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "draft",
      gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    });
    const onDisk = await fs.readFile(join(paths.registryWorkflowsDir(root), "wf_layout", "0.1.0.json"), "utf8");
    expect(JSON.parse(onDisk).id).toBe("wf_layout");
  });

  it("leaves no .tmp- files behind after a successful write (write-temp-then-rename hygiene)", async () => {
    await store.approvals.put({ id: "at_1", runId: "run_1", stepId: "s1", title: "t", description: "d", status: "pending", createdAt: new Date().toISOString() });
    const entries = await fs.readdir(paths.approvalsDir(root));
    expect(entries.every((f) => !f.startsWith(".tmp-"))).toBe(true);
    expect(entries).toContain("at_1.json");
  });
});

describe("fs adapter — documented non-atomic gap: the global signals audit copy (architecture §5.8)", () => {
  it("marks the signals audit copy consumed even when the surrounding transact() callback later throws — signals writes are NOT staged/rolled-back", async () => {
    const signal = { id: "sig_gap_1", name: "quote.received", correlationId: "corr_gap_1", payload: {}, receivedAt: new Date().toISOString() };
    await store.signals.append(signal);

    await expect(
      store.transact(async (tx) => {
        // A real caller would also update run state here; this test isolates
        // the documented gap by having the transaction touch `signals`
        // (not staged) and then fail before anything staged would commit.
        await tx.signals.markConsumed(signal.id);
        throw new Error("simulated crash after the (unstaged) signals write, before the transaction would otherwise commit");
      }),
    ).rejects.toThrow();

    // The signals audit copy's consumed flag is NOT rolled back — this is
    // the accepted, documented gap (architecture §5.8): "under fs, a crash
    // between the two could leave a consumed signal's audit copy showing
    // consumed:false even though the run already advanced (or, much less
    // likely, vice versa)."
    await expect(store.signals.findUnconsumedMatch("quote.received", "corr_gap_1")).resolves.toBeUndefined();
  });
});

describe("fs adapter — root-scoped operation serialization", () => {
  it("recovers a crash after a ledger deletion but before its consumer repair flushes", async () => {
    const ledgerPath = join(
      paths.idempotencyDir(root),
      "revoked-entry.json",
    );
    const consumerPath = join(
      paths.runsDir(root),
      "terminal-consumer.json",
    );
    await fs.mkdir(paths.idempotencyDir(root), {
      recursive: true,
    });
    await fs.mkdir(paths.runsDir(root), { recursive: true });
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({ resolvedKey: "revoked" }),
    );
    await fs.writeFile(
      consumerPath,
      JSON.stringify({ repaired: false }),
    );

    const staging = createStagingBuffer();
    await new JsonFileHandle(ledgerPath, staging).delete();
    await new JsonFileHandle(consumerPath, staging).write({
      repaired: true,
    });
    await expect(
      flushStagingBuffer(staging, root, {
        afterEntryApplied(index) {
          if (index === 0) {
            throw new Error("simulated process exit");
          }
        },
      }),
    ).rejects.toThrow(/simulated process exit/);

    await expect(fs.stat(ledgerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(consumerPath, "utf8").then(JSON.parse),
    ).resolves.toEqual({ repaired: false });

    const recoveredStore = createFsStore(root);
    await recoveredStore.runs.list();
    await expect(fs.stat(ledgerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.readFile(consumerPath, "utf8").then(JSON.parse),
    ).resolves.toEqual({ repaired: true });
    await expect(
      fs.readdir(join(root, ".transactions")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes transactions across two store handles so a stale run cannot overwrite newer progress", async () => {
    const run = continuationState("raw").run;
    await store.runs.put(run);
    const secondStore = createFsStore(root);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.transact(async (tx) => {
      events.push("first:start");
      const current = await tx.runs.get(run.runId);
      markFirstEntered();
      await firstGate;
      await tx.runs.put({
        ...current!,
        trace: [
          {
            seq: 0,
            stepId: "completed",
            block: "test.echo",
            status: "completed",
            inputs: {},
            outputs: { value: "new-progress" },
            startedAt: new Date().toISOString(),
          },
        ],
      });
      events.push("first:end");
    });
    await firstEntered;
    const second = secondStore.transact(async (tx) => {
      events.push("second:start");
      const current = await tx.runs.get(run.runId);
      expect(current?.trace).toHaveLength(1);
      expect(current?.trace[0]?.outputs).toEqual({
        value: "new-progress",
      });
      events.push("second:end");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("serializes an immediate signal transition with a transaction audit rewrite", async () => {
    const signal = {
      id: "serialized-signal",
      name: "secret-name",
      correlationId: "secret-correlation",
      payload: { value: "secret-value" },
      receivedAt: new Date().toISOString(),
    };
    await store.signals.append(signal);
    const secondStore = createFsStore(root);
    let releaseRepair!: () => void;
    let markRepairEntered!: () => void;
    const repairEntered = new Promise<void>((resolve) => {
      markRepairEntered = resolve;
    });
    const repairGate = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });

    const repair = store.transact(async (tx) => {
      markRepairEntered();
      await repairGate;
      await tx.signals.replaceAudit(signal.id, {
        name: "[REDACTED]",
        correlationId: "[REDACTED]",
        payload: { value: "[REDACTED]" },
      });
    });
    await repairEntered;
    let consumed = false;
    const consume = secondStore.signals
      .markConsumed(signal.id)
      .then(() => {
        consumed = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(consumed).toBe(false);

    releaseRepair();
    await Promise.all([repair, consume]);
    await expect(
      store.signals.findUnconsumedMatch(
        signal.name,
        signal.correlationId,
      ),
    ).resolves.toBeUndefined();
    await expect(store.signals.list()).resolves.toEqual([
      {
        ...signal,
        name: "[REDACTED]",
        correlationId: "[REDACTED]",
        payload: { value: "[REDACTED]" },
      },
    ]);
  });
});

describe("fs adapter — signals directory layout", () => {
  it("writes a signal under signals/<correlationId>__<receivedAt>.json", async () => {
    const receivedAt = new Date().toISOString();
    await store.signals.append({ id: "sig_layout", name: "n", correlationId: "corr_layout", payload: {}, receivedAt });
    const entries = await fs.readdir(paths.signalsDir(root));
    expect(entries.some((f) => f.startsWith("corr_layout__"))).toBe(true);
  });

  it("renames a consumed signal when late redaction changes its correlation audit", async () => {
    const signal = {
      id: "sig_late_redaction",
      name: "late-secret",
      correlationId: "late-secret",
      payload: { value: "late-secret" },
      receivedAt: new Date().toISOString(),
    };
    await store.signals.append(signal);
    await store.signals.markConsumed(signal.id);
    await store.signals.replaceAudit(signal.id, {
      name: "[REDACTED]",
      correlationId: "[REDACTED]",
      payload: { value: "[REDACTED]" },
    });
    const entries = await fs.readdir(paths.signalsDir(root));
    expect(entries.some((file) => file.includes("late-secret"))).toBe(
      false,
    );
    const persisted = await Promise.all(
      entries.map((file) =>
        fs.readFile(join(paths.signalsDir(root), file), "utf8"),
      ),
    );
    expect(persisted.join("\n")).not.toContain("late-secret");
  });

  it("finishes an interrupted late-redaction filename move before exposing the signal store", async () => {
    const signal = {
      id: "sig_interrupted_redaction",
      name: "late-secret",
      correlationId: "late-secret",
      payload: { value: "late-secret" },
      receivedAt: "2026-01-01T00:00:00.000Z",
    };
    await store.signals.append(signal);
    await store.signals.markConsumed(signal.id);
    const [oldFilename] = (
      await fs.readdir(paths.signalsDir(root))
    ).filter((file) => file.endsWith(".json"));
    if (!oldFilename) throw new Error("signal file missing");
    const oldPath = join(paths.signalsDir(root), oldFilename);
    const interrupted = JSON.parse(
      await fs.readFile(oldPath, "utf8"),
    ) as Record<string, unknown>;
    Object.assign(interrupted, {
      name: "[REDACTED]",
      correlationId: "[REDACTED]",
      payload: { value: "[REDACTED]" },
      auditFileNonce: "recovery-nonce",
    });
    await fs.writeFile(
      oldPath,
      JSON.stringify(interrupted),
      "utf8",
    );

    await expect(
      createFsStore(root).signals.list(),
    ).resolves.toEqual([
      {
        ...signal,
        name: "[REDACTED]",
        correlationId: "[REDACTED]",
        payload: { value: "[REDACTED]" },
      },
    ]);
    const recoveredFilenames = (
      await fs.readdir(paths.signalsDir(root))
    ).filter((file) => file.endsWith(".json"));
    expect(recoveredFilenames).toHaveLength(1);
    expect(recoveredFilenames[0]).not.toContain("late-secret");
    expect(recoveredFilenames[0]).toContain("recovery-nonce");
  });
});
