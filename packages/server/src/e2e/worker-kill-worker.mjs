#!/usr/bin/env node
// The mid-step worker-kill E2E test's WORKER PROCESS (S9 plan §4's
// unattempted item, S10 completion: "SIGKILL a real worker process DURING
// step execution (not at a wait boundary) and prove the lease-expiry ->
// reclaim-sweep -> bounded-retry machinery (architecture §4.7) recovers
// the run in a fresh process"). Same "must run as a genuinely separate OS
// process" rationale as redacted-legacy-b-worker.mjs (this same convention,
// scripts/smoke/*.mjs before it) — SIGKILL can only prove anything about
// durability if the thing being killed is a real, separate OS process, not
// vitest's own process.
//
// Distinct from redacted-legacy-b-worker.mjs in a load-bearing way:
// redacted-legacy-b's E2E kills a worker only ever at a WAIT boundary (after
// the run has already checkpointed to "waiting" and durably persisted —
// the kill happens to an otherwise-idle, hanging process). THIS script's
// whole point is to be killed WHILE ACTIVELY EXECUTING A STEP — proving
// the job_queue lease/reclaim machinery (architecture §4.7), which
// redacted-legacy-b's E2E never exercises at all (it drives engine.triggerRun/
// executeRun directly, never going through a real job_queue claim loop).
//
// Runs a REAL @aart/server startWorker (this package's own claim loop +
// admission control + lease heartbeat + health server) wired to a REAL
// createRealEngineBoundary (S10 completion — see boundary.ts's own doc
// comment for why this function didn't exist until this session) over a
// REAL @aart/engine Engine (real fs store, real @aart/governance
// redactRecord — not the identity stub, for authenticity).
import { createFsStore } from "@aart/store";
import { createEngine, alwaysAllowCapabilityCheck } from "@aart/engine";
import { redactRecord } from "@aart/governance";
import { startWorker, createRealEngineBoundary, systemClock } from "../../dist/index.js";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return args;
}

function emit(event) {
  // One JSON line per event on stdout, same convention as redacted-legacy-b-
  // worker.mjs — the test harness reads these to know exactly when a step
  // has GENUINELY started executing (not merely claimed), which is the
  // precise moment it's safe to SIGKILL for a real mid-step proof.
  process.stdout.write(JSON.stringify(event) + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  const root = args.root;
  if (!root) throw new Error("--root=<store path> is required");
  const workflowId = args.workflowId ?? "worker-kill-fixture";

  // Marker-file-based "have I run before" state — deliberately ON DISK, not
  // in-memory: this process may be SIGKILLed before it can persist
  // anything else, but the marker itself is written synchronously the
  // instant the slow step starts, before the long sleep — a completely
  // fresh process (a later invocation of this same script, or a real
  // retry) reads it back to know this is a RETRY of an interrupted attempt,
  // not the first attempt, and should complete fast instead of sleeping
  // again (real workflow/block code can't "remember" it was killed
  // mid-execution any other way — this fixture's whole job is to model
  // that a retried step re-runs from its own start, per the engine's own
  // step-level (not instruction-level) retry granularity).
  const marker = join(root, "slow-step-attempted.marker");

  const slowThenFastBlock = {
    manifest: { id: "test.slow-then-fast", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "Sleeps a long time on its first-ever invocation (long enough to be reliably SIGKILLed mid-sleep); on any later invocation (marker already present), completes immediately." },
    execute: async () => {
      if (existsSync(marker)) {
        emit({ event: "step-started", attempt: 2 });
        return { attempt: 2, resumedAfterKill: true };
      }
      writeFileSync(marker, String(Date.now()));
      emit({ event: "step-started", attempt: 1 });
      // Long enough that the test harness's SIGKILL (issued the instant it
      // reads the "step-started" event above) always lands well before
      // this resolves — this process is dead long before 30s elapses.
      await sleep(30_000);
      // Unreachable in the killed run — only reachable if the harness
      // somehow failed to kill this process, in which case a completing
      // step (with attempt: 1, no resumedAfterKill) would itself be
      // evidence the test's own kill-timing assumption broke, not a
      // silently-passing result.
      return { attempt: 1 };
    },
  };

  const store = createFsStore(root);
  const engine = createEngine({
    store,
    redact: redactRecord, // the real chokepoint, not the identity stub — authenticity, matching every other real-composition E2E in this repo
    capabilityCheck: alwaysAllowCapabilityCheck,
    blocks: { [slowThenFastBlock.manifest.id]: slowThenFastBlock },
    now: () => systemClock.now(),
  });
  const boundary = createRealEngineBoundary(store, engine);

  if (args.mode === "trigger") {
    const workflow = {
      id: workflowId,
      name: "Worker-kill fixture workflow",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "slow", uses: "test.slow-then-fast", with: {} }] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };
    await store.workflows.put(workflow);
    const result = await boundary.startRun({
      workflowId,
      trigger: { id: "e2e-trigger-1", type: "manual", source: "worker-kill.e2e.test", payload: null, receivedAt: new Date().toISOString() },
      mappedInputs: {},
    });
    emit({ event: "triggered", ...result });
    return;
  }

  if (args.mode === "worker") {
    // Short poll/lease durations, deliberately — this is a test, not
    // production: the whole point is a fast, deterministic real-wall-clock
    // proof, not a multi-minute wait. healthPort: 0 (OS-assigned free
    // port) so multiple sequential worker processes across this test never
    // collide with each other or with any other test's own worker.
    const handle = await startWorker({
      store,
      engine: boundary,
      workerId: args.workerId ?? "worker-kill-e2e-worker",
      maxConcurrentRuns: 1,
      claimPollMs: Number(args.claimPollMs ?? 150),
      leaseDurationMs: Number(args.leaseDurationMs ?? 2000),
      healthPort: 0,
      installSignalHandler: false, // this process is meant to be SIGKILLed by the test harness, not gracefully SIGTERMed
    });
    emit({ event: "worker-started", workerId: handle.workerId, healthPort: handle.healthPort });

    // Poll the run's own status and report completion — lets the test
    // harness know worker B (the fresh, post-reclaim process) actually
    // finished, without needing its own separate store handle race against
    // this process's writes.
    if (args.watchRunId) {
      const intervalMs = 100;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const run = await store.runs.get(args.watchRunId);
        if (run && (run.status === "completed" || run.status === "failed")) {
          emit({ event: "run-finished", runId: run.runId, status: run.status });
          break;
        }
        await sleep(intervalMs);
      }
    }

    // Deliberately never resolves on its own — same libuv-handle
    // requirement redacted-legacy-b-worker.mjs's hangForever() documents (a
    // bare unresolved Promise has no associated handle and would let Node
    // exit early); startWorker's own claim-poll timer + health server
    // already provide that, so this just needs to not return, which the
    // outer main().catch/never-return shape already achieves as long as we
    // don't call handle.stop() here — the test harness SIGKILLs this
    // process directly instead of ever reaching a graceful stop.
    await new Promise(() => {});
  }

  throw new Error(`Unknown --mode="${args.mode}" (expected "trigger" or "worker")`);
}

main().catch((err) => {
  emit({ event: "error", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exitCode = 1;
});
