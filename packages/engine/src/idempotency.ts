// Idempotency key handling (spec §30.2, architecture §4.2). "before
// executing, check if a prior attempt with the same key already completed;
// if so, replay its recorded output instead of re-executing." Ledger
// placement is `store.idempotencyLedger` (architecture §5.7 — a dedicated
// collection, not folded into StepTrace rows, so a resolved key is
// checkable before that attempt's StepTrace even exists).
import type { AartStore } from "@aart/store";

export interface IdempotencyCheck {
  /** `true` if a prior attempt with this resolved key already completed — `recordedOutput` is that attempt's output, to replay instead of re-executing the block. */
  alreadyCompleted: boolean;
  recordedOutput?: unknown;
}

export async function checkIdempotency(store: AartStore, resolvedKey: string): Promise<IdempotencyCheck> {
  const entry = await store.idempotencyLedger.get(resolvedKey);
  if (!entry) return { alreadyCompleted: false };
  return { alreadyCompleted: true, recordedOutput: entry.recordedOutput };
}

/** Records a step attempt's output under its resolved idempotency key — called ONLY after a successful (post-retry) execution, never for an attempt that exhausted its retries and ultimately failed (architecture §4.2: a genuinely-failed attempt gets no protection, so a later retry of the whole step/run tries again fresh, which is correct — the attempt truly never succeeded). */
export async function recordIdempotency(store: AartStore, resolvedKey: string, runId: string, stepId: string, recordedOutput: unknown, now: Date): Promise<void> {
  await store.idempotencyLedger.put({ resolvedKey, runId, stepId, recordedOutput, createdAt: now.toISOString() });
}
