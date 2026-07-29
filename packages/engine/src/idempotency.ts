// Idempotency key handling (spec §30.2, architecture §4.2). "before
// executing, check if a prior attempt with the same key already completed;
// if so, replay its recorded output instead of re-executing." Ledger
// placement is `store.idempotencyLedger` (architecture §5.7 — a dedicated
// collection, not folded into StepTrace rows, so a resolved key is
// checkable before that attempt's StepTrace even exists).
import type { AartStore } from "@aart/store";
import type { RedactFn } from "@aart/types";
import { applyRedaction, changedJsonPointers } from "./redaction.js";
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

/**
 * A secret may first be resolved after an earlier attempt wrote its output
 * to the ledger. Revisit this run's entries whenever its known-secret set
 * grows and revoke any output the real redactor now changes.
 */
export async function revokeSecretTaintedIdempotency(
  store: AartStore,
  redact: RedactFn,
  runId: string,
  resolvedSecretRefs: ReadonlySet<string>,
): Promise<void> {
  if (resolvedSecretRefs.size === 0) return;
  const entries = await store.idempotencyLedger.listByRun(runId);
  await Promise.all(
    entries.map(async (entry) => {
      const redacted = applyRedaction(
        redact,
        entry.recordedOutput,
        resolvedSecretRefs,
      );
      if (
        changedJsonPointers(entry.recordedOutput, redacted).length > 0
      ) {
        await store.idempotencyLedger.delete(entry.resolvedKey);
      }
    }),
  );
}
