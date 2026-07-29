// Idempotency key handling (spec §30.2, architecture §4.2). "before
// executing, check if a prior attempt with the same key already completed;
// if so, replay its recorded output instead of re-executing." Ledger
// placement is `store.idempotencyLedger` (architecture §5.7 — a dedicated
// collection, not folded into StepTrace rows, so a resolved key is
// checkable before that attempt's StepTrace even exists).
import type { AartStore } from "@aart/store";
import type { RedactFn, RunRecord } from "@aart/types";
import {
  applyRedaction,
  applyRunRedaction,
  changedJsonPointers,
} from "./redaction.js";
import { CURRENT_ENGINE_SCHEMA_VERSION } from "./schema-version.js";

export interface IdempotencyCheck {
  /** `true` if a prior attempt with this resolved key already completed — `recordedOutput` is that attempt's output, to replay instead of re-executing the block. */
  alreadyCompleted: boolean;
  recordedOutput?: unknown;
}

/**
 * Security-significant engine record upgrades invalidate older ledger
 * entries by namespacing every key with the current engine schema. Legacy
 * unversioned entries are never replayed.
 */
export function idempotencyStorageKey(resolvedKey: string): string {
  return `v${CURRENT_ENGINE_SCHEMA_VERSION}:${resolvedKey}`;
}

export async function checkIdempotency(store: AartStore, resolvedKey: string): Promise<IdempotencyCheck> {
  const entry = await store.idempotencyLedger.get(
    idempotencyStorageKey(resolvedKey),
  );
  if (
    !entry ||
    entry.schemaVersion !== CURRENT_ENGINE_SCHEMA_VERSION
  ) {
    return { alreadyCompleted: false };
  }
  return { alreadyCompleted: true, recordedOutput: entry.recordedOutput };
}

/** Records a step attempt's output under its resolved idempotency key — called ONLY after a successful (post-retry) execution, never for an attempt that exhausted its retries and ultimately failed (architecture §4.2: a genuinely-failed attempt gets no protection, so a later retry of the whole step/run tries again fresh, which is correct — the attempt truly never succeeded). */
export async function recordIdempotency(store: AartStore, resolvedKey: string, runId: string, stepId: string, recordedOutput: unknown, now: Date): Promise<void> {
  const storageKey = idempotencyStorageKey(resolvedKey);
  await store.idempotencyLedger.put({
    resolvedKey: storageKey,
    runId,
    stepId,
    recordedOutput,
    createdAt: now.toISOString(),
    schemaVersion: CURRENT_ENGINE_SCHEMA_VERSION,
  });
}

export type PrepareRevokedIdempotencyConsumer = (
  store: AartStore,
  run: RunRecord,
  outputTaintedLedgerKeys: ReadonlySet<string>,
  resolvedSecretRefs: ReadonlySet<string>,
  options?: { includeUnattributedSignalAudits?: boolean },
) => Promise<RunRecord>;

function traceHasTaintedLedgerOutput(
  run: RunRecord,
  resolvedKey: string,
): boolean {
  return run.trace.some(
    (trace) =>
      trace.idempotencyLedgerKey === resolvedKey &&
      (trace.secretTainted === true ||
        trace.controlSecretTainted === true),
  );
}

function markDirectLedgerConsumers(
  run: RunRecord,
  outputTaintedLedgerKeys: ReadonlySet<string>,
): RunRecord {
  if (outputTaintedLedgerKeys.size === 0) return run;
  return {
    ...run,
    trace: run.trace.map((trace) =>
      trace.idempotencyLedgerKey !== undefined &&
      outputTaintedLedgerKeys.has(trace.idempotencyLedgerKey)
        ? {
            ...trace,
            secretTainted: true,
            secretTaintedPaths: ["*"],
          }
        : trace,
    ),
  };
}

async function redactAndPersistRun(
  store: AartStore,
  redact: RedactFn,
  run: RunRecord,
  resolvedSecretRefs: ReadonlySet<string>,
): Promise<RunRecord> {
  const redacted = applyRunRedaction(redact, run, resolvedSecretRefs);
  await store.runs.put(redacted);
  return redacted;
}

/**
 * A secret may first be resolved after an earlier attempt wrote its output
 * to the global ledger. Revisit every entry whenever a known-secret set
 * grows, revoke changed outputs/keys, and repair every persisted run that
 * already consumed the revoked output. Repair can reveal a transitive cache
 * lineage (consumer B cached a derivative that consumer C replayed), so the
 * closure continues until no newly tainted ledger key remains.
 */
export async function revokeSecretTaintedIdempotency(
  store: AartStore,
  redact: RedactFn,
  run: RunRecord,
  resolvedSecretRefs: ReadonlySet<string>,
  prepareConsumer?: PrepareRevokedIdempotencyConsumer,
): Promise<RunRecord> {
  if (resolvedSecretRefs.size === 0) return run;
  const entries = await store.idempotencyLedger.list();
  const entriesByKey = new Map(
    entries.map((entry) => [entry.resolvedKey, entry]),
  );
  const pendingKeys = new Set<string>();
  const outputTaintedKeys = new Set<string>();

  // The active execution is always relevant: it is the execution that just
  // enlarged the known-secret set, so its own audits and historical
  // provenance must be repaired even when no cache entry exists.
  let activeRun = prepareConsumer
    ? await prepareConsumer(
        store,
        run,
        new Set(),
        resolvedSecretRefs,
        { includeUnattributedSignalAudits: true },
      )
    : run;
  activeRun = applyRunRedaction(
    redact,
    activeRun,
    resolvedSecretRefs,
  );

  // Non-literal derivatives require historical reconstruction, but only
  // ledger producers can prove a previously written entry was derived from
  // a root input/trigger. Reconstruct those producer runs, not every
  // retained run in the store.
  const runsById = new Map<string, RunRecord>([
    [activeRun.runId, activeRun],
  ]);
  const producerRunIds = new Set(
    entries.map((entry) => entry.runId),
  );
  for (const producerRunId of producerRunIds) {
    if (producerRunId === activeRun.runId) continue;
    const persistedProducer = await store.runs.get(producerRunId);
    if (!persistedProducer) continue;
    const preparedProducer = prepareConsumer
      ? await prepareConsumer(
          store,
          persistedProducer,
          new Set(),
          resolvedSecretRefs,
        )
      : persistedProducer;
    const redactedProducer = applyRunRedaction(
      redact,
      preparedProducer,
      resolvedSecretRefs,
    );
    await store.runs.put(redactedProducer);
    runsById.set(producerRunId, redactedProducer);
  }

  for (const entry of entries) {
    const redactedOutput = applyRedaction(
      redact,
      entry.recordedOutput,
      resolvedSecretRefs,
    );
    const outputChanged =
      changedJsonPointers(entry.recordedOutput, redactedOutput).length > 0;
    const keyChanged =
      applyRedaction(
        redact,
        entry.resolvedKey,
        resolvedSecretRefs,
      ) !== entry.resolvedKey;
    const producerRun = runsById.get(entry.runId);
    const consumedByTaintedTrace =
      (producerRun !== undefined &&
        traceHasTaintedLedgerOutput(
          producerRun,
          entry.resolvedKey,
        )) ||
      traceHasTaintedLedgerOutput(
        activeRun,
        entry.resolvedKey,
      );
    if (outputChanged || keyChanged || consumedByTaintedTrace) {
      pendingKeys.add(entry.resolvedKey);
      if (outputChanged || consumedByTaintedTrace) {
        outputTaintedKeys.add(entry.resolvedKey);
      }
    }
  }

  if (pendingKeys.size === 0) return activeRun;

  // Loading retained run records once is enough to build the consumer
  // index. Workflow reconstruction and durable-audit scans happen only for
  // producer/consumer runs reached by the affected ledger graph.
  const persistedRuns = await store.runs.list();
  for (const persistedRun of persistedRuns) {
    if (!runsById.has(persistedRun.runId)) {
      runsById.set(persistedRun.runId, persistedRun);
    }
  }
  runsById.set(activeRun.runId, activeRun);
  const consumersByKey = new Map<string, Set<string>>();
  for (const [runId, candidateRun] of runsById) {
    for (const trace of candidateRun.trace) {
      const key = trace.idempotencyLedgerKey;
      if (key === undefined) continue;
      const consumers = consumersByKey.get(key) ?? new Set<string>();
      consumers.add(runId);
      consumersByKey.set(key, consumers);
    }
  }
  const processedKeys = new Set<string>();

  while (true) {
    const batch = [...pendingKeys].filter(
      (key) => !processedKeys.has(key),
    );
    if (batch.length === 0) break;
    for (const key of batch) {
      processedKeys.add(key);
      await store.idempotencyLedger.delete(key);
    }

    const consumerRunIds = new Set<string>();
    for (const key of batch) {
      for (const runId of consumersByKey.get(key) ?? []) {
        consumerRunIds.add(runId);
      }
    }

    for (const runId of consumerRunIds) {
      const persistedRun = runsById.get(runId);
      if (!persistedRun) continue;
      const consumedKeys = new Set(
        persistedRun.trace
          .map((trace) => trace.idempotencyLedgerKey)
          .filter(
            (key): key is string =>
              key !== undefined && batch.includes(key),
          ),
      );
      if (consumedKeys.size === 0) continue;

      const taintedConsumedKeys = new Set(
        [...consumedKeys].filter((key) => outputTaintedKeys.has(key)),
      );
      const directlyMarked = markDirectLedgerConsumers(
        persistedRun,
        taintedConsumedKeys,
      );
      const prepared = prepareConsumer
        ? await prepareConsumer(
            store,
            directlyMarked,
            taintedConsumedKeys,
            resolvedSecretRefs,
          )
        : directlyMarked;
      const redacted =
        runId === activeRun.runId
          ? applyRunRedaction(redact, prepared, resolvedSecretRefs)
          : await redactAndPersistRun(
              store,
              redact,
              prepared,
              resolvedSecretRefs,
            );
      if (runId === activeRun.runId) {
        activeRun = redacted;
      }
      runsById.set(runId, redacted);

      for (const trace of prepared.trace) {
        const key = trace.idempotencyLedgerKey;
        if (
          key !== undefined &&
          entriesByKey.has(key) &&
          (trace.secretTainted === true ||
            trace.controlSecretTainted === true)
        ) {
          pendingKeys.add(key);
          outputTaintedKeys.add(key);
        }
      }
    }
  }
  return activeRun;
}
