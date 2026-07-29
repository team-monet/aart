// Idempotency key handling (spec §30.2, architecture §4.2). "before
// executing, check if a prior attempt with the same key already completed;
// if so, replay its recorded output instead of re-executing." Ledger
// placement is `store.idempotencyLedger` (architecture §5.7 — a dedicated
// collection, not folded into StepTrace rows, so a resolved key is
// checkable before that attempt's StepTrace even exists).
import type {
  AartStore,
  IdempotencyLedgerEntry,
  IdempotencyReplayClaim,
  RunOperationalState,
} from "@aart/store";
import type {
  RedactFn,
  RunRecord,
  StepTrace,
} from "@aart/types";
import {
  applyRedaction,
  applyRunRedaction,
  changedJsonPointers,
  mergeActiveRunProtection,
  mergeOperationalRunTaint,
} from "./redaction.js";
import { CURRENT_ENGINE_SCHEMA_VERSION } from "./schema-version.js";
import { idempotencyAssociationFingerprint } from "./idempotency-association.js";

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

/**
 * Atomically reads a reusable entry and registers the not-yet-persisted
 * consumer in sealed run state. Secret repair therefore observes either
 * this pending claim or the later durable trace association, never a gap
 * between the two.
 */
export async function claimIdempotencyReplay(
  store: AartStore,
  resolvedKey: string,
  run: RunRecord,
  stepId: string,
  traceSeq: number,
  resolvedSecretRefs: Set<string>,
  canReplay: (
    protectedRun: RunRecord,
    recordedOutput: unknown,
  ) => boolean,
): Promise<IdempotencyCheck> {
  return store.transact(async (tx) => {
    const storageKey = idempotencyStorageKey(resolvedKey);
    const activeState =
      await tx.runs.getOperationalState(run.runId);
    const pendingWithoutThisOccurrence = (
      activeState?.pendingIdempotencyReplays ?? []
    ).filter(
      (candidate) =>
        candidate.stepId !== stepId ||
        candidate.traceSeq !== traceSeq,
    );
    const clearStaleClaim = async (): Promise<void> => {
      if (
        activeState === undefined ||
        pendingWithoutThisOccurrence.length ===
          (activeState.pendingIdempotencyReplays ?? []).length
      ) {
        return;
      }
      const {
        pendingIdempotencyReplays: _staleClaims,
        ...stateWithoutClaims
      } = activeState;
      await tx.runs.putOperationalState(run.runId, {
        ...stateWithoutClaims,
        ...(pendingWithoutThisOccurrence.length > 0
          ? {
              pendingIdempotencyReplays:
                pendingWithoutThisOccurrence,
            }
          : {}),
      });
    };
    const entry = await tx.idempotencyLedger.get(storageKey);
    if (
      !entry ||
      entry.schemaVersion !== CURRENT_ENGINE_SCHEMA_VERSION
    ) {
      await clearStaleClaim();
      return { alreadyCompleted: false };
    }
    for (const value of activeState?.resolvedSecretValues ?? []) {
      resolvedSecretRefs.add(value);
    }
    if (!canReplay(activeState?.run ?? run, entry.recordedOutput)) {
      await clearStaleClaim();
      return { alreadyCompleted: false };
    }
    const claim: IdempotencyReplayClaim = {
      ledgerKey: entry.resolvedKey,
      stepId,
      traceSeq,
    };
    // One occurrence can represent only one admitted replay. A reclaimed
    // attempt replaces any stale claim from an older ledger generation
    // rather than inheriting its revocation state.
    const pending = [
      ...pendingWithoutThisOccurrence,
      claim,
    ];
    await tx.runs.putOperationalState(run.runId, {
      ...(activeState ?? {
        run,
        resolvedSecretValues: [...resolvedSecretRefs],
      }),
      pendingIdempotencyReplays: pending,
    });
    return {
      alreadyCompleted: true,
      recordedOutput: entry.recordedOutput,
    };
  });
}

export function retainUnsettledIdempotencyReplayClaims(
  state: RunOperationalState | undefined,
  run: RunRecord,
): IdempotencyReplayClaim[] | undefined {
  const pending = state?.pendingIdempotencyReplays?.filter(
    (claim) =>
      !run.trace.some(
        (trace) =>
          trace.seq === claim.traceSeq &&
          trace.stepId === claim.stepId,
      ),
  );
  return pending === undefined || pending.length === 0
    ? undefined
    : pending;
}

/** Records a step attempt's output under its resolved idempotency key — called ONLY after a successful (post-retry) execution, never for an attempt that exhausted its retries and ultimately failed (architecture §4.2: a genuinely-failed attempt gets no protection, so a later retry of the whole step/run tries again fresh, which is correct — the attempt truly never succeeded). */
export async function recordIdempotency(
  store: AartStore,
  resolvedKey: string,
  runId: string,
  stepId: string,
  recordedOutput: unknown,
  now: Date,
  traceSeq?: number,
): Promise<void> {
  const storageKey = idempotencyStorageKey(resolvedKey);
  await store.idempotencyLedger.put({
    resolvedKey: storageKey,
    runId,
    stepId,
    ...(traceSeq !== undefined ? { traceSeq } : {}),
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
  entry: IdempotencyLedgerEntry,
  producerAssociation = false,
): boolean {
  const associated = run.trace.filter((trace) =>
    traceMatchesLedgerEntry(trace, entry),
  );
  if (associated.length > 0) {
    return associated.some(
      (trace) =>
        trace.secretTainted === true ||
        trace.controlSecretTainted === true,
    );
  }
  if (!producerAssociation || run.runId !== entry.runId) {
    return false;
  }
  const producerTrace =
    entry.traceSeq === undefined
      ? undefined
      : run.trace.find(
          (trace) =>
            trace.seq === entry.traceSeq &&
            trace.stepId === entry.stepId,
        );
  // Missing trace means the ledger commit may have won the crash race.
  // A legacy row without traceSeq is equally unprovable once its mutable
  // key association is unavailable.
  if (producerTrace === undefined) return true;
  return (
    producerTrace.secretTainted === true ||
    producerTrace.controlSecretTainted === true
  );
}

function traceMatchesLedgerEntry(
  trace: StepTrace,
  entry: IdempotencyLedgerEntry,
): boolean {
  return (
    trace.idempotencyLedgerKey === entry.resolvedKey ||
    trace.idempotencyLedgerFingerprint ===
      idempotencyAssociationFingerprint(entry.resolvedKey)
  );
}

function markDirectLedgerConsumers(
  run: RunRecord,
  outputTaintedEntries: readonly IdempotencyLedgerEntry[],
): RunRecord {
  if (outputTaintedEntries.length === 0) return run;
  return {
    ...run,
    trace: run.trace.map((trace) =>
      outputTaintedEntries.some((entry) =>
        traceMatchesLedgerEntry(trace, entry),
      )
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
  pendingIdempotencyReplays?: IdempotencyReplayClaim[],
): Promise<RunRecord> {
  const effectiveSecretRefs = new Set(resolvedSecretRefs);
  const activeState =
    await store.runs.getOperationalState(run.runId);
  const operationalRun =
    run.status === "pending" || run.status === "running"
      ? await mergeActiveRunProtection(
          store,
          run,
          effectiveSecretRefs,
        )
      : run;
  const redacted = applyRunRedaction(
    redact,
    operationalRun,
    effectiveSecretRefs,
  );
  if (run.status === "waiting") {
    const waits = await store.waits.list({ runId: run.runId });
    const existing =
      waits[0] === undefined
        ? undefined
        : await store.waits.getOperationalRunState(
            waits[0].runId,
            waits[0].stepId,
          );
    if (waits.length > 0) {
      await store.waits.replaceOperationalRunState(run.runId, {
        run: mergeOperationalRunTaint(
          existing?.run ?? run,
          redacted,
        ),
        resolvedSecretValues: [
          ...new Set([
            ...(existing?.resolvedSecretValues ?? []),
            ...effectiveSecretRefs,
          ]),
        ],
        ...(pendingIdempotencyReplays !== undefined &&
        pendingIdempotencyReplays.length > 0
          ? { pendingIdempotencyReplays }
          : {}),
      });
    }
  }
  await store.runs.put(redacted);
  if (
    operationalRun.status === "pending" ||
    operationalRun.status === "running"
  ) {
    await store.runs.putOperationalState(run.runId, {
      run: operationalRun,
      resolvedSecretValues: [...effectiveSecretRefs],
      ...(pendingIdempotencyReplays !== undefined
        ? pendingIdempotencyReplays.length > 0
          ? { pendingIdempotencyReplays }
          : {}
        : activeState?.pendingIdempotencyReplays !== undefined
        ? {
            pendingIdempotencyReplays:
              activeState.pendingIdempotencyReplays,
          }
        : {}),
    });
  } else {
    await store.runs.deleteOperationalState(run.runId);
  }
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
  invalidatedTerminalRunIds?: Set<string>,
): Promise<RunRecord> {
  if (resolvedSecretRefs.size === 0) return run;
  const entries = await store.idempotencyLedger.list();
  const entriesByKey = new Map(
    entries.map((entry) => [entry.resolvedKey, entry]),
  );
  const entriesByFingerprint = new Map(
    entries.map((entry) => [
      idempotencyAssociationFingerprint(entry.resolvedKey),
      entry,
    ]),
  );
  const entryForTrace = (
    trace: StepTrace,
  ): IdempotencyLedgerEntry | undefined =>
    (trace.idempotencyLedgerKey === undefined
      ? undefined
      : entriesByKey.get(trace.idempotencyLedgerKey)) ??
    (trace.idempotencyLedgerFingerprint === undefined
      ? undefined
      : entriesByFingerprint.get(
          trace.idempotencyLedgerFingerprint,
        ));
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
  if (
    run.status === "completed" &&
    activeRun.status === "failed"
  ) {
    invalidatedTerminalRunIds?.add(run.runId);
  }
  const activeAudit = applyRunRedaction(
    redact,
    activeRun,
    resolvedSecretRefs,
  );
  activeRun = mergeOperationalRunTaint(
    activeRun,
    activeAudit,
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
    if (
      persistedProducer.status === "completed" &&
      preparedProducer.status === "failed"
    ) {
      invalidatedTerminalRunIds?.add(persistedProducer.runId);
    }
    const redactedProducer = await redactAndPersistRun(
      store,
      redact,
      preparedProducer,
      resolvedSecretRefs,
    );
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
    const producerAssociationUnsafe =
      producerRun === undefined ||
      traceHasTaintedLedgerOutput(
        producerRun,
        entry,
        true,
      );
    const consumedByTaintedTrace =
      producerAssociationUnsafe ||
      traceHasTaintedLedgerOutput(
        activeRun,
        entry,
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
  const pendingReplayClaimsByRunId = new Map<
    string,
    IdempotencyReplayClaim[]
  >();
  for (const [runId, candidateRun] of runsById) {
    if (
      candidateRun.status !== "pending" &&
      candidateRun.status !== "running"
    ) {
      continue;
    }
    const state = await store.runs.getOperationalState(runId);
    if (
      state?.pendingIdempotencyReplays !== undefined &&
      state.pendingIdempotencyReplays.length > 0
    ) {
      pendingReplayClaimsByRunId.set(
        runId,
        state.pendingIdempotencyReplays,
      );
    }
  }
  const consumersByKey = new Map<string, Set<string>>();
  for (const [runId, candidateRun] of runsById) {
    for (const trace of candidateRun.trace) {
      const entry = entryForTrace(trace);
      if (!entry) continue;
      const consumers =
        consumersByKey.get(entry.resolvedKey) ??
        new Set<string>();
      consumers.add(runId);
      consumersByKey.set(entry.resolvedKey, consumers);
    }
    for (const claim of
      pendingReplayClaimsByRunId.get(runId) ?? []) {
      if (!entriesByKey.has(claim.ledgerKey)) continue;
      const consumers =
        consumersByKey.get(claim.ledgerKey) ??
        new Set<string>();
      consumers.add(runId);
      consumersByKey.set(claim.ledgerKey, consumers);
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
      const batchSet = new Set(batch);
      const consumedKeys = new Set(
        [
          ...persistedRun.trace.flatMap((trace) => {
            const entry = entryForTrace(trace);
            return entry !== undefined &&
              batchSet.has(entry.resolvedKey)
              ? [entry.resolvedKey]
              : [];
          }),
          ...(pendingReplayClaimsByRunId.get(runId) ?? [])
            .filter((claim) => batchSet.has(claim.ledgerKey))
            .map((claim) => claim.ledgerKey),
        ],
      );
      if (consumedKeys.size === 0) continue;

      const taintedConsumedKeys = new Set(
        [...consumedKeys].filter((key) => outputTaintedKeys.has(key)),
      );
      const pendingReplayClaims = (
        pendingReplayClaimsByRunId.get(runId) ?? []
      ).map((claim) =>
        taintedConsumedKeys.has(claim.ledgerKey)
          ? { ...claim, outputSecretTainted: true }
          : claim,
      );
      if (pendingReplayClaims.length > 0) {
        pendingReplayClaimsByRunId.set(
          runId,
          pendingReplayClaims,
        );
      }
      const directlyMarked = markDirectLedgerConsumers(
        persistedRun,
        [...taintedConsumedKeys].flatMap((key) => {
          const entry = entriesByKey.get(key);
          return entry === undefined ? [] : [entry];
        }),
      );
      const prepared = prepareConsumer
        ? await prepareConsumer(
            store,
            directlyMarked,
            taintedConsumedKeys,
            resolvedSecretRefs,
          )
        : directlyMarked;
      if (
        persistedRun.status === "completed" &&
        prepared.status === "failed"
      ) {
        invalidatedTerminalRunIds?.add(runId);
      }
      const repaired =
        runId === activeRun.runId
          ? mergeOperationalRunTaint(
              prepared,
              applyRunRedaction(
                redact,
                prepared,
                resolvedSecretRefs,
              ),
            )
          : await redactAndPersistRun(
              store,
              redact,
              prepared,
              resolvedSecretRefs,
              pendingReplayClaims,
            );
      if (runId === activeRun.runId) {
        activeRun = repaired;
        if (pendingReplayClaims.length > 0) {
          const activeState =
            await store.runs.getOperationalState(runId);
          await store.runs.putOperationalState(runId, {
            ...(activeState ?? {
              run: repaired,
              resolvedSecretValues: [],
            }),
            resolvedSecretValues: [
              ...new Set([
                ...(activeState?.resolvedSecretValues ?? []),
                ...resolvedSecretRefs,
              ]),
            ],
            pendingIdempotencyReplays: pendingReplayClaims,
          });
        }
      }
      runsById.set(runId, repaired);

      for (const trace of prepared.trace) {
        const entry = entryForTrace(trace);
        if (
          entry !== undefined &&
          (trace.secretTainted === true ||
            trace.controlSecretTainted === true)
        ) {
          pendingKeys.add(entry.resolvedKey);
          outputTaintedKeys.add(entry.resolvedKey);
        }
      }
    }
  }
  return activeRun;
}
