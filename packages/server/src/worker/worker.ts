// startWorker() — the `aart worker` bin's runtime (architecture §1 note:
// folded into @aart/server as a bin target, not a separate package). Ties
// together: the race-safe claim loop + worker-level maxConcurrentRuns
// admission control (architecture §4.3), lease-heartbeat renewal
// (architecture §4.7), the GET /health endpoint (ADR-16/§16), and graceful
// SIGTERM shutdown (architecture §4.7). The reclaim SWEEP itself runs
// inside the scheduler ticker (ticker/ticker.ts), owned by `aart server`
// per architecture §4.4.3/§4.7's explicit single-instance-ticker placement
// — see this task's final report for why this worker does not run its own
// sweep.
import { systemClock, type Clock } from "../clock.js";
import { DEFAULT_HEALTH_PORT, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_LEASE_DURATION_MS, DEFAULT_MAX_CONCURRENT_RUNS, DEFAULT_SHUTDOWN_GRACE_MS, type WorkerConfig } from "../config.js";
import { generateId } from "../ids.js";
import { createServerLogger, type Logger } from "../logger.js";
import { tryClaimNextRun } from "./claim.js";
import { startHealthServer, type HealthServerHandle } from "./health.js";
import { startLeaseHeartbeat, type LeaseHeartbeatHandle } from "./lease.js";
import { gracefulShutdown } from "./shutdown.js";

export interface WorkerHandle {
  workerId: string;
  claimedRunIds: ReadonlySet<string>;
  healthPort: number;
  /** Runs one claim-attempt pass immediately, outside the poll interval — used by tests and by the worker's own startup. */
  claimTick(): Promise<void>;
  /** Graceful shutdown (architecture §4.7) — safe to call directly from a test or from a wired `SIGTERM` handler alike. */
  stop(): Promise<void>;
}

export interface StartWorkerOptions extends WorkerConfig {
  /** Claim-attempt poll cadence — how often the worker checks `job_queue` for newly-claimable work. Distinct from the ticker's own interval (this is a worker-local concern, not the single-instance scheduler ticker). Defaults to 1000ms. */
  claimPollMs?: number;
  /** Wire `process.once("SIGTERM", ...)` to this worker's `stop()` — the production default. Tests that call `stop()` explicitly should pass `false` to avoid accumulating process-level listeners across many `startWorker()` calls in one test run. */
  installSignalHandler?: boolean;
}

export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const clock: Clock = options.clock ?? systemClock;
  const logger: Logger = createServerLogger(options.logSink).child({ component: "worker" });
  const workerId = options.workerId ?? generateId("worker");
  const maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const healthPort = options.healthPort ?? DEFAULT_HEALTH_PORT;
  const claimPollMs = options.claimPollMs ?? 1000;

  const claimedRunIds = new Set<string>();
  let claiming = true;
  let claimTimer: { cancel(): void } | undefined;

  async function executeOneClaim(runId: string): Promise<void> {
    try {
      await options.engine.executeClaimedRun(runId, workerId);
      logger.info("run finished (completed, or reached a checkpoint the engine will resume later)", { runId });
    } catch (err) {
      logger.error("executeClaimedRun threw", { runId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      claimedRunIds.delete(runId);
      // Best-effort backstop: if the engine's own completion path didn't
      // already remove/release the job_queue entry (e.g. a run that
      // errored before reaching any checkpoint), don't leave a claim
      // dangling until the reclaim sweep's next tick notices the lease is
      // still nominally valid — release it now so another worker (or this
      // one) can pick it up promptly. A run correctly checkpointed into
      // `waiting` by the engine has already had its claim released as part
      // of that checkpoint (S1's job); this call is then a harmless no-op
      // against an already-gone job_queue entry.
      await options.store.jobQueue.release(runId).catch(() => undefined);
    }
  }

  async function claimTick(): Promise<void> {
    if (!claiming) return;
    while (claiming && claimedRunIds.size < maxConcurrentRuns) {
      const claimed = await tryClaimNextRun(options.store, workerId, clock, leaseDurationMs);
      if (!claimed) break;
      claimedRunIds.add(claimed.runId);
      logger.info("claimed run", { runId: claimed.runId });
      void executeOneClaim(claimed.runId);
    }
  }

  function scheduleClaimLoop(): void {
    claimTimer = clock.setTimeout(() => {
      void claimTick().finally(() => {
        if (claiming) scheduleClaimLoop();
      });
    }, claimPollMs);
  }

  await claimTick();
  scheduleClaimLoop();

  const lease: LeaseHeartbeatHandle = startLeaseHeartbeat(options.store, clock, logger, claimedRunIds, leaseDurationMs, heartbeatIntervalMs);
  const health: HealthServerHandle = await startHealthServer(healthPort, () => claimedRunIds.size);

  async function stop(): Promise<void> {
    claiming = false;
    claimTimer?.cancel();
    lease.stop();
    await gracefulShutdown({ store: options.store, logger, claimedRunIds, graceMs: shutdownGraceMs, clock });
    await health.close();
  }

  if (options.installSignalHandler !== false) {
    const onSigterm = (): void => {
      void stop();
    };
    process.once("SIGTERM", onSigterm);
    const originalStop = stop;
    return {
      workerId,
      claimedRunIds,
      healthPort: health.port,
      claimTick,
      stop: async () => {
        process.off("SIGTERM", onSigterm);
        await originalStop();
      },
    };
  }

  return { workerId, claimedRunIds, healthPort: health.port, claimTick, stop };
}
