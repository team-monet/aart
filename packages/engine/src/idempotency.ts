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
): Promise<void> {
  if (resolvedSecretRefs.size === 0) return;
  const entries = await store.idempotencyLedger.list();
  const entriesByKey = new Map(
    entries.map((entry) => [entry.resolvedKey, entry]),
  );
  const pendingKeys = new Set<string>();
  const outputTaintedKeys = new Set<string>();

  const persistedRuns = await store.runs.list();
  const runsById = new Map(
    persistedRuns.map((persistedRun) => [
      persistedRun.runId,
      persistedRun,
    ]),
  );
  // The caller's in-memory run may contain traces/taint not written yet.
  runsById.set(run.runId, run);

  // A non-literal derivative cannot be detected by redacting the ledger
  // value itself. Reconstruct every persisted producer against the newly
  // known secrets before deciding that no key is tainted. The same pass
  // repairs each run's associated durable audits (waits, approvals,
  // consumed signals, artifacts), even when no cache entry is ultimately
  // revoked.
  if (prepareConsumer) {
    for (const [runId, persistedRun] of runsById) {
      const prepared = await prepareConsumer(
        store,
        persistedRun,
        new Set(),
        resolvedSecretRefs,
      );
      const redacted = applyRunRedaction(
        redact,
        prepared,
        resolvedSecretRefs,
      );
      // The caller writes its authoritative in-memory record immediately
      // after this function returns.
      if (runId === run.runId) {
        runsById.set(runId, redacted);
        continue;
      }
      await store.runs.put(redacted);
      runsById.set(runId, redacted);
    }
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
    const consumedByTaintedTrace = [...runsById.values()].some(
      (candidateRun) =>
        traceHasTaintedLedgerOutput(
          candidateRun,
          entry.resolvedKey,
        ),
    );
    if (outputChanged || keyChanged || consumedByTaintedTrace) {
      pendingKeys.add(entry.resolvedKey);
      if (outputChanged || consumedByTaintedTrace) {
        outputTaintedKeys.add(entry.resolvedKey);
      }
    }
  }

  if (pendingKeys.size === 0) return;
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

    for (const [runId, persistedRun] of runsById) {
      const consumedKeys = new Set(
        persistedRun.trace
          .map((trace) => trace.idempotencyLedgerKey)
          .filter(
            (key): key is string =>
              key !== undefined && batch.includes(key),
          ),
      );
      if (consumedKeys.size === 0) continue;

      // The caller persists its current in-memory record immediately after
      // this function returns. It has already passed through the same taint
      // preparation for this secret set, so do not race that authoritative
      // write with a second reconstruction here.
      if (runId === run.runId) {
        for (const trace of persistedRun.trace) {
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
        continue;
      }

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
      const redacted = applyRunRedaction(
        redact,
        prepared,
        resolvedSecretRefs,
      );
      await store.runs.put(redacted);
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
}
