// Lease renewal (architecture §4.7): "a heartbeat on a short interval while
// actively processing a claimed run, renewing job_queue.lease_expires_at."
import type { AartStore } from "@aart/store";
import type { Clock } from "../clock.js";
import type { Logger } from "../logger.js";

export interface LeaseHeartbeatHandle {
  stop(): void;
}

/** Renews the lease on every runId currently in `claimedRunIds` every `heartbeatIntervalMs`, extending each by `leaseDurationMs` from the renewal moment. `claimedRunIds` is read fresh on every beat (a live `Set` reference, not a snapshot) so runs claimed/released after `startLeaseHeartbeat` is called are picked up/dropped automatically. */
export function startLeaseHeartbeat(store: AartStore, clock: Clock, logger: Logger, claimedRunIds: ReadonlySet<string>, leaseDurationMs: number, heartbeatIntervalMs: number): LeaseHeartbeatHandle {
  const handle = clock.setTimeout(function beat() {
    void renewAll().finally(() => {
      nextHandle = clock.setTimeout(beat, heartbeatIntervalMs);
    });
  }, heartbeatIntervalMs);
  let nextHandle = handle;

  async function renewAll(): Promise<void> {
    const leaseExpiresAt = new Date(clock.now().getTime() + leaseDurationMs).toISOString();
    for (const runId of claimedRunIds) {
      try {
        await store.jobQueue.renewLease(runId, leaseExpiresAt);
      } catch (err) {
        logger.warn("lease renewal failed for claimed run", { runId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    stop() {
      nextHandle.cancel();
    },
  };
}
