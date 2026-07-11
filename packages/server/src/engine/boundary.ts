// The engine boundary — S2 codes against this documented interface plus a
// fake implementation, per this session's own brief: "Where you need S1's
// engine as a library (running claimed runs), code against the frozen
// types and a stub/fake engine boundary exactly as your plan section
// describes — real integration is the S9 merge's job (merge order S1 → S2
// is already fixed)."
//
// This is NOT a frozen S0 interface (only @aart/types/@aart/expr/@aart/store
// are) — it is this session's own best-effort documentation of the shape
// implementation plan §3 describes S1 as owning ("trigger adapters call
// into the engine's run-intake function," "S1 exports getDueWaits(now)...
// S2's ticker loop calls that export"), built so every other file in this
// package (trigger intake, the scheduler ticker, the worker claim loop) has
// something concrete to call today. SEAMS.md records this shape so S1 (or
// S9, doing the merge) can converge it with the real engine's actual export
// shape — see this task's final report for the explicit list of what S9
// must reconcile.
import type { RunRecord, Signal, Trigger, WaitCondition } from "@aart/types";
import { ConcurrencyRejectedError, CorrelationError } from "@aart/types";
import type { AartStore } from "@aart/store";
import type { Engine } from "@aart/engine";
import type { Clock } from "../clock.js";
import { generateId } from "../ids.js";

export interface StartRunParams {
  workflowId: string;
  /** Omit to resolve the workflow's latest known version (architecture §5.3's `workflows.getLatest`) — this is what a trigger with no pinned version (most triggers) resolves against; `Deployment.workflowVersion` (architecture ADR-06) is what a deployment-routed trigger pins instead. */
  workflowVersion?: string;
  trigger: Trigger;
  /** Already resolved against the workflow's declared `inputs: Field[]` (architecture §6.2) — trigger intake's job, not the engine boundary's. */
  mappedInputs: Record<string, unknown>;
  /** Set by trigger intake when the delivery is a `dryRun`-style test (unused by the fake; real engine wires this to `RunRecord.params.dryRun`, architecture §9.5). */
  dryRun?: boolean;
  /** AMENDMENTS.md A47: threaded straight through to `Engine.triggerRun`'s own `environment` (`@aart/engine`'s `TriggerRunInput.environment` — capability grants are resolved per-environment on every step dispatch, ADR-06). Optional, unset by every pre-A47 caller (trigger intake never set this) — added for the dashboard's "trigger workflow" action (§35.2), whose form has always had an optional Environment field. */
  environment?: string;
}

export type StartRunResult =
  | { kind: "started"; runId: string }
  | { kind: "queued"; runId: string }
  | { kind: "rejected"; reason: string };

export type ResumeResult = { kind: "resumed"; runId: string } | { kind: "duplicate"; runId: string } | { kind: "no_match" } | { kind: "ambiguous"; matches: number };

/**
 * What S2 needs FROM the engine (architecture §6's "trigger adapters call
 * into the engine's run-intake function, but S2 doesn't reimplement any
 * engine logic" + §4.4.3/§4.7's ticker/claim seams). S1's real
 * implementation additionally enforces the concurrency-policy check
 * (architecture §4.3) inside `startRun` — this boundary's fake below
 * approximates that so S2's own trigger-intake tests can exercise the
 * queue/cancel_existing/reject_new/allow paths against *something*, but
 * the authoritative implementation is S1's.
 */
export interface EngineBoundary {
  startRun(params: StartRunParams): Promise<StartRunResult>;
  resumeWithSignal(signal: Signal): Promise<ResumeResult>;
  resumeDirect(runId: string, stepId: string, payload: unknown): Promise<ResumeResult>;
  /** The seam architecture §4.4.3 names explicitly: "S1 exports getDueWaits(now)... S2's ticker loop calls that export." Re-exposed here so every call site in this package goes through one injectable boundary rather than half importing this and half importing `store.waits.listDue` directly. */
  getDueWaits(now: string): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition }>>;
  /** Claims (if not already claimed elsewhere) and executes `runId` to its next checkpoint. Used by the worker claim loop (worker/claim.ts) once admission control + the race-safe `job_queue` claim (this package's own job, architecture §4.7) has already won the claim — this call is what actually runs engine step logic against it. */
  executeClaimedRun(runId: string, workerId: string): Promise<void>;
}

/**
 * A minimal, honest fake: real `RunRecord`/`job_queue` writes (so trigger-
 * intake/ticker/worker tests observe genuine store state, not a mock's
 * recorded-calls list), but NO step execution, NO wait/resume machine, NO
 * capability dispatch — none of that is S2's to reimplement. `executeClaimedRun`
 * here just flips a claimed `pending`→`running` run straight to `completed`
 * with an empty trace, which is enough for worker/ticker tests to assert
 * "the claim loop claimed it and the engine boundary was invoked," without
 * pretending to validate S1's actual step-executor correctness (that's S1's
 * own test suite's job, and S9's integration pass).
 */
export function createFakeEngine(store: AartStore, clock: Clock): EngineBoundary {
  return {
    async startRun(params: StartRunParams): Promise<StartRunResult> {
      const runId = generateId("run");
      const run: RunRecord = {
        runId,
        workflowId: params.workflowId,
        workflowVersion: params.workflowVersion ?? "0.0.0",
        status: "pending",
        approved: true,
        approvalMode: "dev",
        trigger: params.trigger,
        inputs: params.mappedInputs,
        params: params.dryRun ? { dryRun: true } : undefined,
        trace: [],
        waits: [],
        artifacts: [],
        snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: clock.nowIso() },
        startedAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
        schemaVersion: 1,
      };
      await store.runs.put(run);
      await store.jobQueue.enqueue(runId);
      return { kind: "started", runId };
    },

    async resumeWithSignal(signal: Signal): Promise<ResumeResult> {
      const waits = await store.waits.list();
      const matches = waits.filter((w) => {
        if (w.wait.type === "signal" || w.wait.type === "webhook") return w.wait.correlationId === signal.correlationId;
        if (w.wait.type === "queue") return w.wait.correlationId === signal.correlationId;
        return false;
      });
      if (matches.length === 0) return { kind: "no_match" };
      if (matches.length > 1) return { kind: "ambiguous", matches: matches.length };
      const match = matches[0]!;
      const dedupeKey = `${signal.name}:${signal.correlationId}`;
      return store.transact(async (tx) => {
        if (await tx.runs.hasDedupeKey(match.runId, dedupeKey)) {
          return { kind: "duplicate", runId: match.runId };
        }
        await tx.runs.recordDedupeKey(match.runId, dedupeKey);
        const run = await tx.runs.get(match.runId);
        if (run) await tx.runs.put({ ...run, status: "running", updatedAt: clock.nowIso() });
        await tx.waits.delete(match.runId, match.stepId);
        return { kind: "resumed", runId: match.runId };
      });
    },

    async resumeDirect(runId: string, stepId: string, _payload: unknown): Promise<ResumeResult> {
      const dedupeKey = `manual:${stepId}`;
      return store.transact(async (tx) => {
        if (await tx.runs.hasDedupeKey(runId, dedupeKey)) {
          return { kind: "duplicate", runId };
        }
        await tx.runs.recordDedupeKey(runId, dedupeKey);
        const run = await tx.runs.get(runId);
        if (run) await tx.runs.put({ ...run, status: "running", updatedAt: clock.nowIso() });
        await tx.waits.delete(runId, stepId);
        return { kind: "resumed", runId };
      });
    },

    async getDueWaits(now: string) {
      return store.waits.listDue(now);
    },

    async executeClaimedRun(runId: string): Promise<void> {
      const run = await store.runs.get(runId);
      if (!run) return;
      await store.runs.put({ ...run, status: "completed", updatedAt: clock.nowIso(), endedAt: clock.nowIso() });
      await store.jobQueue.remove(runId);
    },
  };
}

/**
 * The REAL `EngineBoundary` — thin adapter over an already-constructed real
 * `@aart/engine` `Engine` (S9 integration gap closed, S10 completion:
 * `packages/mcp/src/real-context.ts`'s own module comment has claimed since
 * S9 that "ServerPort <- ... via a real EngineBoundary adapter... this
 * package's createRealEngineBoundary" — but no such function existed
 * anywhere in this repo, and `packages/cli/src/cli-context.ts` unconditionally
 * used `createStubServerPort` regardless of anything else being wired for
 * real. This is that function, finally landed — `aart worker`/`aart server`
 * were, until this fix, complete no-ops in the actually-shipping CLI (see
 * `stubs/server.ts`'s own `startWorker`: `return { async stop() {} }`,
 * literally does nothing) despite the underlying worker/claim/lease/reclaim
 * machinery in this SAME package (worker.ts/claim.ts/reclaim.ts/lease.ts)
 * being fully real and complete — this was purely a wiring gap, not a
 * missing-machinery gap. See root AMENDMENTS.md, S10 completion, for the
 * full write-up.
 *
 * Every method here is a direct pass-through to the equivalent bound
 * `Engine` method (constructed via `@aart/engine`'s `createEngine`, the
 * SAME composition every other real consumer — `@aart/mcp`'s real-context.ts
 * — already uses) — this package (`@aart/server`) owns admission control
 * (`startWorker`'s `maxConcurrentRuns`), the race-safe `job_queue` claim
 * (`claim.ts`), lease renewal (`lease.ts`), and the reclaim sweep
 * (`reclaim.ts`); it does not reimplement engine logic, exactly as this
 * interface's own doc comment on `EngineBoundary` already specified.
 */
export function createRealEngineBoundary(store: AartStore, engine: Engine): EngineBoundary {
  function mapResumeOutcome(outcome: Awaited<ReturnType<Engine["resumeBySignal"]>>): ResumeResult {
    if (outcome.kind === "resumed") return { kind: "resumed", runId: outcome.run.runId };
    if (outcome.kind === "duplicate") {
      // ResumeOutcome's "duplicate" carries no runId (architecture §4.4.2's
      // dedupe check happens before the run is even loaded) — ResumeResult
      // requires one. Not reachable from resumeWithSignal/resumeDirect's
      // real call sites below without a runId already in hand (the
      // dedupe key itself is scoped to a specific run+step), so this is a
      // defensive fallback, not an expected path.
      return { kind: "duplicate", runId: "" };
    }
    return { kind: "no_match" };
  }

  return {
    async startRun(params: StartRunParams): Promise<StartRunResult> {
      const workflow = params.workflowVersion
        ? await store.workflows.get(params.workflowId, params.workflowVersion)
        : await store.workflows.getLatest(params.workflowId);
      if (!workflow) {
        return { kind: "rejected", reason: `Workflow "${params.workflowId}"${params.workflowVersion ? `@${params.workflowVersion}` : ""} not found.` };
      }
      try {
        const run = await engine.triggerRun({
          workflow,
          trigger: params.trigger,
          inputs: params.mappedInputs,
          ...(params.dryRun ? { params: { dryRun: true } } : {}),
          ...(params.environment ? { environment: params.environment } : {}),
        });
        // run-lifecycle.ts's triggerRun stashes waitingOnConcurrency in the
        // free-form params bag (its own `[DECISION]` comment) rather than a
        // dedicated RunRecord field — this is the one place outside that
        // file that needs to read it back, to distinguish "genuinely
        // started" from "queued behind a blocking run under a queue
        // ConcurrencyPolicy" for this boundary's own StartRunResult.
        const queued = (run.params as Record<string, unknown> | undefined)?.["waitingOnConcurrency"] === true;
        return { kind: queued ? "queued" : "started", runId: run.runId };
      } catch (err) {
        if (err instanceof ConcurrencyRejectedError) {
          return { kind: "rejected", reason: err.message };
        }
        throw err;
      }
    },

    async resumeWithSignal(signal: Signal): Promise<ResumeResult> {
      try {
        return mapResumeOutcome(await engine.resumeBySignal(signal));
      } catch (err) {
        // wait-machine.ts's resumeBySignal signals ">1 outstanding wait
        // matched this correlationId" via a THROWN CorrelationError (detail
        // .matches), not a return-value kind — ResumeResult's own
        // "ambiguous" kind (matching this boundary's pre-existing fake)
        // needs the count, which the error's own detail carries.
        if (err instanceof CorrelationError && err.detail?.["kind"] === "multipleWaitMatches") {
          const matches = err.detail["matches"];
          return { kind: "ambiguous", matches: Array.isArray(matches) ? matches.length : 2 };
        }
        throw err;
      }
    },

    async resumeDirect(runId: string, stepId: string, payload: unknown): Promise<ResumeResult> {
      const outcome = await engine.resumeManual(runId, stepId, payload);
      if (outcome.kind === "resumed") return { kind: "resumed", runId: outcome.run.runId };
      if (outcome.kind === "duplicate") return { kind: "duplicate", runId };
      return { kind: "no_match" };
    },

    async getDueWaits(now: string) {
      return engine.getDueWaits(new Date(now));
    },

    async executeClaimedRun(runId: string): Promise<void> {
      // The worker's own claim/lease is already held by the time this is
      // called (worker/claim.ts, BEFORE this boundary method is invoked) —
      // engine.executeRun is exactly "what a worker calls after claiming a
      // run from job_queue" per that method's own doc comment (engine.ts).
      // Releasing/removing the job_queue entry on normal completion is
      // engine-internal (run-lifecycle.ts's finalization path already does
      // this); worker.ts's own executeOneClaim has a best-effort release
      // backstop for the checkpoint case, and deliberately does NOT release
      // on a thrown error (leaves the lease for reclaim.ts to expire and
      // sweep — architecture §4.7, this session's own worker-kill E2E
      // proof).
      await engine.executeRun(runId);
    },
  };
}
