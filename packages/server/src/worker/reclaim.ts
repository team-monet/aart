// The lease-reclaim sweep (architecture §4.7) — sweeps `job_queue` for
// claims past `lease_expires_at`, requeues them, and after a bounded
// `reclaim_count` sets the run's terminal state to `flag: {kind:
// "reclaim_exhausted"}` rather than requeuing forever. Invoked FROM the
// scheduler ticker (ticker/ticker.ts) — architecture places this
// integration explicitly ("the scheduler ticker... also sweeps job_queue
// for claims past lease_expires_at"), not as a second, separate loop.
import type { AartStore } from "@aart/store";
import type { Clock } from "../clock.js";
import { DEFAULT_MAX_RECLAIM_COUNT } from "../config.js";
import type { Logger } from "../logger.js";

export interface ReclaimSweepResult {
  requeued: string[];
  exhausted: string[];
}

export async function runReclaimSweep(store: AartStore, clock: Clock, logger: Logger, maxReclaimCount: number = DEFAULT_MAX_RECLAIM_COUNT): Promise<ReclaimSweepResult> {
  const now = clock.nowIso();
  // listClaimable(now) returns BOTH never-claimed entries and expired-lease
  // entries (JobQueueStore's documented contract) — only the latter (a
  // claim actually held, now stale) is a "reclaim" event; a never-claimed
  // entry is just ordinary unclaimed work, nothing to reclaim.
  const claimable = await store.jobQueue.listClaimable(now);
  const staleClaims = claimable.filter((e) => e.claimedBy !== null);

  const requeued: string[] = [];
  const exhausted: string[] = [];

  for (const entry of staleClaims) {
    const newCount = await store.jobQueue.incrementReclaimCount(entry.runId);
    if (newCount > maxReclaimCount) {
      const run = await store.runs.get(entry.runId);
      if (run) {
        await store.runs.put({
          ...run,
          status: "failed",
          error: run.error ?? `Reclaim-exhausted: the claiming worker failed to renew its lease after ${newCount} reclaim attempts.`,
          flag: { kind: "reclaim_exhausted", flaggedAt: clock.nowIso() },
          updatedAt: clock.nowIso(),
          endedAt: run.endedAt ?? clock.nowIso(),
        });
      }
      // Removed entirely (not merely released) — a reclaim-exhausted run is
      // terminal and must never be claimable again, unlike an ordinary
      // requeue below.
      await store.jobQueue.remove(entry.runId);
      exhausted.push(entry.runId);
      logger.error("run reclaim-exhausted — flagged, will not be auto-retried; requires a human clear (architecture §4.7/§6.2)", { runId: entry.runId, reclaimCount: newCount, maxReclaimCount });
    } else {
      await store.jobQueue.release(entry.runId);
      requeued.push(entry.runId);
      logger.warn("run requeued after lease expiry — a different worker may now claim it (architecture §4.7)", { runId: entry.runId, reclaimCount: newCount, maxReclaimCount });
    }
  }

  return { requeued, exhausted };
}
