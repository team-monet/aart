// Graceful SIGTERM handling (architecture §4.7): "(1) immediately stopping
// new claims from job_queue, (2) letting in-flight steps finish or reach
// their next natural checkpoint... within a configurable grace period, (3)
// releasing any claims it still holds cleanly... before exiting." This is
// what makes a Kubernetes rolling deploy (which SIGTERMs every worker pod
// on every deploy, §14) the ORDINARY case rather than something the reclaim
// sweep alone has to cover.
import type { AartStore } from "@aart/store";
import type { Clock } from "../clock.js";
import type { Logger } from "../logger.js";

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

export interface GracefulShutdownOptions {
  store: AartStore;
  logger: Logger;
  claimedRunIds: Set<string>;
  graceMs: number;
  clock: Clock;
  /** Polling granularity for checking whether `claimedRunIds` has drained — defaults to 200ms, overridable so tests don't need real wall-clock waits. */
  pollMs?: number;
  /** S9 integration (reconciliation ledger item 10) — see config.ts's `LeaseConfig.onShutdown` doc comment. Coarse resource-cleanup safety net, run after the drain/release loop below. */
  onShutdown?: () => void | Promise<void>;
}

/**
 * Waits up to `graceMs` for `claimedRunIds` to drain on its own (the
 * worker's own claim-completion callback — worker/worker.ts — removes a
 * runId from this set once `executeClaimedRun` resolves, whether that's
 * because the run reached its next checkpoint/wait boundary or completed
 * outright). Anything still claimed once the grace period elapses has its
 * `job_queue` claim released explicitly (rather than left for the reclaim
 * sweep to notice on its own next tick, once the lease naturally expires)
 * so another worker can pick it up sooner.
 */
export async function gracefulShutdown(options: GracefulShutdownOptions): Promise<void> {
  const { store, logger, claimedRunIds, graceMs, clock } = options;
  const pollMs = options.pollMs ?? 200;
  logger.info("graceful shutdown starting — no longer claiming new work", { inFlight: claimedRunIds.size, graceMs });

  const deadline = clock.now().getTime() + graceMs;
  while (claimedRunIds.size > 0 && clock.now().getTime() < deadline) {
    await sleep(clock, pollMs);
  }

  if (claimedRunIds.size > 0) {
    logger.warn("grace period elapsed with claims still held — releasing them for the reclaim sweep / another worker", { remaining: claimedRunIds.size });
  }
  for (const runId of [...claimedRunIds]) {
    try {
      await store.jobQueue.release(runId);
    } catch (err) {
      logger.error("failed to release claim during shutdown", { runId, error: err instanceof Error ? err.message : String(err) });
    }
    claimedRunIds.delete(runId);
  }

  if (options.onShutdown) {
    try {
      await options.onShutdown();
    } catch (err) {
      // Best-effort, same reasoning as the engine's onRunTerminal hook: a
      // resource-cleanup failure (e.g. closing an already-closed browser
      // context) must never block process exit during shutdown.
      logger.error("onShutdown cleanup hook failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info("graceful shutdown complete");
}
