import type { AartStore } from "@aart/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimIdempotencyReplay,
  checkIdempotency,
  idempotencyStorageKey,
  recordIdempotency,
  retainUnsettledIdempotencyReplayClaims,
  revokeSecretTaintedIdempotency,
} from "./idempotency.js";
import { idempotencyAssociationFingerprint } from "./idempotency-association.js";
import { mergeActiveRunProtection } from "./redaction.js";
import {
  createTestStore,
  fixtureRun,
  uniqueId,
} from "./test-utils/fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(): Promise<AartStore> {
  const { store, cleanup } = await createTestStore();
  cleanups.push(cleanup);
  return store;
}

describe("checkIdempotency / recordIdempotency (spec §30.2, architecture §4.2/§5.7)", () => {
  it("checkIdempotency reports not-completed for a never-seen key", async () => {
    const store = await setup();
    expect(await checkIdempotency(store, "never-seen")).toEqual({ alreadyCompleted: false });
  });

  it("recordIdempotency then checkIdempotency reports completed with the recorded output", async () => {
    const store = await setup();
    const runId = uniqueId("run");
    const key = `${runId}:send_email`;
    await recordIdempotency(store, key, runId, "send_email", { sent: true, messageId: "m1" }, new Date());
    const check = await checkIdempotency(store, key);
    expect(check).toEqual({ alreadyCompleted: true, recordedOutput: { sent: true, messageId: "m1" } });
  });

  it("a second attempt with the same resolved key can be checked WITHOUT needing that attempt's own StepTrace to exist yet (architecture §5.7's placement rationale)", async () => {
    // This is exactly the property the dedicated idempotency_ledger
    // collection exists for: check-before-execute, independent of trace
    // history.
    const store = await setup();
    const key = "run1:send_email";
    await recordIdempotency(store, key, "run1", "send_email", { sent: true }, new Date());
    // No StepTrace was ever written for this "second attempt" — checking
    // idempotency doesn't require one.
    expect(await checkIdempotency(store, key)).toMatchObject({ alreadyCompleted: true });
  });

  it("registers a replay consumer before its trace exists so concurrent revocation protects the pending continuation", async () => {
    const store = await setup();
    const secret = "late-cache-secret";
    const producer = fixtureRun({
      runId: "claim-producer",
      trace: [
        {
          seq: 0,
          stepId: "produce",
          block: "test.produce",
          status: "completed",
          inputs: {},
          outputs: { value: secret },
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const consumer = fixtureRun({
      runId: "claim-consumer",
      status: "running",
      trace: [],
    });
    await store.runs.put(producer);
    await store.runs.put(consumer);
    await store.runs.putOperationalState(consumer.runId, {
      run: consumer,
      resolvedSecretValues: [],
    });
    await recordIdempotency(
      store,
      "shared-key",
      producer.runId,
      "produce",
      { value: secret },
      new Date(),
      0,
    );
    const resolvedSecretRefs = new Set<string>();

    await expect(
      claimIdempotencyReplay(
        store,
        "shared-key",
        consumer,
        "consume",
        0,
        resolvedSecretRefs,
        () => true,
      ),
    ).resolves.toMatchObject({
      alreadyCompleted: true,
      recordedOutput: { value: secret },
    });
    await expect(
      store.runs.getOperationalState(consumer.runId),
    ).resolves.toMatchObject({
      pendingIdempotencyReplays: [
        {
          ledgerKey: idempotencyStorageKey("shared-key"),
          stepId: "consume",
          traceSeq: 0,
        },
      ],
    });

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
    await revokeSecretTaintedIdempotency(
      store,
      redact,
      fixtureRun({ runId: "discoverer" }),
      new Set([secret]),
    );

    await expect(
      store.idempotencyLedger.get(
        idempotencyStorageKey("shared-key"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.runs.getOperationalState(consumer.runId),
    ).resolves.toMatchObject({
      resolvedSecretValues: [secret],
    });
  });

  it("carries non-literal revoked-output taint from a pending claim into its later replay trace", async () => {
    const store = await setup();
    const ledgerKey = idempotencyStorageKey("derived-key");
    const producer = fixtureRun({
      runId: "derived-producer",
      trace: [
        {
          seq: 0,
          stepId: "derive",
          block: "test.derive",
          status: "completed",
          inputs: { source: "[REDACTED]" },
          outputs: { length: 17 },
          idempotencyLedgerKey: ledgerKey,
          idempotencyLedgerFingerprint:
            idempotencyAssociationFingerprint(ledgerKey),
          secretTainted: true,
          secretTaintedPaths: ["*"],
          startedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    });
    const consumer = fixtureRun({
      runId: "derived-consumer",
      status: "running",
      trace: [],
    });
    await store.runs.put(producer);
    await store.runs.put(consumer);
    await store.runs.putOperationalState(consumer.runId, {
      run: consumer,
      resolvedSecretValues: [],
    });
    await store.idempotencyLedger.put({
      resolvedKey: ledgerKey,
      runId: producer.runId,
      stepId: "derive",
      traceSeq: 0,
      recordedOutput: { length: 17 },
      createdAt: "2026-07-29T00:00:00.000Z",
      schemaVersion: 2,
    });
    await claimIdempotencyReplay(
      store,
      "derived-key",
      consumer,
      "reuse",
      0,
      new Set(),
      () => true,
    );

    await revokeSecretTaintedIdempotency(
      store,
      (record) => record,
      fixtureRun({ runId: "discoverer" }),
      new Set(["unrelated-literal"]),
    );

    const claimedState =
      await store.runs.getOperationalState(consumer.runId);
    expect(
      claimedState?.pendingIdempotencyReplays,
    ).toEqual([
      {
        ledgerKey,
        stepId: "reuse",
        traceSeq: 0,
        outputSecretTainted: true,
      },
    ]);

    const replayTraceRun = {
      ...consumer,
      trace: [
        {
          seq: 0,
          stepId: "reuse",
          block: "test.reuse",
          status: "completed" as const,
          inputs: {},
          outputs: { length: 17 },
          idempotencyLedgerFingerprint:
            idempotencyAssociationFingerprint(ledgerKey),
          startedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    };
    const protectedRun = await mergeActiveRunProtection(
      store,
      replayTraceRun,
      new Set(),
    );

    expect(protectedRun.trace[0]).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
    expect(
      retainUnsettledIdempotencyReplayClaims(
        claimedState,
        protectedRun,
      ),
    ).toBeUndefined();
  });

  it("clears a revoked replay claim before a reclaimed occurrence executes fresh output", async () => {
    const store = await setup();
    const ledgerKey = idempotencyStorageKey("reclaimed-key");
    const producer = fixtureRun({
      runId: "reclaimed-producer",
      trace: [
        {
          seq: 0,
          stepId: "produce",
          block: "test.produce",
          status: "completed",
          inputs: { source: "[REDACTED]" },
          outputs: { length: 17 },
          idempotencyLedgerKey: ledgerKey,
          secretTainted: true,
          secretTaintedPaths: ["*"],
          startedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    });
    const consumer = fixtureRun({
      runId: "reclaimed-consumer",
      status: "running",
      trace: [],
    });
    await store.runs.put(producer);
    await store.runs.put(consumer);
    await store.runs.putOperationalState(consumer.runId, {
      run: consumer,
      resolvedSecretValues: [],
    });
    await store.idempotencyLedger.put({
      resolvedKey: ledgerKey,
      runId: producer.runId,
      stepId: "produce",
      traceSeq: 0,
      recordedOutput: { length: 17 },
      createdAt: "2026-07-29T00:00:00.000Z",
      schemaVersion: 2,
    });
    await claimIdempotencyReplay(
      store,
      "reclaimed-key",
      consumer,
      "reuse",
      0,
      new Set(),
      () => true,
    );
    await revokeSecretTaintedIdempotency(
      store,
      (record) => record,
      fixtureRun({ runId: "discoverer" }),
      new Set(["late-secret"]),
    );
    await expect(
      store.runs.getOperationalState(consumer.runId),
    ).resolves.toMatchObject({
      pendingIdempotencyReplays: [
        expect.objectContaining({
          stepId: "reuse",
          traceSeq: 0,
          outputSecretTainted: true,
        }),
      ],
    });

    await expect(
      claimIdempotencyReplay(
        store,
        "reclaimed-key",
        consumer,
        "reuse",
        0,
        new Set(),
        () => true,
      ),
    ).resolves.toEqual({ alreadyCompleted: false });
    const reclaimedState =
      await store.runs.getOperationalState(consumer.runId);
    expect(
      reclaimedState?.pendingIdempotencyReplays,
    ).toBeUndefined();

    const protectedFreshRun = await mergeActiveRunProtection(
      store,
      {
        ...consumer,
        trace: [
          {
            seq: 0,
            stepId: "reuse",
            block: "test.reuse",
            status: "completed",
            inputs: {},
            outputs: { length: 3 },
            startedAt: "2026-07-29T00:00:00.000Z",
          },
        ],
      },
      new Set(),
    );
    expect(protectedFreshRun.trace[0]?.secretTainted).not.toBe(
      true,
    );
  });

  it("does not replay a legacy entry that collides with the current storage-key string", async () => {
    const store = await setup();
    await store.idempotencyLedger.put({
      resolvedKey: "v2:charge-123",
      runId: "legacy-run",
      stepId: "charge",
      recordedOutput: { charged: "legacy" },
      createdAt: new Date().toISOString(),
    });

    await expect(checkIdempotency(store, "charge-123")).resolves.toEqual({
      alreadyCompleted: false,
    });
  });

  it("reconstructs only the active run and ledger graph, not unrelated retained history", async () => {
    const store = await setup();
    const ledgerKey = "v2:producer-key";
    const producer = fixtureRun({
      runId: "producer-run",
      trace: [
        {
          seq: 0,
          stepId: "derive",
          block: "test.derive",
          status: "completed",
          inputs: { source: "late-secret" },
          outputs: { length: 11 },
          idempotencyLedgerKey: ledgerKey,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 0,
        },
      ],
    });
    await store.runs.put(producer);
    for (let index = 0; index < 12; index += 1) {
      await store.runs.put(
        fixtureRun({ runId: `unrelated-${index}` }),
      );
    }
    await store.idempotencyLedger.put({
      resolvedKey: ledgerKey,
      runId: producer.runId,
      stepId: "derive",
      recordedOutput: { length: 11 },
      createdAt: new Date().toISOString(),
      schemaVersion: 2,
    });
    const preparedRunIds: string[] = [];
    await revokeSecretTaintedIdempotency(
      store,
      (record) => record,
      fixtureRun({ runId: "active-run" }),
      new Set(["late-secret"]),
      async (_store, candidate) => {
        preparedRunIds.push(candidate.runId);
        return candidate.runId === producer.runId
          ? {
              ...candidate,
              trace: candidate.trace.map((trace) => ({
                ...trace,
                secretTainted: true,
                secretTaintedPaths: ["*"],
              })),
            }
          : candidate;
      },
    );
    expect(preparedRunIds).toContain("active-run");
    expect(preparedRunIds).toContain("producer-run");
    expect(
      preparedRunIds.some((runId) =>
        runId.startsWith("unrelated-"),
      ),
    ).toBe(false);
  });

  it("revokes a derivative ledger output when its producer trace never committed", async () => {
    const store = await setup();
    const ledgerKey = "v2:crash-gap";
    const producer = fixtureRun({
      runId: "crashed-producer",
      trace: [],
    });
    await store.runs.put(producer);
    await store.idempotencyLedger.put({
      resolvedKey: ledgerKey,
      runId: producer.runId,
      stepId: "derive",
      traceSeq: 0,
      recordedOutput: { length: 19 },
      createdAt: new Date().toISOString(),
      schemaVersion: 2,
    });

    await revokeSecretTaintedIdempotency(
      store,
      (record) => record,
      fixtureRun({ runId: "active-run" }),
      new Set(["late-secret"]),
    );

    await expect(
      store.idempotencyLedger.get(ledgerKey),
    ).resolves.toBeUndefined();
  });

  it("finds and taints prior consumers through the stable fingerprint after the audit key is redacted", async () => {
    const store = await setup();
    const ledgerKey = "v2:secret-bearing-key";
    const fingerprint =
      idempotencyAssociationFingerprint(ledgerKey);
    const producer = fixtureRun({
      runId: "producer",
      trace: [
        {
          seq: 0,
          stepId: "derive",
          block: "test.derive",
          status: "completed",
          inputs: {},
          outputs: { length: 21 },
          idempotencyLedgerKey: "[REDACTED]",
          idempotencyLedgerFingerprint: fingerprint,
          secretTainted: true,
          secretTaintedPaths: ["*"],
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const consumer = fixtureRun({
      runId: "consumer",
      trace: [
        {
          seq: 0,
          stepId: "reuse",
          block: "test.reuse",
          status: "completed",
          inputs: {},
          outputs: { length: 21 },
          idempotencyLedgerKey: "[REDACTED]",
          idempotencyLedgerFingerprint: fingerprint,
          startedAt: new Date().toISOString(),
        },
      ],
    });
    await store.runs.put(producer);
    await store.runs.put(consumer);
    await store.idempotencyLedger.put({
      resolvedKey: ledgerKey,
      runId: producer.runId,
      stepId: "derive",
      traceSeq: 0,
      recordedOutput: { length: 21 },
      createdAt: new Date().toISOString(),
      schemaVersion: 2,
    });

    await revokeSecretTaintedIdempotency(
      store,
      (record) => record,
      fixtureRun({ runId: "active-run" }),
      new Set(["late-secret"]),
    );

    await expect(
      store.idempotencyLedger.get(ledgerKey),
    ).resolves.toBeUndefined();
    expect(
      (await store.runs.get(consumer.runId))?.trace[0],
    ).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
  });
});
