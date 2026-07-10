import { afterEach, describe, expect, it } from "vitest";
import { tryClaimNextRun } from "./claim.js";
import { runReclaimSweep } from "./reclaim.js";
import { startWorker, type WorkerHandle } from "./worker.js";
import { createFakeClock, createTestFixture, driveClockUntil, flushAsync, type TestFixture } from "../test-helpers.js";

let fx: TestFixture | undefined;
let workers: WorkerHandle[] = [];
afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  workers = [];
  await fx?.cleanup();
  fx = undefined;
});

function fixtureRunRecord(runId: string, clock: ReturnType<typeof createFakeClock>) {
  return {
    runId,
    workflowId: "wf",
    workflowVersion: "1",
    status: "pending" as const,
    approved: true,
    approvalMode: "dev" as const,
    trigger: { type: "manual" as const, id: "t1", source: "cli", payload: null, receivedAt: clock.nowIso() },
    inputs: {},
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: clock.nowIso() },
    startedAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
    schemaVersion: 1,
  };
}

describe("race-safe claim (architecture §4.7/ADR-05)", () => {
  it("a worker cannot claim a run another worker already holds a valid lease on", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    await fx.store.jobQueue.enqueue("run_race");
    const a = await tryClaimNextRun(fx.store, "worker-A", clock, 30_000);
    expect(a?.runId).toBe("run_race");
    // Worker B's attempt AFTER A's claim is already visible must find
    // nothing claimable — this is the caller-side "claim, then verify"
    // pattern's actual guarantee; genuine CROSS-CONNECTION race safety
    // under true concurrency is the SQLite adapter's own property,
    // verified independently in packages/store's sqlite-store.test.ts
    // (this package's own tests use the fs adapter, architecturally
    // single-process/no-concurrent-claim-race by design, ADR-05).
    const b = await tryClaimNextRun(fx.store, "worker-B", clock, 30_000);
    expect(b).toBeUndefined();
  });

  it("returns undefined when nothing is claimable", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    await expect(tryClaimNextRun(fx.store, "worker-A", clock, 30_000)).resolves.toBeUndefined();
  });
});

describe("worker-level maxConcurrentRuns admission control (architecture §4.3)", () => {
  it("does not claim beyond the configured cap, regardless of how much work is queued", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    // Realistic pairing: a job_queue entry always has a backing RunRecord
    // (createFakeEngine.startRun always writes both together) — this is
    // what lets the fake engine actually COMPLETE (and remove) each claim
    // rather than no-op-and-release it back to claimable, which would
    // otherwise busy-loop the claim cap check into meaninglessness.
    for (let i = 0; i < 5; i++) {
      await fx.store.runs.put(fixtureRunRecord(`run_${i}`, clock));
      await fx.store.jobQueue.enqueue(`run_${i}`);
    }

    const worker = await startWorker({ store: fx.store, engine: fx.engine, clock, maxConcurrentRuns: 2, installSignalHandler: false, healthPort: 0, claimPollMs: 1000 });
    workers.push(worker);
    expect(worker.claimedRunIds.size).toBeLessThanOrEqual(2);
    await flushAsync();
    // All 5 eventually complete (each claim slot frees up and reclaims the
    // next queued job) — proving the cap bounds CONCURRENCY, not total
    // throughput.
    for (let i = 0; i < 30 && (await fx.store.runs.list({ status: "completed" })).length < 5; i++) {
      await worker.claimTick();
      await flushAsync();
    }
    const completed = await fx.store.runs.list({ status: "completed" });
    expect(completed.length).toBe(5);
  }, 15000);
});

describe("lease renewal (architecture §4.7)", () => {
  it("a claimed run's lease is renewed on the heartbeat interval, staying ahead of expiry", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    // A run whose engine execution never resolves — so it stays "claimed"
    // long enough to observe lease renewal (the fake engine's
    // executeClaimedRun would otherwise complete immediately and the
    // worker would release it right away).
    await fx.store.runs.put(fixtureRunRecord("run_slow", clock));
    await fx.store.jobQueue.enqueue("run_slow");

    let resolveExecution: () => void = () => {};
    const neverResolvingEngine = {
      ...fx.engine,
      executeClaimedRun: () => new Promise<void>((resolve) => (resolveExecution = resolve)),
    };

    const worker = await startWorker({ store: fx.store, engine: neverResolvingEngine, clock, leaseDurationMs: 10_000, heartbeatIntervalMs: 3_000, installSignalHandler: false, healthPort: 0 });
    workers.push(worker);
    expect(worker.claimedRunIds.has("run_slow")).toBe(true);

    const initialLease = (await fx.store.jobQueue.get("run_slow"))?.leaseExpiresAt;
    clock.advance(3_100); // past the first heartbeat
    await flushAsync(); // let the heartbeat's own async renewLease() write land
    const renewedLease = (await fx.store.jobQueue.get("run_slow"))?.leaseExpiresAt;
    expect(renewedLease).not.toBe(initialLease);
    expect(new Date(renewedLease!).getTime()).toBeGreaterThan(new Date(initialLease!).getTime());

    resolveExecution();
    await flushAsync();
  }, 15000);
});

describe("graceful SIGTERM shutdown (architecture §4.7)", () => {
  it("releases claims cleanly once in-flight work finishes within the grace period", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    await fx.store.runs.put(fixtureRunRecord("run_graceful", clock));
    await fx.store.jobQueue.enqueue("run_graceful");

    let resolveExecution: () => void = () => {};
    const controlledEngine = { ...fx.engine, executeClaimedRun: () => new Promise<void>((resolve) => (resolveExecution = resolve)) };
    const worker = await startWorker({ store: fx.store, engine: controlledEngine, clock, shutdownGraceMs: 5000, installSignalHandler: false, healthPort: 0 });
    workers.push(worker);
    expect(worker.claimedRunIds.has("run_graceful")).toBe(true);

    const stopPromise = worker.stop();
    // Finish the in-flight work shortly after shutdown starts, well within
    // the grace period.
    resolveExecution();
    await flushAsync();
    // Drive gracefulShutdown's internal poll loop (fake-clock-scheduled)
    // forward until it notices the drained claim set.
    await driveClockUntil(clock, () => worker.claimedRunIds.size === 0);
    await stopPromise;
    expect(worker.claimedRunIds.size).toBe(0);
  }, 15000);

  it("force-releases claims still held once the grace period elapses", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    await fx.store.runs.put(fixtureRunRecord("run_stuck", clock));
    await fx.store.jobQueue.enqueue("run_stuck");
    const neverResolvingEngine = { ...fx.engine, executeClaimedRun: () => new Promise<void>(() => {}) };
    const worker = await startWorker({ store: fx.store, engine: neverResolvingEngine, clock, shutdownGraceMs: 2000, installSignalHandler: false, healthPort: 0 });
    workers.push(worker);

    const stopPromise = worker.stop();
    // Drive the clock past the grace period — work still hasn't finished,
    // so gracefulShutdown must force-release rather than wait forever.
    await driveClockUntil(clock, () => worker.claimedRunIds.size === 0, 500, 20);
    await stopPromise;
    await expect(fx.store.jobQueue.get("run_stuck")).resolves.toMatchObject({ claimedBy: null });
  }, 15000);
});

describe("mid-step worker-kill (architecture §4.7 reliability BLOCKER fix) — lighter-weight version of the full S9 E2E", () => {
  it("a run whose claimant died mid-step (no clean release, lease left to expire) is requeued by the reclaim sweep, and a DIFFERENT worker picks it up", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    await fx.store.runs.put(fixtureRunRecord("run_killed", clock));
    await fx.store.jobQueue.enqueue("run_killed");

    // Worker A claims it directly (simulating a claim that's about to be
    // abandoned by a hard kill — no graceful shutdown, no lease renewal,
    // nothing) rather than going through startWorker, so nothing in this
    // test process keeps its lease alive.
    const claimed = await tryClaimNextRun(fx.store, "worker-A-about-to-die", clock, 10_000);
    expect(claimed?.runId).toBe("run_killed");

    // Worker A is now gone. Time passes well beyond the lease duration
    // with no heartbeat.
    clock.advance(15_000);

    const sweep = await runReclaimSweep(fx.store, clock, fx.logger, 3);
    expect(sweep.requeued).toContain("run_killed");
    await expect(fx.store.jobQueue.get("run_killed")).resolves.toMatchObject({ claimedBy: null, reclaimCount: 1 });

    // A genuinely different worker instance now claims and finishes it.
    const workerB = await startWorker({ store: fx.store, engine: fx.engine, clock, workerId: "worker-B-alive", installSignalHandler: false, healthPort: 0 });
    workers.push(workerB);
    await workerB.claimTick();
    await flushAsync(); // let the fake engine's fire-and-forget executeOneClaim finish
    await expect(fx.store.runs.get("run_killed")).resolves.toMatchObject({ status: "completed" });
  }, 15000);

  it("exceeding the bounded reclaim count flags the run reclaim_exhausted instead of requeuing forever (architecture §4.7)", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    await fx.store.runs.put(fixtureRunRecord("run_forever_stuck", clock));
    await fx.store.jobQueue.enqueue("run_forever_stuck");

    const maxReclaimCount = 2;
    let lastSweep = await runReclaimSweep(fx.store, clock, fx.logger, maxReclaimCount);
    // Repeatedly: claim (now that the previous round released/requeued
    // it) -> let the lease expire -> sweep again. Each sweep that finds a
    // stale claim increments reclaimCount by exactly 1 — after
    // maxReclaimCount+1 stale-claim rounds, the sweep must flag exhausted
    // rather than requeue indefinitely.
    for (let attempt = 0; attempt < maxReclaimCount + 2; attempt++) {
      const claimable = await fx.store.jobQueue.listClaimable(clock.nowIso());
      if (claimable.some((c) => c.runId === "run_forever_stuck")) {
        await fx.store.jobQueue.setClaim("run_forever_stuck", `worker-${attempt}`, new Date(clock.now().getTime() + 1000).toISOString());
      } else {
        break; // already exhausted and removed — nothing left to claim
      }
      clock.advance(2000); // past that lease
      lastSweep = await runReclaimSweep(fx.store, clock, fx.logger, maxReclaimCount);
    }

    expect(lastSweep.exhausted).toContain("run_forever_stuck");
    const run = await fx.store.runs.get("run_forever_stuck");
    expect(run?.status).toBe("failed");
    expect(run?.flag?.kind).toBe("reclaim_exhausted");
    // No longer claimable at all — a human must clear the flag (architecture §6.2/§13.3).
    await expect(fx.store.jobQueue.get("run_forever_stuck")).resolves.toBeUndefined();
  }, 15000);
});
