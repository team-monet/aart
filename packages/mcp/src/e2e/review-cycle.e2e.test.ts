// The review-cycle flagship-workflow E2E test — the single most important
// E2E test in this package, because it's the concrete proof that ADR-02's
// durability claim holds under conditions that actually matter. The test
// harness must genuinely kill and restart the worker process (not just
// reload an in-memory store handle) between at least one wait and its
// resume, to prove the full stack (not just the engine package in
// isolation) survives a real restart.
//
// This spawns review-cycle-worker.mjs (this same directory) as a REAL,
// SEPARATE OS PROCESS via node:child_process — not an in-process function
// call, and not vitest's own worker pool (which would still be one
// logical test-runner process; killing IT would kill the test observing
// it). SIGKILL is used specifically (not SIGTERM) because it gives the
// target process zero opportunity to run any shutdown/flush code — the
// only way durability can hold under a SIGKILL is if the wait was
// ALREADY fully persisted to the on-disk store before the kill, by
// executeRun/resumeApproval's own normal completion, not by any exit
// handler. Done TWICE in this test (at wait #1 and wait #2) — going
// beyond the "at least one" bar since the mechanics, once built, cost
// little extra to repeat and materially strengthen the evidence.
//
// Deliberately industry-neutral (AMENDMENTS.md A70): this file and its
// fixture workflow replace a former test/fixture pair that carried a
// specific customer/domain narrative, removed from the product
// (2026-07-14, zero customer/domain-specific content). Every assertion
// below is preserved from that file; only naming/vocabulary and the
// fixture's location changed (moved into this package's own
// `src/e2e/fixtures/`, no longer read from a repo-root `examples/` dir).
// See this session's AMENDMENTS.md A70 entry for the full before/after
// coverage mapping.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFsStore } from "@aart/store";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, "review-cycle-worker.mjs");
const WORKFLOW_JSON = join(__dirname, "fixtures/review-cycle.workflow.json");

interface WorkerEvent {
  event: string;
  [key: string]: unknown;
}

/** Spawns the worker script as a genuinely separate OS process, parsing each stdout line as a JSON event. */
function spawnWorker(args: string[]): { child: ReturnType<typeof spawn>; events: Promise<WorkerEvent>[]; nextEvent: () => Promise<WorkerEvent>; stderr: () => string } {
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

  return { child, events: [], nextEvent, stderr: () => stderrBuf };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** Node's own "is this pid alive" primitive (kill with signal 0 sends no signal, just checks existence/permission) — used as a second, independent confirmation alongside the exit-event check. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("review-cycle flagship workflow — real process kill + restart across multiple waits", () => {
  it(
    "survives two genuine SIGKILLs mid-run, resumed each time by a completely fresh OS process reading only the on-disk store, and completes the full 10-step flow correctly",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "aart-e2e-review-cycle-"));
      roots.push(root);

      // --- Process A: trigger the run, run to WAIT #1 (review_fields), hang. ---
      const a = spawnWorker(["--mode=trigger", `--root=${root}`, `--workflow=${WORKFLOW_JSON}`, "--recordId=record-42", "--documentText=Record code: 63051234567, Total amount: 184.20, Quantity: 612"]);
      const resultA = await a.nextEvent();
      expect(resultA).toMatchObject({ event: "result", status: "waiting", stepId: "review_fields" });
      const runId = resultA["runId"] as string;
      expect(runId).toBeTruthy();

      // Confirm process A is a genuinely still-running, independent OS
      // process before killing it - not a process that already exited
      // naturally (which would make the "kill" meaningless).
      expect(a.child.pid).toBeDefined();
      expect(isProcessAlive(a.child.pid!)).toBe(true);

      // --- Genuine SIGKILL #1 - zero chance for any shutdown/flush code to run. ---
      a.child.kill("SIGKILL");
      const exitA = await waitForExit(a.child);
      expect(exitA.signal).toBe("SIGKILL");
      expect(isProcessAlive(a.child.pid!)).toBe(false);

      // --- Process B: a COMPLETELY FRESH process (new PID, empty memory, no
      // handle to anything process A held) - resumes purely from the
      // on-disk store at `root`. ---
      const b = spawnWorker(["--mode=resume", `--root=${root}`, `--runId=${runId}`, "--stepId=review_fields", "--decision=approved", "--hang=true"]);
      const resultB = await b.nextEvent();
      expect(resultB).toMatchObject({ event: "result", status: "waiting", stepId: "approve_summary" });
      expect(b.child.pid).not.toBe(a.child.pid);
      expect(isProcessAlive(b.child.pid!)).toBe(true);

      // --- Genuine SIGKILL #2, at the SECOND wait - proves this isn't a
      // one-off, and that a run resumed once still durably persists its
      // NEW wait state too, surviving yet another hard kill. ---
      b.child.kill("SIGKILL");
      const exitB = await waitForExit(b.child);
      expect(exitB.signal).toBe("SIGKILL");

      // --- Process C: another completely fresh process, resumes the SECOND
      // wait, runs through export_report/compute_next_window, and reaches
      // the guarded-loop's timer wait (recheck_wait). ---
      const c = spawnWorker(["--mode=resume", `--root=${root}`, `--runId=${runId}`, "--stepId=approve_summary", "--decision=approved", "--hang=false"]);
      const resultC = await c.nextEvent();
      expect(resultC).toMatchObject({ event: "result", status: "waiting", stepId: "recheck_wait" });
      const exitC = await waitForExit(c.child);
      expect(exitC.code).toBe(0); // clean, non-hanging exit (--hang=false)

      // --- Final verification: read the ON-DISK STORE DIRECTLY (this test
      // process's own store handle, a FOURTH, independent reader) - the
      // full 10-step trace executed in order, and the guarded-loop's timer
      // wait carries the correctly-computed resumeAt (nextReviewDate - 120
      // days), proving the extracted record's nextReviewDate genuinely
      // flowed through parse -> llm.extract -> ... -> compute_next_window
      // across all three process boundaries, not just that each hop
      // returned SOME status. ---
      const store = createFsStore(root);
      const finalRun = await store.runs.get(runId);
      expect(finalRun?.status).toBe("waiting");
      const stepOrder = finalRun!.trace.map((t) => t.stepId);
      expect(stepOrder).toEqual([
        "parse_document",
        "extract_fields",
        "validate_fields",
        "review_fields",
        "run_scoring",
        "render_summary",
        "approve_summary",
        "export_report",
        "compute_next_window",
        "recheck_wait",
      ]);
      const recheckWaitTrace = finalRun!.trace.find((t) => t.stepId === "recheck_wait");
      expect(recheckWaitTrace?.status).toBe("waiting");
      expect(finalRun!.trace.filter((t) => t.stepId !== "recheck_wait").every((t) => t.status === "completed")).toBe(true);

      const wait = await store.waits.get(runId, "recheck_wait");
      expect(wait?.type).toBe("timer");
      const resumeAtMs = new Date((wait as { resumeAt: string }).resumeAt).getTime();
      const daysFromNow = (resumeAtMs - Date.now()) / (1000 * 60 * 60 * 24);
      // The fake LLM client's nextReviewDate is ~200 days out; 200 - 120 = ~80.
      // A generous band (60-100 days) absorbs test-run wall-clock drift
      // without being so wide it'd pass for a badly-wrong computation.
      expect(daysFromNow).toBeGreaterThan(60);
      expect(daysFromNow).toBeLessThan(100);

      // The extracted (faked-LLM) fields and the scoring/summary fixture
      // outputs are visible on their own trace entries - spot-check one of
      // each to confirm the whole chain's DATA (not just control flow) is
      // real and connected.
      const extractTrace = finalRun!.trace.find((t) => t.stepId === "extract_fields");
      expect(extractTrace?.outputs).toMatchObject({ recordCode: "63051234567", totalAmount: 184.2 });
      const scoringTrace = finalRun!.trace.find((t) => t.stepId === "run_scoring");
      expect(scoringTrace?.outputs).toMatchObject({ recordId: "record-42" });
    },
    30_000,
  );
});
