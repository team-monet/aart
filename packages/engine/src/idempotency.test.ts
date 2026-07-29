import type { AartStore } from "@aart/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkIdempotency,
  recordIdempotency,
  revokeSecretTaintedIdempotency,
} from "./idempotency.js";
import { idempotencyAssociationFingerprint } from "./idempotency-association.js";
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
