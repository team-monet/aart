// Mid-step worker-kill E2E (S9 plan §4's unattempted item, S10 completion).
// The review-cycle E2E (packages/mcp/src/e2e/review-cycle.e2e.test.ts)
// already proves a real worker process survives a SIGKILL issued while
// HANGING AT A WAIT boundary (the run already checkpointed to "waiting"
// and durably persisted before the kill). THIS test is the first real-
// process proof of the DIFFERENT machinery architecture §4.7 actually
// exists for: a worker killed WHILE ACTIVELY EXECUTING A STEP (mid-
// dispatch, nothing yet persisted for this attempt) — job_queue's
// lease/reclaim mechanism, never exercised by review-cycle's E2E (which
// drives engine.triggerRun/executeRun directly, bypassing job_queue's
// claim loop entirely).
//
// Real SIGKILL (zero shutdown-code opportunity), a real @aart/server
// startWorker process, a real createRealEngineBoundary/Engine, and the
// real runReclaimSweep function — every piece genuinely real, nothing
// simulated. See worker-kill-worker.mjs (this same directory) for the
// worker process itself.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFsStore } from "@aart/store";
import { runReclaimSweep, systemClock, createServerLogger } from "../index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, "worker-kill-worker.mjs");

interface WorkerEvent {
  event: string;
  [key: string]: unknown;
}

function spawnScript(args: string[]): { child: ReturnType<typeof spawn>; nextEvent: () => Promise<WorkerEvent>; stderr: () => string } {
  const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const pending: Array<(event: WorkerEvent) => void> = [];
  const queue: WorkerEvent[] = [];
  let stderrBuf = "";
  let stdoutBuf = "";

  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as WorkerEvent;
      const waiter = pending.shift();
      if (waiter) waiter(parsed);
      else queue.push(parsed);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  function nextEvent(): Promise<WorkerEvent> {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => pending.push(resolve));
  }

  return { child, nextEvent, stderr: () => stderrBuf };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * worker.ts's own executeOneClaim continues running AFTER a run's status
 * flips to "completed" in the store (logging, maybeFlagPoison's own store
 * read, THEN the job_queue.release backstop) — a watcher that reports
 * "run-finished" the instant it observes status: completed can genuinely
 * win a race against that trailing work still being in flight. Polls
 * rather than asserting a single point-in-time read, same principle as
 * this file's own store-durability checks elsewhere.
 */
async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await sleep(50);
  }
}

const roots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (isProcessAlive(child.pid!)) child.kill("SIGKILL");
  }
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("worker-kill E2E — SIGKILL a real worker process DURING step execution, real lease-expiry -> reclaim-sweep -> fresh-process recovery (architecture §4.7)", () => {
  it(
    "a run killed mid-step is recovered: lease genuinely expires, the real reclaim sweep requeues it, and a completely fresh worker process claims and completes it",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "aart-e2e-worker-kill-"));
      roots.push(root);
      const LEASE_DURATION_MS = 1500;

      // --- Step 1: trigger the run (enqueues into job_queue; does NOT execute it — startRun's job is intake only). ---
      const trigger = spawnScript(["--mode=trigger", `--root=${root}`]);
      const triggered = await trigger.nextEvent();
      expect(triggered).toMatchObject({ event: "triggered", kind: "started" });
      const runId = triggered["runId"] as string;
      expect(runId).toBeTruthy();
      await waitForExit(trigger.child); // the trigger-mode script exits on its own once done

      // --- Step 2: spawn worker process A - a REAL, SEPARATE OS process running @aart/server's real claim loop. ---
      const a = spawnScript(["--mode=worker", `--root=${root}`, `--workerId=worker-A`, `--leaseDurationMs=${LEASE_DURATION_MS}`, "--claimPollMs=100"]);
      children.push(a.child);
      const started = await a.nextEvent();
      expect(started).toMatchObject({ event: "worker-started" });

      // --- Step 3: wait for the block's OWN "step-started" event - the precise moment it is GENUINELY mid-execution (past claim, past dispatch, INSIDE the block's own execute()), not merely claimed. ---
      const stepStarted = await a.nextEvent();
      expect(stepStarted).toMatchObject({ event: "step-started", attempt: 1 });

      // Confirm process A is a real, still-running, independent OS process
      // before killing it (same discipline as review-cycle.e2e.test.ts).
      expect(a.child.pid).toBeDefined();
      expect(isProcessAlive(a.child.pid!)).toBe(true);

      // --- Step 4: genuine SIGKILL, mid-sleep, inside the block's own execute() - zero chance for any cleanup/release code to run. ---
      a.child.kill("SIGKILL");
      const exitA = await waitForExit(a.child);
      expect(exitA.signal).toBe("SIGKILL");
      expect(isProcessAlive(a.child.pid!)).toBe(false);

      // --- Step 5: verify the kill genuinely left the claim in place (worker.ts's own documented behavior: a thrown/killed execution does NOT release the job_queue claim - releasing immediately would bypass the bounded reclaim mechanism entirely). ---
      const store = createFsStore(root);
      const claimedEntry = await store.jobQueue.get(runId);
      expect(claimedEntry?.claimedBy).toBe("worker-A");
      expect(claimedEntry?.reclaimCount ?? 0).toBe(0);
      // The run's own persisted state shows NO trace entry for the killed
      // step - it died before dispatchOnce ever returned, so
      // appendTracesAndPersist never ran for this attempt. This is the
      // concrete evidence "mid-step" really means mid-step, not "between
      // steps": a wait-boundary kill (review-cycle's E2E) always leaves a
      // fully-persisted checkpoint; this kill leaves NOTHING for the step
      // that was actually running.
      const runAfterKill = await store.runs.get(runId);
      expect(runAfterKill?.trace).toEqual([]);
      expect(runAfterKill?.status).toBe("running");

      // --- Step 6: the lease has NOT yet expired (kill was immediate, well inside the lease window) - the claim is genuinely still "held" by a dead process, exactly the state architecture §4.7 exists for. ---
      expect(new Date(claimedEntry!.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());

      // --- Step 7: wait for the lease to genuinely expire in real wall-clock time (no mocked clock - this is what "real" means here), then run the REAL reclaim sweep (architecture §4.7 - normally invoked from the scheduler ticker; the sweep function itself doesn't need to run inside any particular process to be real, only the KILL and the RECOVERY do). ---
      await sleep(LEASE_DURATION_MS + 500);
      const logger = createServerLogger();
      const sweepResult = await runReclaimSweep(store, systemClock, logger);
      expect(sweepResult.requeued).toEqual([runId]);
      expect(sweepResult.exhausted).toEqual([]);

      // Confirm the sweep genuinely released the claim (requeued, reclaimCount incremented) rather than merely reporting it would.
      const releasedEntry = await store.jobQueue.get(runId);
      expect(releasedEntry?.claimedBy).toBeNull();
      expect(releasedEntry?.reclaimCount).toBe(1);

      // --- Step 8: spawn worker process B - a COMPLETELY FRESH process (new PID, empty memory, no handle to anything process A held) - claims the now-requeued job and completes it. ---
      const b = spawnScript(["--mode=worker", `--root=${root}`, `--workerId=worker-B`, `--leaseDurationMs=${LEASE_DURATION_MS}`, "--claimPollMs=100", `--watchRunId=${runId}`]);
      children.push(b.child);
      const bStarted = await b.nextEvent();
      expect(bStarted).toMatchObject({ event: "worker-started" });
      expect(b.child.pid).not.toBe(a.child.pid);

      // The retried attempt's own "step-started" event proves the SAME
      // step genuinely re-ran from its own start (attempt: 2, per the
      // marker-file fixture) - a fresh process, a fresh claim, and the
      // step executing again, not some other recovery shortcut.
      const stepStartedAgain = await b.nextEvent();
      expect(stepStartedAgain).toMatchObject({ event: "step-started", attempt: 2 });

      const runFinished = await b.nextEvent();
      expect(runFinished).toMatchObject({ event: "run-finished", runId, status: "completed" });

      // --- Step 9: final verification - read the on-disk store directly (a THIRD, independent reader, same discipline as review-cycle.e2e.test.ts's own final check). ---
      const finalRun = await store.runs.get(runId);
      expect(finalRun?.status).toBe("completed");
      expect(finalRun?.trace).toHaveLength(1);
      expect(finalRun?.trace[0]).toMatchObject({ stepId: "slow", status: "completed", outputs: { attempt: 2, resumedAfterKill: true } });

      // worker.ts's own executeOneClaim backstop REMOVES the job_queue
      // entry entirely on a normal completion (root AMENDMENTS.md — a real
      // bug found by the load/soak E2E: this used to RELEASE, not remove,
      // which left a claimedBy: null row indistinguishable from "never
      // claimed" to listClaimable — an already-finished run stayed
      // claimable forever, worker.ts's earlier version endlessly
      // reclaiming and re-no-op-executing it. Fixed to remove(); this
      // test's own final assertion updated to match the corrected, now-
      // genuinely-correct behavior). Polled, not a single read:
      // executeOneClaim keeps running (maybeFlagPoison's own store read,
      // then this remove call) for a moment after the run's own status
      // already flipped to "completed" — see waitFor's own comment.
      const finalJobQueueEntry = await waitFor(async () => {
        const entry = await store.jobQueue.get(runId);
        return entry === undefined ? { gone: true } : undefined;
      }, 5_000);
      expect(finalJobQueueEntry).toEqual({ gone: true });
      expect(await store.jobQueue.get(runId)).toBeUndefined();
    },
    30_000,
  );
});
