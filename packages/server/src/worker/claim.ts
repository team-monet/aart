// Race-safe claim helper (architecture §4.7/ADR-05's "race-safe... requiring
// real care" consequence). `JobQueueStore.setClaim` is `Promise<void>` on
// the frozen interface — this package's SQLite adapter implements it as a
// CONDITIONAL UPDATE (only succeeds if still unclaimed or lease-expired,
// see packages/store/src/adapters/sqlite/stores/simple-stores.ts), so the
// caller-side pattern here — claim, then re-read to confirm — is what
// actually detects a lost race, working correctly against both the fs
// adapter (single-process `aart dev`, no real race by construction, ADR-05)
// and the SQLite adapter (genuinely concurrent worker processes against one
// file).
import type { AartStore, JobQueueEntry } from "@aart/store";
import type { Clock } from "../clock.js";

export async function tryClaimNextRun(store: AartStore, workerId: string, clock: Clock, leaseDurationMs: number): Promise<JobQueueEntry | undefined> {
  const now = clock.nowIso();
  const candidates = await store.jobQueue.listClaimable(now);
  for (const candidate of candidates) {
    const leaseExpiresAt = new Date(clock.now().getTime() + leaseDurationMs).toISOString();
    await store.jobQueue.setClaim(candidate.runId, workerId, leaseExpiresAt);
    const confirmed = await store.jobQueue.get(candidate.runId);
    if (confirmed?.claimedBy === workerId) {
      return confirmed;
    }
    // Lost the race to another worker (or, under the fs adapter, a
    // logically-impossible-but-harmless no-op) — move on to the next
    // candidate rather than giving up the whole claim attempt.
  }
  return undefined;
}
