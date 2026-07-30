// The wait/resume machine's own test suite — architecture §4.4, the
// implementation plan's own framing: "the highest-risk code in the whole
// system." Tests against the REAL S0 fs adapter (createFsStore), not a
// hand-rolled mock, per this session's DoD ("it should pass its own tests
// against the fs adapter from S0").
import type { AartStore } from "@aart/store";
import { CorrelationError, type RedactFn, type RunRecord, type Signal } from "@aart/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONCURRENCY_KEY_FORMAT,
  fingerprintConcurrencyKey,
} from "../concurrency.js";
import {
  identityRedactFn,
  repairGlobalAuditsForNewSecrets,
} from "../redaction.js";
import { CURRENT_ENGINE_SCHEMA_VERSION } from "../schema-version.js";
import { createTestStore, fixtureRun, uniqueId } from "../test-utils/fixtures.js";
import {
  enterWait,
  failExpiredWait,
  getDueWaits,
  getExpiredWaits,
  listExternalJobWaits,
  resumeApproval as resumeApprovalWithPreparation,
  resumeBySignal as resumeBySignalWithPreparation,
  resumeExternalJobResult as resumeExternalJobResultWithPreparation,
  resumeManual as resumeManualWithPreparation,
  resumeTimerWait as resumeTimerWaitWithPreparation,
  type WaitMachineConfig,
} from "./wait-machine.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(): Promise<{ store: AartStore; config: WaitMachineConfig }> {
  const { store, cleanup } = await createTestStore();
  cleanups.push(cleanup);
  return { store, config: { store, redact: identityRedactFn, now: () => new Date() } };
}

function redactLiteral(secret: string): RedactFn {
  return (record) => JSON.parse(JSON.stringify(record).replaceAll(secret, "[REDACTED]"));
}

const prepareCompletedRun = async (run: RunRecord): Promise<RunRecord> => run;

function resumeBySignal(
  config: WaitMachineConfig,
  signal: Signal,
  resolvedSecretRefs: ReadonlySet<string> = new Set(),
) {
  return resumeBySignalWithPreparation(
    config,
    signal,
    resolvedSecretRefs,
    prepareCompletedRun,
  );
}

function resumeManual(
  config: WaitMachineConfig,
  runId: string,
  stepId: string,
  payload: unknown = {},
  resolvedSecretRefs: ReadonlySet<string> = new Set(),
) {
  return resumeManualWithPreparation(
    config,
    runId,
    stepId,
    payload,
    resolvedSecretRefs,
    prepareCompletedRun,
  );
}

function resumeApproval(
  config: WaitMachineConfig,
  runId: string,
  stepId: string,
  task: {
    id: string;
    status: string;
    decision?: unknown;
    reviewer?: string;
  },
  resolvedSecretRefs: ReadonlySet<string> = new Set(),
) {
  return resumeApprovalWithPreparation(
    config,
    runId,
    stepId,
    task,
    resolvedSecretRefs,
    prepareCompletedRun,
  );
}

function resumeTimerWait(
  config: WaitMachineConfig,
  runId: string,
  stepId: string,
  resolvedSecretRefs: ReadonlySet<string> = new Set(),
) {
  return resumeTimerWaitWithPreparation(
    config,
    runId,
    stepId,
    resolvedSecretRefs,
    prepareCompletedRun,
  );
}

function resumeExternalJobResult(
  config: WaitMachineConfig,
  runId: string,
  stepId: string,
  resultPayload: unknown,
  resolvedSecretRefs: ReadonlySet<string> = new Set(),
) {
  return resumeExternalJobResultWithPreparation(
    config,
    runId,
    stepId,
    resultPayload,
    resolvedSecretRefs,
    prepareCompletedRun,
  );
}

describe("enterWait — no early match (architecture §4.4 steps 1-4)", () => {
  it("persists RunRecord.status = waiting, appends the WaitCondition to RunRecord.waits, and creates a WaitStore row", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);

    const wait = { type: "signal" as const, name: "quote.received", correlationId: "corr1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION };
    const result = await enterWait(config, { run, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: { name: "quote.received", correlationId: "corr1" }, wait, resolvedSecretRefs: new Set() });

    expect(result.suspended).toBe(true);
    expect(result.run.status).toBe("waiting");
    expect(result.run.waits).toContainEqual(wait);

    const persisted = await store.runs.get(run.runId);
    expect(persisted?.status).toBe("waiting");
    const waitRow = await store.waits.get(run.runId, "wait_step");
    expect(waitRow).toEqual(wait);
  });

  it("atomically transfers an active protected continuation into the new wait boundary", async () => {
    const { store, config } = await setup();
    const secret = "active-segment-secret";
    const run = fixtureRun({
      status: "running",
      inputs: { value: secret },
    });
    await store.runs.put({
      ...run,
      inputs: { value: "[REDACTED]" },
    });
    await store.runs.putOperationalState(run.runId, {
      run,
      resolvedSecretValues: [secret],
    });

    await enterWait(
      { ...config, redact: redactLiteral(secret) },
      {
        run,
        stepId: "pause",
        blockId: "wait.manual",
        resolvedInputs: {},
        wait: {
          type: "manual",
          schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION,
        },
        resolvedSecretRefs: new Set([secret]),
      },
    );

    await expect(
      store.runs.getOperationalState(run.runId),
    ).resolves.toBeUndefined();
    await expect(
      store.waits.getOperationalRunState(run.runId, "pause"),
    ).resolves.toMatchObject({
      run: {
        status: "waiting",
        inputs: { value: secret },
      },
      resolvedSecretValues: [secret],
    });
    expect(
      JSON.stringify(await store.runs.get(run.runId)),
    ).not.toContain(secret);
  });

  it("records a StepTrace with status 'waiting' for the wait step, capturing resolvedInputs and startedAt", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);

    const wait = { type: "manual" as const, schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION };
    const result = await enterWait(config, { run, stepId: "approve", blockId: "wait.manual", resolvedInputs: { note: "please review" }, wait, resolvedSecretRefs: new Set() });

    const trace = result.run.trace.find((t) => t.stepId === "approve");
    expect(trace).toMatchObject({ block: "wait.manual", status: "waiting", inputs: { note: "please review" } });
    expect(trace?.startedAt).toBeTruthy();
    expect(trace?.endedAt).toBeUndefined();
  });

  it("timer/manual/approval-shaped waits never touch SignalStore — no early-arrival check performed", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    // A signal that WOULD match if this were a signal-correlated type, to
    // prove it's genuinely ignored for a `timer` wait specifically.
    await store.signals.append({ id: uniqueId("sig"), name: "irrelevant", correlationId: "irrelevant", payload: {}, receivedAt: new Date().toISOString() });

    const wait = { type: "timer" as const, resumeAt: new Date(Date.now() + 60_000).toISOString(), schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION };
    const result = await enterWait(config, { run, stepId: "recheck_wait", blockId: "wait.until", resolvedInputs: {}, wait, resolvedSecretRefs: new Set() });
    expect(result.suspended).toBe(true);
    expect(result.run.status).toBe("waiting");
  });

  it("preserves active concurrency coordination with a fingerprint when wait-entry discovers the raw key is secret", async () => {
    const { store, config } = await setup();
    const concurrencyKey = "case-secret";
    const run = fixtureRun({ status: "running", params: { concurrencyKey } });
    await store.runs.put(run);

    const result = await enterWait(
      { ...config, redact: redactLiteral(concurrencyKey) },
      {
        run,
        stepId: "manual_step",
        blockId: "wait.manual",
        resolvedInputs: {},
        wait: { type: "manual", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION },
        resolvedSecretRefs: new Set([concurrencyKey]),
      },
    );

    expect(result.run.status).toBe("waiting");
    const fingerprint = fingerprintConcurrencyKey(concurrencyKey);
    expect(result.run.params).toMatchObject({
      concurrencyKey: fingerprint,
      concurrencyKeyFormat: CONCURRENCY_KEY_FORMAT,
    });
    await expect(store.runs.get(run.runId)).resolves.toMatchObject({
      params: { concurrencyKey: fingerprint },
    });
  });
});

describe("enterWait — early-arrival resolution (architecture §4.4 step 3 / §5.6)", () => {
  it("resolves IMMEDIATELY when an unconsumed Signal already matches — does not persist an outstanding wait", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    const waitReadyRun = fixtureRun({
      ...run,
      snapshot: {
        definitions: { frozen: true },
        resolvedVersions: {},
        packHashes: {},
        capturedAt: "2026-07-29T00:00:00.000Z",
      },
    });

    const signal = { id: uniqueId("sig"), name: "quote.received", correlationId: "corr1", payload: { price: 42 }, receivedAt: new Date().toISOString() };
    await store.signals.append(signal);

    const wait = { type: "signal" as const, name: "quote.received", correlationId: "corr1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION };
    const result = await enterWait(config, { run: waitReadyRun, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: {}, wait, resolvedSecretRefs: new Set(), snapshotCapturedForWait: true });

    expect(result.suspended).toBe(false);
    expect(result.run.status).toBe("running"); // unchanged from before — never flipped to "waiting"
    expect(result.run.waits).toEqual([]); // never appended — "none of a/b/c is persisted as an outstanding wait"
    expect(result.run.snapshot.capturedAt).toBe(""); // an early arrival never became a durable suspension boundary

    const waitRow = await store.waits.get(run.runId, "wait_step");
    expect(waitRow).toBeUndefined();
    await expect(store.runs.get(run.runId)).resolves.toMatchObject({
      snapshot: { capturedAt: "" },
    });

    const trace = result.run.trace.find((t) => t.stepId === "wait_step");
    expect(trace).toMatchObject({ status: "completed", outputs: { price: 42 } });
  });

  it("marks the early-arrival signal consumed (a second identical wait-entry attempt would NOT find it again)", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    const signal = { id: uniqueId("sig"), name: "quote.received", correlationId: "corr1", payload: { price: 1 }, receivedAt: new Date().toISOString() };
    await store.signals.append(signal);

    const wait = { type: "signal" as const, name: "quote.received", correlationId: "corr1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION };
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: {}, wait, resolvedSecretRefs: new Set() });

    await expect(store.signals.findUnconsumedMatch("quote.received", "corr1")).resolves.toBeUndefined();
  });

  it("preserves active concurrency coordination with a fingerprint across early-arrival redaction", async () => {
    const { store, config } = await setup();
    const concurrencyKey = "case-secret";
    const run = fixtureRun({ status: "running", params: { concurrencyKey } });
    await store.runs.put(run);
    await store.signals.append({
      id: uniqueId("sig"),
      name: "quote.received",
      correlationId: "corr1",
      payload: { price: 42 },
      receivedAt: new Date().toISOString(),
    });

    const result = await enterWait(
      { ...config, redact: redactLiteral(concurrencyKey) },
      {
        run,
        stepId: "wait_step",
        blockId: "wait.for_signal",
        resolvedInputs: {},
        wait: { type: "signal", name: "quote.received", correlationId: "corr1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION },
        resolvedSecretRefs: new Set([concurrencyKey]),
      },
    );

    expect(result.suspended).toBe(false);
    const fingerprint = fingerprintConcurrencyKey(concurrencyKey);
    expect(result.run.params).toMatchObject({
      concurrencyKey: fingerprint,
      concurrencyKeyFormat: CONCURRENCY_KEY_FORMAT,
    });
    await expect(store.runs.get(run.runId)).resolves.toMatchObject({
      params: { concurrencyKey: fingerprint },
    });
  });

  it("THE EARLY-ARRIVAL RACE TEST: the SignalStore check and the WaitStore/RunRecord writes happen inside ONE store.transact() call (architecture §4.4 step 3) — a simulated crash after the check but before the wait row commits leaves NEITHER a resolved-immediately outcome NOR a persisted outstanding wait", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    const capturedRun = fixtureRun({
      ...run,
      snapshot: {
        definitions: { note: "snapshot-secret" },
        resolvedVersions: {},
        packHashes: {},
        capturedAt: "2026-07-29T00:00:00.000Z",
      },
    });
    // Deliberately NO matching signal exists — this exercises the
    // "no-match, persist the wait" branch, which is the one that used to
    // NOT be wrapped in transact() before this session's fix.
    const wait = { type: "signal" as const, name: "quote.received", correlationId: "corr-race", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION };

    class SimulatedCrash extends Error {}
    let waitPutCalls = 0;
    const crashingStore: AartStore = {
      ...store,
      transact: (fn) =>
        store.transact(async (tx) => {
          const wrappedTx: AartStore = {
            ...tx,
            waits: {
              get: tx.waits.get.bind(tx.waits),
              getOperationalRunState:
                tx.waits.getOperationalRunState.bind(tx.waits),
              replaceOperationalRunState:
                tx.waits.replaceOperationalRunState.bind(
                  tx.waits,
                ),
              redactAudit: tx.waits.redactAudit.bind(tx.waits),
              delete: tx.waits.delete.bind(tx.waits),
              list: tx.waits.list.bind(tx.waits),
              listOperational: tx.waits.listOperational.bind(tx.waits),
              findSignalMatches: tx.waits.findSignalMatches.bind(tx.waits),
              listDue: tx.waits.listDue.bind(tx.waits),
              put: () => {
                waitPutCalls += 1;
                return Promise.reject(new SimulatedCrash("crash between SignalStore check and WaitStore write"));
              },
            },
          };
          return fn(wrappedTx);
        }),
    };
    const crashingConfig: WaitMachineConfig = {
      ...config,
      store: crashingStore,
      redact: redactLiteral("snapshot-secret"),
    };

    await expect(enterWait(crashingConfig, { run: capturedRun, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: {}, wait, resolvedSecretRefs: new Set(["snapshot-secret"]) })).rejects.toThrow(SimulatedCrash);
    expect(waitPutCalls).toBe(1); // confirms the injected failure point was actually reached

    // Re-read through the REAL (unwrapped) store — the RunRecord.put that
    // would have accompanied the WaitStore.put in the SAME transaction
    // also never committed (transact()'s all-or-nothing guarantee).
    const reloaded = await store.runs.get(run.runId);
    expect(reloaded?.status).toBe("running"); // NOT "waiting" — the transaction rolled back
    expect(reloaded?.trace).toHaveLength(0); // no "waiting" StepTrace was persisted either
    expect(reloaded?.snapshot.capturedAt).toBe("");
    await expect(store.waits.get(run.runId, "wait_step")).resolves.toBeUndefined();
  });
});

describe("resumeBySignal — signal-matched mechanism (architecture §4.4.1)", () => {
  it("resumes the correct run: transitions status back to running, completes the waiting StepTrace with the signal's payload", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    const wait = { type: "signal" as const, name: "quote.received", correlationId: "corr1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION };
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: {}, wait, resolvedSecretRefs: new Set() });

    const signal = { id: uniqueId("sig"), name: "quote.received", correlationId: "corr1", payload: { price: 99 }, receivedAt: new Date().toISOString() };
    const outcome = await resumeBySignal(config, signal);

    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.mechanism).toBe("signal-matched");
    expect(outcome.run.status).toBe("running");
    const trace = outcome.run.trace.find((t) => t.stepId === "wait_step");
    expect(trace).toMatchObject({ status: "completed", outputs: { price: 99 } });

    // WaitStore row is gone — resumed exactly once.
    await expect(store.waits.get(run.runId, "wait_step")).resolves.toBeUndefined();
  });

  it("rewrites the complete signal audit before consumption clears protected secret state", async () => {
    const { store, config } = await setup();
    const secret = "signal-metadata-secret";
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    const wait = {
      type: "signal" as const,
      name: secret,
      correlationId: secret,
      schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION,
    };
    await enterWait(
      { ...config, redact: redactLiteral(secret) },
      {
        run,
        stepId: "wait_step",
        blockId: "wait.for_signal",
        resolvedInputs: {},
        wait,
        resolvedSecretRefs: new Set([secret]),
      },
    );
    const signal = {
      id: uniqueId("sig"),
      name: secret,
      correlationId: secret,
      payload: { echoed: secret },
      receivedAt: new Date().toISOString(),
    };
    await store.signals.append(signal);

    let sawSafeAuditBeforeConsume = false;
    const observingStore: AartStore = {
      ...store,
      transact: (fn) =>
        store.transact((tx) => {
          const observingSignals = new Proxy(tx.signals, {
            get(target, property, receiver) {
              if (property === "markConsumed") {
                return async (...args: unknown[]) => {
                  const audit = (await target.list()).find(
                    (candidate) => candidate.id === signal.id,
                  );
                  expect(JSON.stringify(audit)).not.toContain(
                    secret,
                  );
                  sawSafeAuditBeforeConsume = true;
                  return Reflect.apply(
                    target.markConsumed,
                    target,
                    args,
                  ) as Promise<void>;
                };
              }
              const value = Reflect.get(
                target,
                property,
                receiver,
              );
              return typeof value === "function"
                ? value.bind(target)
                : value;
            },
          });
          return fn({ ...tx, signals: observingSignals });
        }),
    };

    const outcome = await resumeBySignal(
      {
        ...config,
        store: observingStore,
        redact: redactLiteral(secret),
      },
      signal,
    );

    expect(outcome.kind).toBe("resumed");
    expect(sawSafeAuditBeforeConsume).toBe(true);
    await expect(store.signals.list()).resolves.toContainEqual({
      ...signal,
      name: "[REDACTED]",
      correlationId: "[REDACTED]",
      payload: { echoed: "[REDACTED]" },
    });
  });

  it("restores secret refs from a late-repaired matched signal before completing the wait", async () => {
    const { store, config } = await setup();
    const secret = "signal-only-secret";
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, {
      run,
      stepId: "wait_step",
      blockId: "wait.for_signal",
      resolvedInputs: {},
      wait: {
        type: "signal",
        name: "ready",
        correlationId: "corr",
        schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION,
      },
      resolvedSecretRefs: new Set(),
    });
    const signal = {
      id: uniqueId("sig"),
      name: "ready",
      correlationId: "corr",
      payload: { value: secret },
      receivedAt: new Date().toISOString(),
    };
    await store.signals.append(signal);
    const redact = redactLiteral(secret);
    await repairGlobalAuditsForNewSecrets(
      store,
      redact,
      new Set([secret]),
    );

    const outcome = await resumeBySignal(
      { ...config, redact },
      signal,
    );

    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(JSON.stringify(outcome.run)).not.toContain(secret);
    expect(
      JSON.stringify(await store.runs.get(run.runId)),
    ).not.toContain(secret);
    await expect(
      store.runs.getOperationalState(run.runId),
    ).resolves.toMatchObject({
      run: {
        trace: [
          expect.objectContaining({
            outputs: { value: secret },
          }),
        ],
      },
      resolvedSecretValues: expect.arrayContaining([secret]),
    });
  });

  it("redelivery of the same logical signal AFTER the wait has already been fully resolved and cleaned up does NOT double-advance the run — reported as unmatched (safe/inspectable), not an error, and critically not a second 'resumed'", async () => {
    // [DESIGN NOTE, see this session's report]: this is deliberately NOT
    // asserting `kind: "duplicate"` here. Architecture §4.4.2's dedupe
    // ledger is keyed `(runId, waitStepId, ...)` — inherently run-scoped —
    // and its own worked description ("the same signal is delivered twice")
    // is the race where BOTH deliveries still find the SAME live,
    // not-yet-deleted WaitStore row (the window this dedupe key genuinely
    // closes; exercised directly via resumeManual/resumeTimerWait/
    // resumeApproval below, and via the crash-simulation test, since those
    // are handed an explicit runId/stepId rather than re-deriving one from
    // a correlation scan). Once a wait is fully resolved, its WaitStore row
    // is deleted (by design — see wait-machine.ts's doc comment on why
    // RunRecord.waits itself is never pruned but WaitStore IS), so a LATER
    // redelivery (a fresh Signal.id, arriving after full cleanup) has
    // nothing left to correlate against via `resumeBySignal`'s own
    // list-scan — there is no durable, unbounded "every correlation ever
    // resolved" index this package maintains. The correctness property that
    // actually matters — the run is NOT advanced a second time — is what
    // this test proves; "unmatched" (architecture §4.4.2 step 2's own
    // documented safe outcome: "log unmatched signal for later inspection")
    // is the honest classification for this case, not a fabricated
    // "duplicate."
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    const wait = { type: "signal" as const, name: "quote.received", correlationId: "corr1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION };
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: {}, wait, resolvedSecretRefs: new Set() });

    const signal = { id: uniqueId("sig"), name: "quote.received", correlationId: "corr1", payload: { price: 5 }, receivedAt: new Date().toISOString() };
    const first = await resumeBySignal(config, signal);
    expect(first.kind).toBe("resumed");
    if (first.kind !== "resumed") throw new Error("unreachable");
    const runIdAfterFirst = first.run.updatedAt;

    const redelivered = { ...signal, id: uniqueId("sig") };
    const second = await resumeBySignal(config, redelivered);
    expect(second.kind).toBe("unmatched");

    // The critical invariant: the run's persisted state is byte-for-byte
    // unchanged by the redelivery — it was NOT re-advanced or re-mutated.
    const reloaded = await store.runs.get(run.runId);
    expect(reloaded?.updatedAt).toBe(runIdAfterFirst);
    expect(reloaded?.trace.filter((t) => t.stepId === "wait_step")).toHaveLength(1); // exactly one completion, not two
  });

  // Genuine duplicate-delivery protection (the dedupe ledger's actual
  // documented window — architecture §4.4.2) is proven by the
  // direct-lookup mechanisms below (resumeManual/resumeApproval/
  // resumeTimerWait — each called twice with the SAME explicit
  // runId/stepId, correctly returning "duplicate" on the second call) and
  // by the dedicated crash-simulation test at the bottom of this file.

  it("a zero-match signal is unmatched, not a crash (architecture §4.4.2 step 2: 'log unmatched signal for later inspection')", async () => {
    const { config } = await setup();
    const outcome = await resumeBySignal(config, { id: uniqueId("sig"), name: "nothing.waits.on.this", correlationId: "x", payload: {}, receivedAt: new Date().toISOString() });
    expect(outcome).toEqual({ kind: "unmatched", mechanism: "signal-matched" });
  });

  it("more than one matching outstanding wait fails loudly with CorrelationError (a modeling error — correlationIds should be unique per outstanding wait)", async () => {
    const { store, config } = await setup();
    const runA = fixtureRun({ status: "running" });
    const runB = fixtureRun({ status: "running" });
    await store.runs.put(runA);
    await store.runs.put(runB);
    const wait = { type: "signal" as const, name: "dup.name", correlationId: "dup-corr", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION };
    await enterWait(config, { run: runA, stepId: "s", blockId: "wait.for_signal", resolvedInputs: {}, wait, resolvedSecretRefs: new Set() });
    await enterWait(config, { run: runB, stepId: "s", blockId: "wait.for_signal", resolvedInputs: {}, wait, resolvedSecretRefs: new Set() });

    await expect(resumeBySignal(config, { id: uniqueId("sig"), name: "dup.name", correlationId: "dup-corr", payload: {}, receivedAt: new Date().toISOString() })).rejects.toThrow(CorrelationError);
  });
});

describe("resumeManual — direct-lookup mechanism", () => {
  it("refuses to persist a resumed payload when preparation is omitted", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, {
      run,
      stepId: "manual_step",
      blockId: "wait.manual",
      resolvedInputs: {},
      wait: {
        type: "manual",
        schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION,
      },
      resolvedSecretRefs: new Set(),
    });

    await expect(
      resumeManualWithPreparation(
        config,
        run.runId,
        "manual_step",
        { secret: "plaintext" },
        new Set(),
        undefined as never,
      ),
    ).rejects.toThrow(/prepareCompletedRun callback is required/);

    await expect(store.runs.get(run.runId)).resolves.toMatchObject({
      status: "waiting",
      trace: [expect.objectContaining({ status: "waiting" })],
    });
    await expect(store.waits.get(run.runId, "manual_step")).resolves.toBeDefined();
  });

  it("resumes a manual wait with the supplied payload as output", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "manual_step", blockId: "wait.manual", resolvedInputs: {}, wait: { type: "manual", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const outcome = await resumeManual(config, run.runId, "manual_step", { resumedBy: "operator" });
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.mechanism).toBe("direct-lookup");
    expect(outcome.run.trace.find((t) => t.stepId === "manual_step")?.outputs).toEqual({ resumedBy: "operator" });
  });

  it("a second manual resume of the same step is a duplicate no-op", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "manual_step", blockId: "wait.manual", resolvedInputs: {}, wait: { type: "manual", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    await resumeManual(config, run.runId, "manual_step");
    const second = await resumeManual(config, run.runId, "manual_step");
    expect(second.kind).toBe("duplicate");
  });

  it("preserves active concurrency coordination with a fingerprint across resume redaction", async () => {
    const { store, config } = await setup();
    const concurrencyKey = "case-secret";
    const run = fixtureRun({ status: "running", params: { concurrencyKey } });
    await store.runs.put(run);
    const redactingConfig = { ...config, redact: redactLiteral(concurrencyKey) };
    const resolvedSecretRefs = new Set([concurrencyKey]);
    await enterWait(redactingConfig, {
      run,
      stepId: "manual_step",
      blockId: "wait.manual",
      resolvedInputs: {},
      wait: { type: "manual", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION },
      resolvedSecretRefs,
    });

    const outcome = await resumeManual(redactingConfig, run.runId, "manual_step", undefined, resolvedSecretRefs);

    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    const fingerprint = fingerprintConcurrencyKey(concurrencyKey);
    expect(outcome.run.params).toMatchObject({
      concurrencyKey: fingerprint,
      concurrencyKeyFormat: CONCURRENCY_KEY_FORMAT,
    });
    await expect(store.runs.get(run.runId)).resolves.toMatchObject({
      params: { concurrencyKey: fingerprint },
    });
  });

  it("resuming a step that was never waited on is unmatched", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    const outcome = await resumeManual(config, run.runId, "never_waited");
    expect(outcome.kind).toBe("unmatched");
  });
});

describe("resumeApproval — direct-lookup mechanism (architecture §4.4.1: 'direct ApprovalStore write, either authorship path')", () => {
  it("resumes an approval wait, recording status/decision/reviewer as output", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "review", blockId: "human.approval", resolvedInputs: { title: "Review extraction" }, wait: { type: "approval", taskId: "task-1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const outcome = await resumeApproval(config, run.runId, "review", { id: "task-1", status: "approved", decision: { note: "looks good" }, reviewer: "jane@example.com" });
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.trace.find((t) => t.stepId === "review")?.outputs).toEqual({ status: "approved", decision: { note: "looks good" }, reviewer: "jane@example.com" });
  });

  it("a duplicate approval resume (e.g. a re-processed webhook for the same decision) is a no-op", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "review", blockId: "human.approval", resolvedInputs: {}, wait: { type: "approval", taskId: "task-1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });
    await resumeApproval(config, run.runId, "review", { id: "task-1", status: "approved" });
    const second = await resumeApproval(config, run.runId, "review", { id: "task-1", status: "approved" });
    expect(second.kind).toBe("duplicate");
  });
});

describe("resumeTimerWait — scheduler-tick mechanism", () => {
  it("resumes a due timer wait", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "recheck_wait", blockId: "wait.until", resolvedInputs: {}, wait: { type: "timer", resumeAt: new Date(Date.now() - 1000).toISOString(), schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const outcome = await resumeTimerWait(config, run.runId, "recheck_wait");
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.mechanism).toBe("scheduler-tick");
    expect(outcome.run.status).toBe("running");
  });

  it("resuming the same timer wait a second time (e.g. two scheduler ticks both observing it as due before the first tick's resume commits) is a duplicate no-op — the atomic-claim rule extends beyond signal-matched (architecture §4.4.2's scope note)", async () => {
    // Sequential, not concurrent (Promise.all): the fs adapter (architecture
    // §5.1/§5.8) is the local-dev convenience adapter and does not claim to
    // serialize genuinely concurrent transact() calls against each other —
    // that guarantee is SQLite/Postgres's job (ADR-03's consequences;
    // implementation plan Risk 2's "naive fs adapter... would pass simple
    // tests but fail under concurrent-access conditions"). What IS
    // guaranteed, on every adapter, is that a SECOND resume attempt against
    // an already-resolved wait is a no-op — exactly what this test proves.
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "recheck_wait", blockId: "wait.until", resolvedInputs: {}, wait: { type: "timer", resumeAt: new Date(Date.now() - 1000).toISOString(), schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const a = await resumeTimerWait(config, run.runId, "recheck_wait");
    const b = await resumeTimerWait(config, run.runId, "recheck_wait");
    const kinds = [a.kind, b.kind];
    expect(kinds).toEqual(["resumed", "duplicate"]);
  });
});

describe("resumeExternalJobResult — scheduler-tick mechanism (external_job's poll sub-path)", () => {
  it("resumes an external_job wait once S2's poll mechanism reports completion", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "wait_batch", blockId: "wait.for_external_job", resolvedInputs: {}, wait: { type: "external_job", provider: "openai_batch", jobId: "job-1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const outcome = await resumeExternalJobResult(config, run.runId, "wait_batch", { results: ["a", "b"] });
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.trace.find((t) => t.stepId === "wait_batch")?.outputs).toEqual({ results: ["a", "b"] });
  });
});

describe("getDueWaits — the S2 scheduler-ticker seam (architecture §4.4.3/§4.7)", () => {
  it("returns only timer waits whose resumeAt has passed, excluding future timers and non-timer waits", async () => {
    const { store, config } = await setup();
    const runA = fixtureRun({ status: "running" });
    const runB = fixtureRun({ status: "running" });
    const runC = fixtureRun({ status: "running" });
    await store.runs.put(runA);
    await store.runs.put(runB);
    await store.runs.put(runC);

    await enterWait(config, { run: runA, stepId: "due", blockId: "wait.until", resolvedInputs: {}, wait: { type: "timer", resumeAt: new Date(Date.now() - 1000).toISOString(), schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });
    await enterWait(config, { run: runB, stepId: "not_due", blockId: "wait.until", resolvedInputs: {}, wait: { type: "timer", resumeAt: new Date(Date.now() + 60_000).toISOString(), schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });
    await enterWait(config, { run: runC, stepId: "not_a_timer", blockId: "wait.manual", resolvedInputs: {}, wait: { type: "manual", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const due = await getDueWaits(store, new Date());
    expect(due.map((d) => d.stepId)).toContain("due");
    expect(due.map((d) => d.stepId)).not.toContain("not_due");
    expect(due.map((d) => d.stepId)).not.toContain("not_a_timer");
  });
});

describe("listExternalJobWaits — S2's poll-mechanism sweep query", () => {
  it("returns only external_job waits", async () => {
    const { store, config } = await setup();
    const runA = fixtureRun({ status: "running" });
    const runB = fixtureRun({ status: "running" });
    await store.runs.put(runA);
    await store.runs.put(runB);
    await enterWait(config, { run: runA, stepId: "job_wait", blockId: "wait.for_external_job", resolvedInputs: {}, wait: { type: "external_job", provider: "p", jobId: "j1", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });
    await enterWait(config, { run: runB, stepId: "manual_wait", blockId: "wait.manual", resolvedInputs: {}, wait: { type: "manual", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const jobs = await listExternalJobWaits(store);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ stepId: "job_wait" });
  });

  it("polls with sealed provider/job values after their audit copy is redacted", async () => {
    const { store } = await setup();
    const wait = {
      type: "external_job" as const,
      provider: "late-secret",
      jobId: "late-secret",
      schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION,
    };
    await store.waits.put(
      "run-sealed-job",
      "job_wait",
      wait,
      new Date().toISOString(),
    );
    await store.waits.redactAudit(
      "run-sealed-job",
      "job_wait",
      {
        ...wait,
        provider: "[REDACTED]",
        jobId: "[REDACTED]",
      },
    );
    await expect(listExternalJobWaits(store)).resolves.toEqual([
      expect.objectContaining({ wait }),
    ]);
    await expect(store.waits.list()).resolves.toEqual([
      expect.objectContaining({
        wait: {
          ...wait,
          provider: "[REDACTED]",
          jobId: "[REDACTED]",
        },
      }),
    ]);
  });
});

describe("getExpiredWaits / failExpiredWait — wait TIMEOUT expiry (architecture §4.4.1's Expiry note)", () => {
  it("getExpiredWaits returns a wait whose timeout has elapsed relative to its createdAt", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    // Enter the wait "in the past" by directly controlling `now` via a
    // fixed-clock config, so its createdAt + timeout is already behind us.
    const pastConfig: WaitMachineConfig = { ...config, now: () => new Date(Date.now() - 10_000) };
    await enterWait(pastConfig, { run, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: {}, wait: { type: "signal", name: "n", correlationId: "c", timeout: "5s", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const expired = await getExpiredWaits(store, new Date());
    expect(expired.map((e) => e.stepId)).toContain("wait_step");
  });

  it("getExpiredWaits excludes a wait whose timeout has NOT yet elapsed", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: {}, wait: { type: "signal", name: "n", correlationId: "c", timeout: "7d", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const expired = await getExpiredWaits(store, new Date());
    expect(expired.map((e) => e.stepId)).not.toContain("wait_step");
  });

  it("uses sealed operational timeout values after the public audit is redacted", async () => {
    const { store } = await setup();
    const wait = {
      type: "signal" as const,
      name: "late-secret",
      correlationId: "late-secret",
      timeout: "1s",
      schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION,
    };
    await store.waits.put(
      "run-sealed-timeout",
      "pause",
      wait,
      new Date(Date.now() - 10_000).toISOString(),
    );
    await store.waits.redactAudit(
      "run-sealed-timeout",
      "pause",
      {
        ...wait,
        name: "[REDACTED]",
        correlationId: "[REDACTED]",
        timeout: "[REDACTED]",
      },
    );
    await expect(
      getExpiredWaits(store, new Date()),
    ).resolves.toEqual([
      expect.objectContaining({
        runId: "run-sealed-timeout",
        stepId: "pause",
        wait,
      }),
    ]);
  });

  it("getExpiredWaits excludes a wait with no timeout field at all (e.g. manual, or signal without one declared)", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    const pastConfig: WaitMachineConfig = { ...config, now: () => new Date(Date.now() - 10_000) };
    await enterWait(pastConfig, { run, stepId: "wait_step", blockId: "wait.manual", resolvedInputs: {}, wait: { type: "manual", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const expired = await getExpiredWaits(store, new Date());
    expect(expired.map((e) => e.stepId)).not.toContain("wait_step");
  });

  it("getExpiredWaits excludes timer waits (no timeout field on that member — resumeAt due-ness is getDueWaits' job, not this one's)", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.until", resolvedInputs: {}, wait: { type: "timer", resumeAt: new Date(Date.now() - 100_000).toISOString(), schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const expired = await getExpiredWaits(store, new Date());
    expect(expired.map((e) => e.stepId)).not.toContain("wait_step");
  });

  it("failExpiredWait marks the step FAILED (not completed), deletes the wait row, and leaves the run status 'running' for the caller to finalize", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: {}, wait: { type: "signal", name: "n", correlationId: "c", timeout: "5s", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const outcome = await failExpiredWait(config, run.runId, "wait_step");
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.run.status).toBe("running");
    const trace = outcome.run.trace.find((t) => t.stepId === "wait_step");
    expect(trace?.status).toBe("failed");
    expect(trace?.error).toMatch(/expired/i);
    await expect(store.waits.get(run.runId, "wait_step")).resolves.toBeUndefined();
  });

  it("failExpiredWait on an approval wait also sets the referenced ApprovalTask.status to 'expired' (spec §13.5)", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await store.approvals.put({ id: "task-1", runId: run.runId, stepId: "review", title: "Review", description: "", status: "pending", createdAt: new Date().toISOString() });
    await enterWait(config, { run, stepId: "review", blockId: "human.approval", resolvedInputs: {}, wait: { type: "approval", taskId: "task-1", timeout: "5s", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    await failExpiredWait(config, run.runId, "review");

    const task = await store.approvals.get("task-1");
    expect(task?.status).toBe("expired");
    expect(task?.decidedAt).toBeTruthy();
  });

  it("a second failExpiredWait attempt on the same wait is a duplicate no-op (the same atomic-claim discipline as resume)", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.manual", resolvedInputs: {}, wait: { type: "manual", timeout: "5s", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const first = await failExpiredWait(config, run.runId, "wait_step");
    expect(first.kind).toBe("resumed");
    const second = await failExpiredWait(config, run.runId, "wait_step");
    expect(second.kind).toBe("duplicate");
  });

  it("expiry and resume are mutually exclusive: once a wait is resumed normally, a LATER expiry sweep finding it (e.g. a stale in-flight ticker tick) is a no-op, not a double-processing", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.manual", resolvedInputs: {}, wait: { type: "manual", timeout: "5s", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    const resumed = await resumeManual(config, run.runId, "wait_step", { ok: true });
    expect(resumed.kind).toBe("resumed");

    const lateExpiry = await failExpiredWait(config, run.runId, "wait_step");
    expect(lateExpiry.kind).toBe("duplicate");
    // The run's completed (not failed) state from the genuine resume is untouched.
    const reloaded = await store.runs.get(run.runId);
    expect(reloaded?.trace.find((t) => t.stepId === "wait_step")?.status).toBe("completed");
  });

  it("failing a wait that was never entered is unmatched, not a crash", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    const outcome = await failExpiredWait(config, run.runId, "never_waited");
    expect(outcome.kind).toBe("unmatched");
  });
});

describe("THE REQUIRED TEST — exactly-once resume's transaction boundary holds under a simulated crash (architecture §4.4.2/§5.8)", () => {
  it("a crash between 'dedupe recorded' and 'run state advanced' leaves NEITHER change persisted — the dedupe key is not consumed AND the run is still waiting", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.for_signal", resolvedInputs: {}, wait: { type: "signal", name: "n", correlationId: "c", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    // Wraps the REAL store's transact() so that, inside the SAME real
    // transaction claimAndCompleteWait opens, the final `tx.runs.put(...)`
    // call (the run-state-advance write, coming strictly after
    // `recordDedupeKey`/`waits.delete` in wait-machine.ts's own write
    // order) throws — simulating a crash precisely between "dedupe
    // recorded" and "run state advanced." This is NOT a mock store: every
    // read/write up to the injected failure point goes through the real fs
    // adapter; only the one call is intercepted.
    class SimulatedCrash extends Error {}
    let putCallCount = 0;
    const crashingStore: AartStore = {
      ...store,
      transact: (fn) =>
        store.transact(async (tx) => {
          // NOTE: `tx.runs` is a class instance (`FsRunStore`) — its
          // methods live on the prototype, not as own-enumerable
          // properties, so `{ ...tx.runs, put: ... }` would silently drop
          // every OTHER method (get/list/hasDedupeKey/recordDedupeKey).
          // Bind each real method explicitly instead of spreading.
          const wrappedTx: AartStore = {
            ...tx,
            runs: {
              get: tx.runs.get.bind(tx.runs),
              list: tx.runs.list.bind(tx.runs),
              getOperationalState:
                tx.runs.getOperationalState.bind(tx.runs),
              putOperationalState:
                tx.runs.putOperationalState.bind(tx.runs),
              replaceOperationalState:
                tx.runs.replaceOperationalState.bind(tx.runs),
              deleteOperationalState:
                tx.runs.deleteOperationalState.bind(tx.runs),
              hasDedupeKey: tx.runs.hasDedupeKey.bind(tx.runs),
              recordDedupeKey: tx.runs.recordDedupeKey.bind(tx.runs),
              put: async () => {
                putCallCount += 1;
                throw new SimulatedCrash("crash between dedupe-recorded and run-state-advanced");
              },
            },
          };
          return fn(wrappedTx);
        }),
    };
    const crashingConfig: WaitMachineConfig = { ...config, store: crashingStore };

    await expect(resumeManual(crashingConfig, run.runId, "wait_step")).rejects.toThrow(SimulatedCrash);
    expect(putCallCount).toBe(1); // confirms the injected failure point was actually reached, not skipped

    // Re-read through the REAL (unwrapped) store — neither half of the
    // "commit together or not at all" pair landed. Dedupe key format is
    // `${stepId}:${traceEntrySeq}:${suffix}` (wait-machine.ts's
    // claimAndCompleteWait doc comment explains the seq incorporation);
    // this run's single "wait_step" entry is trace seq 0.
    await expect(store.runs.hasDedupeKey(run.runId, "wait_step:0:manual")).resolves.toBe(false);
    const reloadedRun = await store.runs.get(run.runId);
    expect(reloadedRun?.status).toBe("waiting"); // NOT advanced to "running"
    const waitRow = await store.waits.get(run.runId, "wait_step");
    expect(waitRow).toBeDefined(); // NOT deleted — resume never actually committed
  });

  it("after the simulated crash, a SUBSEQUENT genuine resume attempt succeeds cleanly (the failed attempt left no partial state to trip over)", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await enterWait(config, { run, stepId: "wait_step", blockId: "wait.manual", resolvedInputs: {}, wait: { type: "manual", schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION }, resolvedSecretRefs: new Set() });

    class SimulatedCrash extends Error {}
    let shouldCrash = true;
    const crashingStore: AartStore = {
      ...store,
      transact: (fn) =>
        store.transact(async (tx) => {
          const wrappedTx: AartStore = {
            ...tx,
            runs: {
              get: tx.runs.get.bind(tx.runs),
              list: tx.runs.list.bind(tx.runs),
              getOperationalState:
                tx.runs.getOperationalState.bind(tx.runs),
              putOperationalState:
                tx.runs.putOperationalState.bind(tx.runs),
              replaceOperationalState:
                tx.runs.replaceOperationalState.bind(tx.runs),
              deleteOperationalState:
                tx.runs.deleteOperationalState.bind(tx.runs),
              hasDedupeKey: tx.runs.hasDedupeKey.bind(tx.runs),
              recordDedupeKey: tx.runs.recordDedupeKey.bind(tx.runs),
              put: (r) => (shouldCrash ? Promise.reject(new SimulatedCrash("crash")) : tx.runs.put(r)),
            },
          };
          return fn(wrappedTx);
        }),
    };
    const crashingConfig: WaitMachineConfig = { ...config, store: crashingStore };

    await expect(resumeManual(crashingConfig, run.runId, "wait_step")).rejects.toThrow(SimulatedCrash);

    shouldCrash = false;
    const outcome = await resumeManual(crashingConfig, run.runId, "wait_step");
    expect(outcome.kind).toBe("resumed");
  });
});
