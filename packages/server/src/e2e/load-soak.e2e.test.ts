// Load/soak sanity E2E (S9 plan §4's unattempted item, S10 completion):
// "N concurrent runs through a worker with maxConcurrentRuns enforced;
// assert no handle/memory growth 'in an obviously alarming way' (the
// plan's own bar) and admission control actually queueing."
//
// Deliberately IN-PROCESS, unlike worker-kill/review-cycle's own E2E
// tests — those need a genuinely separate OS process specifically because
// their whole point is surviving a SIGKILL of that process. This test's
// concern is different: observing the WORKER's own memory/handle behavior
// under sustained load, which is more direct and more meaningful to
// measure from inside the same process actually doing the work (querying
// a child process's memory over IPC would be an extra layer of
// indirection buying nothing here) — a real @aart/server startWorker, a
// real createRealEngineBoundary/Engine, a real fs-backed store, all in
// this test's own process.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsStore } from "@aart/store";
import { createEngine, identityRedactFn, alwaysAllowCapabilityCheck } from "@aart/engine";
import type { BlockImplementation, Workflow } from "@aart/types";
import { startWorker, createRealEngineBoundary } from "../index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("load/soak sanity E2E — N concurrent runs, real admission control, no alarming memory growth", () => {
  it(
    "20 runs through a real worker with maxConcurrentRuns: 3 — admission control genuinely caps concurrency (never exceeded, genuinely reached, genuinely queues the rest), all 20 complete, memory doesn't balloon",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "aart-e2e-load-soak-"));
      roots.push(root);
      const store = createFsStore(root);

      const RUN_COUNT = 20;
      const MAX_CONCURRENT = 3;

      // A short, real async delay (not instant) — long enough that
      // multiple runs are GENUINELY in flight at once (making admission
      // control's cap observable at all; an instant block would complete
      // before the next claim tick ever saw more than one claimed run),
      // short enough that 20 of them stay a fast test.
      const delayedEchoBlock: BlockImplementation = {
        manifest: { id: "test.delayed-echo", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "echoes after a short real delay" },
        execute: async (input) => {
          await sleep(80);
          return { echoed: input };
        },
      };

      const engine = createEngine({
        store,
        redact: identityRedactFn,
        capabilityCheck: alwaysAllowCapabilityCheck,
        blocks: { [delayedEchoBlock.manifest.id]: delayedEchoBlock },
      });
      const boundary = createRealEngineBoundary(store, engine);

      const workflow: Workflow = {
        id: "load-soak-fixture",
        name: "Load/soak fixture workflow",
        version: "0.1.0",
        inputs: [],
        outputs: [],
        execution: { type: "workflow", steps: [{ id: "s1", uses: "test.delayed-echo", with: {} }] },
        approval: "approved",
        gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
      };
      await store.workflows.put(workflow);

      // Trigger all 20 up front — startRun only enqueues (architecture's
      // trigger/execute decoupling, confirmed in A37's own investigation),
      // so this is fast and leaves all 20 genuinely queued in job_queue
      // BEFORE the worker below claims anything, the real shape a burst of
      // real trigger traffic would produce.
      const runIds: string[] = [];
      for (let i = 0; i < RUN_COUNT; i++) {
        const result = await boundary.startRun({
          workflowId: workflow.id,
          trigger: { id: `e2e-trigger-${i}`, type: "manual", source: "load-soak.e2e.test", payload: null, receivedAt: new Date().toISOString() },
          mappedInputs: { i },
        });
        expect(result.kind).toBe("started");
        runIds.push((result as { runId: string }).runId);
      }

      const memBefore = process.memoryUsage();

      const handle = await startWorker({
        store,
        engine: boundary,
        workerId: "load-soak-worker",
        maxConcurrentRuns: MAX_CONCURRENT,
        claimPollMs: 20,
        healthPort: 0,
        installSignalHandler: false,
      });

      // Poll claimedRunIds.size throughout the whole run, tracking the
      // maximum observed — this is what proves admission control is
      // GENUINELY capping concurrency (never exceeded) and GENUINELY
      // reaching the cap (not just "happens to stay under it because
      // nothing contends") - 20 runs through a cap of 3 with a real 80ms
      // delay each should reach exactly 3 in flight repeatedly.
      let maxConcurrentObserved = 0;
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        maxConcurrentObserved = Math.max(maxConcurrentObserved, handle.claimedRunIds.size);
        // Never once exceeded the configured cap, checked on every poll,
        // not just at the end - the invariant must hold continuously.
        expect(handle.claimedRunIds.size).toBeLessThanOrEqual(MAX_CONCURRENT);

        const statuses = await Promise.all(runIds.map((id) => store.runs.get(id)));
        const allTerminal = statuses.every((r) => r?.status === "completed" || r?.status === "failed");
        if (allTerminal) break;
        // Deliberately not too tight a poll - real fs-adapter I/O (this
        // loop's own 20 store.runs.get calls, every iteration, alongside
        // the worker's own real claim/persist I/O against the same
        // on-disk store) is real disk work, not free; polling too
        // aggressively adds self-inflicted contention on top of the very
        // thing being measured.
        await sleep(50);
      }

      await handle.stop();

      const memAfter = process.memoryUsage();

      // --- Admission control genuinely reached and enforced its cap. ---
      expect(maxConcurrentObserved).toBe(MAX_CONCURRENT);

      // --- All 20 runs genuinely completed (not silently dropped, not
      // stuck queued forever behind the cap). ---
      const finalRuns = await Promise.all(runIds.map((id) => store.runs.get(id)));
      for (const run of finalRuns) {
        expect(run?.status).toBe("completed");
        expect(run?.trace).toHaveLength(1);
        expect(run?.trace[0]?.status).toBe("completed");
      }

      // --- No handle/memory growth "in an obviously alarming way" (the
      // plan's own, deliberately loose bar — this is a sanity check, not a
      // precision leak detector: heap growth across a single vitest test
      // is inherently noisy, GC-timing-dependent, and this run allocated
      // 20 real RunRecords/StepTraces/job_queue entries on a real fs
      // store, which legitimately costs SOME memory). A 3x heap-used
      // growth ceiling and an absolute 150MB ceiling would both have to be
      // blown through for this to fail - either one alone catches a
      // genuine "grew without bound" shape; both together avoid flagging
      // ordinary, expected allocation for 20 real runs. ---
      const heapGrowthFactor = memAfter.heapUsed / Math.max(memBefore.heapUsed, 1);
      const heapGrowthAbsoluteMb = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
      expect(heapGrowthFactor).toBeLessThan(3);
      expect(heapGrowthAbsoluteMb).toBeLessThan(150);
    },
    60_000,
  );
});
