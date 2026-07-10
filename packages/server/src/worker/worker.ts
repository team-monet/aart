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
import { shouldFlagPoison } from "../poison.js";
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

  /**
   * architecture §6.2's poison-run guard: "a correlation key... that
   * accumulates N consecutive failures within a configurable time window
   * has its MOST RECENT run set to... flag: { kind: 'poison', flaggedAt }."
   * `poison.ts`'s `shouldFlagPoison` is the pure decision function; THIS is
   * the one place in this package that actually calls it and writes the
   * flag — the natural hook is "right after a claimed run's execution
   * completes normally and left the run in `failed` status," which is
   * exactly what this function is called from below. Skipped if the run is
   * already flagged (nothing to add) or isn't `failed` at all.
   */
  async function maybeFlagPoison(runId: string): Promise<void> {
    const run = await options.store.runs.get(runId);
    if (!run || run.status !== "failed" || run.flag) return;
    const flag = await shouldFlagPoison(options.store, run.workflowId, run.trigger, {
      maxConsecutiveFailures: options.maxConsecutiveFailures,
      windowMs: options.windowMs,
      now: clock.now(),
    });
    if (!flag) return;
    await options.store.runs.put({ ...run, flag: { kind: "poison", flaggedAt: clock.nowIso() } });
    logger.error("run flagged poison after N consecutive failures on this correlation key (architecture §6.2) — will not be auto-retried until a human clears it", { runId, workflowId: run.workflowId });
  }

  async function executeOneClaim(runId: string): Promise<void> {
    try {
      await options.engine.executeClaimedRun(runId, workerId);
      logger.info("run finished (completed, or reached a checkpoint the engine will resume later)", { runId });
      claimedRunIds.delete(runId);
      await maybeFlagPoison(runId);
      // Best-effort backstop, reached ONLY on a NORMAL (non-throwing)
      // completion: if the engine's own completion path didn't already
      // remove/release the job_queue entry (e.g. a checkpoint that doesn't
      // clear its own claim), don't leave it dangling until the reclaim
      // sweep's next tick notices the lease is still nominally valid —
      // release it now. A run correctly checkpointed into `waiting` by the
      // engine has already had its claim released as part of that
      // checkpoint (S1's job); this call is then a harmless no-op against
      // an already-gone job_queue entry.
      await options.store.jobQueue.release(runId).catch(() => undefined);
    } catch (err) {
      // Deliberately do NOT release the claim here. An exception escaping
      // executeClaimedRun is exactly the "worker died mid-step" shape
      // architecture §4.7's lease/reclaim machinery exists for —
      // releasing immediately would let this (or another) worker re-claim
      // and re-throw in a tight loop with no backoff and no bound,
      // bypassing the bounded reclaim_count -> reclaim_exhausted
      // protection this package already built (worker/reclaim.ts). Leaving
      // the lease in place lets it expire naturally and routes through
      // that existing, bounded mechanism instead of a second, weaker one.
      logger.error("executeClaimedRun threw — leaving the claim in place for the lease/reclaim-sweep mechanism to handle (architecture §4.7)", { runId, error: err instanceof Error ? err.message : String(err) });
      claimedRunIds.delete(runId);
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
