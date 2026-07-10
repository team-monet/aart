// The wait/resume machine (architecture §4.4) — the durable-execution core.
// Implements the full lifecycle: enterWait (persist-with-early-arrival-check,
// architecture §4.4 step 3) and all three consolidated resume mechanisms
// (§4.4.1: signal-matched / scheduler-tick / direct-lookup), each going
// through the SAME atomic claim-and-transition primitive (§4.4.2's
// "scope of the atomic-claim rule — all three mechanisms, not just
// signal-matched").
import type { AartStore } from "@aart/store";
import type { RunRecord, Signal, StepTrace, WaitCondition } from "@aart/types";
import { CorrelationError } from "@aart/types";
import { parseDurationMs } from "../duration.js";
import { applyRedaction } from "../redaction.js";
import { assertSchemaVersionCompatible } from "../schema-version.js";
import type { DueWait, ResumeMechanism, ResumeOutcome } from "../types.js";
import { waitSignalCorrelation } from "./wait-blocks.js";

export interface WaitMachineConfig {
  store: AartStore;
  redact: import("@aart/types").RedactFn;
  now: () => Date;
}

/** Wraps an arbitrary resume payload into the `Record<string, unknown>` shape `StepTrace.outputs` requires (spec §19.2) — a payload that's already a plain object passes through; anything else (a primitive, an array, `undefined`) is wrapped under a `value` key rather than dropped. */
function normalizePayloadToOutputs(payload: unknown): Record<string, unknown> {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { value: payload };
}

/** Finds the most recent `StepTrace` entry for `stepId` still in `status: "waiting"` — the entry `enterWait` pushed when this wait was first created, now being completed on resume. Throws (a genuine "how did we get here" condition, not a modeled `AartError`) if none is found — every non-immediately-resolved wait creates exactly one such entry, and `claimAndCompleteWait`'s dedupe check should already have short-circuited a second resume of the same step before this lookup ever runs on an already-completed entry. */
function findWaitingTraceIndex(run: RunRecord, stepId: string): number {
  for (let i = run.trace.length - 1; i >= 0; i--) {
    const entry = run.trace[i]!;
    if (entry.stepId === stepId && entry.status === "waiting") return i;
  }
  throw new Error(`No StepTrace with status "waiting" found for step "${stepId}" on run "${run.runId}" — cannot complete a wait that was never entered.`);
}

// ---------------------------------------------------------------------------
// enterWait — architecture §4.4 steps 1-4
// ---------------------------------------------------------------------------

export interface EnterWaitOptions {
  run: RunRecord;
  stepId: string;
  blockId: string;
  resolvedInputs: Record<string, unknown>;
  /** Already schema-version-stamped (architecture §4.7) — see `step-executor.ts`'s dispatch site. */
  wait: WaitCondition;
  resolvedSecretRefs: ReadonlySet<string>;
}

export interface EnterWaitResult {
  run: RunRecord;
  /** `true` if this run is now genuinely suspended (persisted `status: "waiting"`, a `WaitStore` row exists) and the caller (the step loop) must stop. `false` if the early-arrival check (architecture §4.4/§5.6) found an already-unconsumed matching `Signal` and resolved immediately — the caller should continue to the next step exactly as if this step had completed normally. */
  suspended: boolean;
}

/**
 * architecture §4.4 steps 1-4, including the early-arrival check (step 3):
 * BEFORE persisting a new outstanding wait, checks `SignalStore` for an
 * already-received, unconsumed match. Early-arrival is only meaningful for
 * the four `WaitCondition` members that correlate against a `Signal` at all
 * (`signal`/`webhook`/`queue`/`external_job`'s webhook subpath —
 * `waitSignalCorrelation` returns `undefined` for `timer`/`manual`/`approval`,
 * which skip the check entirely and always suspend).
 */
export async function enterWait(config: WaitMachineConfig, options: EnterWaitOptions): Promise<EnterWaitResult> {
  const { run, stepId, blockId, resolvedInputs, wait, resolvedSecretRefs } = options;
  const now = config.now();
  const correlation = waitSignalCorrelation(wait);

  // `[DECISION]` The ENTIRE check-then-act sequence below runs inside ONE
  // `store.transact()` call — architecture §4.4 step 3, verbatim: "FIRST,
  // inside the same AartStore.transact() call... checks SignalStore for an
  // already-received, unconsumed Signal... If no match is found, the check
  // and the writes below commit together in the one transaction, so a
  // signal arriving in the gap is impossible." This is load-bearing, not
  // just a style choice: without it, a Signal could arrive in the window
  // between "I checked SignalStore and found nothing" and "I persisted the
  // WaitStore row" — and since NOTHING re-scans SignalStore after wait
  // creation (only a *new* signal arrival triggers a resume-match attempt,
  // which requires the WaitStore row to already exist to match against),
  // a signal landing in that exact gap would sit unconsumed forever and
  // this wait would never resolve. `SQLite`/`Postgres` adapters (Wave 1/2)
  // give this a real serializability guarantee against a concurrent writer;
  // the fs adapter's own documented gap (architecture §5.8) is scoped to
  // the SignalStore *audit-copy* write specifically (`tx.signals.append`/
  // `markConsumed` are "deliberately NOT staged" — see types.ts's
  // `SignalStore` doc comment), not to this check-then-act sequence itself.
  return config.store.transact(async (tx) => {
    if (correlation) {
      const existingSignal = await tx.signals.findUnconsumedMatch(correlation.name, correlation.correlationId);
      if (existingSignal) {
        // Early-arrival resolution — none of the wait bookkeeping below is
        // ever persisted as outstanding; this step goes straight from
        // "about to wait" to "completed" in one hop (architecture §4.4 step
        // 3: "the wait resolves immediately... execution proceeds straight
        // to step 8").
        await tx.signals.markConsumed(existingSignal.id);
        const trace: StepTrace = {
          seq: run.trace.length,
          stepId,
          block: blockId,
          status: "completed",
          inputs: resolvedInputs,
          outputs: normalizePayloadToOutputs(existingSignal.payload),
          startedAt: now.toISOString(),
          endedAt: now.toISOString(),
          durationMs: 0,
        };
        const updatedRun: RunRecord = { ...run, trace: [...run.trace, trace], updatedAt: now.toISOString() };
        const redacted = applyRedaction(config.redact, updatedRun, resolvedSecretRefs);
        await tx.runs.put(redacted);
        return { run: redacted, suspended: false };
      }
    }

    // No early match (or this WaitCondition member never checks SignalStore
    // at all) — persist the outstanding wait, still inside the same
    // transaction as the check above.
    const trace: StepTrace = {
      seq: run.trace.length,
      stepId,
      block: blockId,
      status: "waiting",
      inputs: resolvedInputs,
      startedAt: now.toISOString(),
    };
    const updatedRun: RunRecord = {
      ...run,
      status: "waiting",
      waits: [...run.waits, wait],
      trace: [...run.trace, trace],
      updatedAt: now.toISOString(),
    };
    const redactedRun = applyRedaction(config.redact, updatedRun, resolvedSecretRefs);
    const redactedWait = applyRedaction(config.redact, wait, resolvedSecretRefs);
    await tx.runs.put(redactedRun);
    await tx.waits.put(run.runId, stepId, redactedWait, now.toISOString());
    return { run: redactedRun, suspended: true };
  });
}

// ---------------------------------------------------------------------------
// Resume — architecture §4.4 steps 6-9, §4.4.2's atomic claim (all three
// mechanisms, per the "scope of the atomic-claim rule" note).
// ---------------------------------------------------------------------------

interface ClaimAndCompleteArgs {
  runId: string;
  stepId: string;
  /**
   * A short, mechanism-specific token (e.g. `"timer"`, `"manual"`,
   * `"signal:<name>:<correlationId>"`) folded into the ACTUAL dedupe key
   * alongside the waiting trace entry's own `seq` — see the `seq`
   * incorporation below for why the suffix ALONE isn't sufficient.
   */
  dedupeKeySuffix: string;
  mechanism: ResumeMechanism;
  outputs: Record<string, unknown>;
  resolvedSecretRefs: ReadonlySet<string>;
}

/**
 * The one atomic-claim primitive every resume mechanism funnels through
 * (architecture §4.4.2's dedupe check + §4.4.2's "scope" extension to
 * scheduler-tick/direct-lookup). Inside a single `store.transact()` call:
 * find the waiting trace entry → dedupe-check (keyed by THAT ENTRY's own
 * `seq`, not just stepId+mechanism — see below) → (if already consumed:
 * no-op) → record dedupe key → delete the `WaitStore` row → complete the
 * "waiting" `StepTrace` entry → set `RunRecord.status` back to `"running"`
 * → persist. All of this commits together or none of it does (architecture
 * §5.8) — "a crash between 'dedupe recorded' and 'run state advanced'
 * cannot happen."
 *
 * `[DECISION]` (a bug caught by this session's own guarded-loop fixture
 * test, see this session's report): the dedupe key incorporates the
 * waiting `StepTrace` entry's own `seq`, not just `stepId`+mechanism-
 * suffix. A guarded back-edge (spec §18.2) can re-enter the SAME `stepId`
 * many times across a run's lifetime (`rescan` → `recheck_wait` →
 * `rescan` → `recheck_wait` → ...) — each cycle's wait is a
 * genuinely NEW, distinct wait instance on the same step id. A dedupe key
 * of just `"recheck_wait:timer"` would collide across cycles: cycle 1's
 * resume would record it consumed, and cycle 2's otherwise-legitimate
 * resume of the SAME step id (a different wait, a different trace entry)
 * would be incorrectly reported `"duplicate"` and never actually resume.
 * `seq` is unique per trace-entry push, including for a repeatedly-
 * re-entered step, so folding it in makes each cycle's dedupe key unique.
 */
async function claimAndCompleteWait(config: WaitMachineConfig, args: ClaimAndCompleteArgs): Promise<ResumeOutcome> {
  const { runId, stepId, dedupeKeySuffix, mechanism, outputs, resolvedSecretRefs } = args;
  const now = config.now();

  return config.store.transact(async (tx) => {
    const run = await tx.runs.get(runId);
    if (!run) {
      return { kind: "unmatched", mechanism };
    }
    const wait = await tx.waits.get(runId, stepId);
    if (!wait) {
      // The WaitStore row is already gone. Distinguish "genuinely never
      // existed for this (runId, stepId)" (unmatched) from "already
      // claimed and completed, by this call or a racing one" (duplicate)
      // by checking whether a completed trace for this step already
      // exists. This is the fallback for the race window an adapter
      // without strict serializable isolation could expose between two
      // concurrent transactions both observing "wait still present" —
      // the seq-keyed dedupe check below is the PRIMARY guard for that
      // window; this covers the case where the row is ALREADY gone by the
      // time this attempt even looks.
      const alreadyCompleted = run.trace.some((t) => t.stepId === stepId && t.status === "completed");
      return { kind: alreadyCompleted ? "duplicate" : "unmatched", mechanism };
    }

    assertSchemaVersionCompatible(run.schemaVersion, { runId, recordKind: "RunRecord" });
    assertSchemaVersionCompatible(wait.schemaVersion, { runId, stepId, recordKind: "WaitCondition" });

    const traceIndex = findWaitingTraceIndex(run, stepId);
    const waitingTrace = run.trace[traceIndex]!;
    const dedupeKey = `${stepId}:${waitingTrace.seq}:${dedupeKeySuffix}`;
    const alreadyConsumed = await tx.runs.hasDedupeKey(runId, dedupeKey);
    if (alreadyConsumed) {
      return { kind: "duplicate", mechanism };
    }

    await tx.runs.recordDedupeKey(runId, dedupeKey);
    await tx.waits.delete(runId, stepId);

    const startedAt = new Date(waitingTrace.startedAt).getTime();
    const completedTrace: StepTrace = {
      ...waitingTrace,
      status: "completed",
      outputs,
      endedAt: now.toISOString(),
      durationMs: Math.max(0, now.getTime() - startedAt),
    };
    const newTrace = [...run.trace];
    newTrace[traceIndex] = completedTrace;

    // `[DECISION]` `RunRecord.waits` is NOT pruned on resume — architecture
    // §4.4 step 4 only ever says a WaitCondition "gets... appended" to it,
    // with no removal instruction anywhere; treated here as an append-only
    // HISTORY of every wait this run has entered (useful for a report to
    // show the full "waited on X, then Y" sequence), not a "currently
    // outstanding" set. The authoritative source for "is this run
    // currently waiting, and on what" is `RunRecord.status` combined with
    // `WaitStore` (which this function DOES correctly delete from, above)
    // — `RunRecord.waits` doesn't need per-entry removal to stay correct
    // for that purpose. This also sidesteps a real ambiguity: `WaitCondition`
    // (spec §13.3) carries no `stepId` of its own, so two structurally-
    // identical outstanding waits on different steps (e.g. two bare
    // `{type: "manual"}` waits) would be indistinguishable by value alone
    // for a filter-by-equality removal.
    const updatedRun: RunRecord = {
      ...run,
      status: "running",
      trace: newTrace,
      updatedAt: now.toISOString(),
    };
    const redacted = applyRedaction(config.redact, updatedRun, resolvedSecretRefs);
    await tx.runs.put(redacted);
    return { kind: "resumed", run: redacted, mechanism };
  });
}

// ---------------------------------------------------------------------------
// Wait TIMEOUT expiry (architecture §4.4.1's "Expiry note", spec §13.3) —
// a DIFFERENT terminal outcome from resume: "wait timeouts in general are
// detected by the §4.4.3 scheduler tick... On expiry, the wait step fails
// with a timeout error, which is routable via flow.branch like any other
// step failure." This is a run-lifecycle transition this session's own DoD
// names explicitly ("every transition in the diagram") and is genuinely
// separate machinery from the 3 resume mechanisms above — a wait can be
// resolved by EITHER a resolving event (resume) OR its own timeout
// elapsing first, never both (the atomic claim below is what guarantees
// that: whichever claims the WaitStore row first — a resume or an expiry
// sweep — wins, the other finds nothing left to claim).
// ---------------------------------------------------------------------------

/** Every outstanding wait carrying a `timeout` field whose deadline (relative to the `WaitStore` row's own `createdAt`) has elapsed. `[DECISION]` NOT part of `getDueWaits` (below) — `WaitStore.listDue` (S0-frozen, architecture §4.4.3) is specifically "every timer-type wait whose `resumeAt` has passed"; `timeout` is a DIFFERENT, relative-duration field present on 6 of the 7 `WaitCondition` members (all but `timer`, which has no `timeout` field — a timer's own `resumeAt` due-ness, via `getDueWaits`, is the only time-based resolution it has) and checking it requires comparing against `createdAt` + a parsed duration, not a stored absolute deadline. S2's ticker should sweep this ALONGSIDE `getDueWaits`/`listExternalJobWaits` on the same interval. */
export async function getExpiredWaits(store: AartStore, now: Date): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition }>> {
  const all = await store.waits.list();
  return all
    .filter((entry) => {
      const timeout = "timeout" in entry.wait ? entry.wait.timeout : undefined;
      if (!timeout) return false;
      const deadline = new Date(entry.createdAt).getTime() + parseDurationMs(timeout);
      return now.getTime() >= deadline;
    })
    .map((entry) => ({ runId: entry.runId, stepId: entry.stepId, wait: entry.wait }));
}

/**
 * Fails an expired wait (architecture §4.4.1's Expiry note) — the SAME
 * atomic-claim discipline as `claimAndCompleteWait` (dedupe-keyed by the
 * waiting trace entry's own `seq`, so an expiry sweep racing a genuine
 * resolving event can't double-process the same wait), but marks the step
 * `"failed"` with a `TimeoutError` instead of `"completed"`. For an
 * `approval` wait specifically, ALSO sets the referenced `ApprovalTask.status
 * = "expired"` (spec §13.5's terminal-status set includes `"expired"`
 * precisely for this case) — not just the step trace.
 */
export async function failExpiredWait(config: WaitMachineConfig, runId: string, stepId: string, resolvedSecretRefs: ReadonlySet<string> = new Set()): Promise<ResumeOutcome> {
  const now = config.now();
  const mechanism: ResumeMechanism = "scheduler-tick";

  return config.store.transact(async (tx) => {
    const run = await tx.runs.get(runId);
    if (!run) {
      return { kind: "unmatched", mechanism };
    }
    const wait = await tx.waits.get(runId, stepId);
    if (!wait) {
      const alreadyResolved = run.trace.some((t) => t.stepId === stepId && (t.status === "completed" || t.status === "failed"));
      return { kind: alreadyResolved ? "duplicate" : "unmatched", mechanism };
    }

    assertSchemaVersionCompatible(run.schemaVersion, { runId, recordKind: "RunRecord" });
    assertSchemaVersionCompatible(wait.schemaVersion, { runId, stepId, recordKind: "WaitCondition" });

    const traceIndex = findWaitingTraceIndex(run, stepId);
    const waitingTrace = run.trace[traceIndex]!;
    const dedupeKey = `${stepId}:${waitingTrace.seq}:expiry`;
    const alreadyConsumed = await tx.runs.hasDedupeKey(runId, dedupeKey);
    if (alreadyConsumed) {
      return { kind: "duplicate", mechanism };
    }

    await tx.runs.recordDedupeKey(runId, dedupeKey);
    await tx.waits.delete(runId, stepId);

    if (wait.type === "approval") {
      const task = await tx.approvals.get(wait.taskId);
      if (task && task.status === "pending") {
        await tx.approvals.put({ ...task, status: "expired", decidedAt: now.toISOString() });
      }
    }

    const startedAt = new Date(waitingTrace.startedAt).getTime();
    const errorMessage = `Wait on step "${stepId}" (type "${wait.type}") expired after its declared timeout with no resolving event (architecture §4.4.1's Expiry note).`;
    const failedTrace: StepTrace = {
      ...waitingTrace,
      status: "failed",
      error: errorMessage,
      endedAt: now.toISOString(),
      durationMs: Math.max(0, now.getTime() - startedAt),
    };
    const newTrace = [...run.trace];
    newTrace[traceIndex] = failedTrace;

    const updatedRun: RunRecord = { ...run, status: "running", trace: newTrace, updatedAt: now.toISOString() };
    const redacted = applyRedaction(config.redact, updatedRun, resolvedSecretRefs);
    await tx.runs.put(redacted);
    return { kind: "resumed", run: redacted, mechanism };
  });
}

/**
 * **Signal-matched** resume (architecture §4.4.1 mechanism 1) — `signal`,
 * `webhook`, `queue` fully, and `external_job`'s webhook sub-path (once
 * whatever converted the provider's completion webhook into a `Signal`
 * calls this with that `Signal`). Looks up the matching outstanding wait by
 * `(name, correlationId)` across ALL waiting runs (architecture §4.4.2 step
 * 1's "before runId is known" case) — architecture §4.4.2 step 2: zero
 * matches is logged/inspectable, not a crash; more than one is a modeling
 * error and fails loudly (`CorrelationError`).
 *
 * **Scope note on redelivery** (see this session's report for the fuller
 * rationale): once a wait is resumed, its `WaitStore` row is deleted (by
 * `claimAndCompleteWait`) — a signal redelivered AFTER that point (a fresh
 * `Signal.id`, same `name`/`correlationId`, arriving once nothing is left
 * to correlate against) is reported `kind: "unmatched"`, not `"duplicate"`.
 * This is the honest classification: `"duplicate"` is architecture §4.4.2's
 * dedupe-KEY-ledger outcome for a redelivery that STILL finds a live,
 * not-yet-claimed wait (the window `claimAndCompleteWait`'s dedupe check
 * genuinely closes, proven by the direct-lookup mechanisms below and by
 * `enterWait`'s crash-simulation test) — this package does not maintain a
 * separate, unbounded, run-independent index of every correlation ever
 * resolved purely to relabel a post-cleanup redelivery as "duplicate"
 * instead of "unmatched." Both outcomes are non-crashing and safe; the
 * correctness property that actually matters — the run is never advanced
 * twice — holds under either label.
 */
export async function resumeBySignal(config: WaitMachineConfig, signal: Signal, resolvedSecretRefs: ReadonlySet<string> = new Set()): Promise<ResumeOutcome> {
  const allWaits = await config.store.waits.list();
  const matches = allWaits.filter((entry) => {
    const correlation = waitSignalCorrelation(entry.wait);
    return correlation !== undefined && correlation.name === signal.name && correlation.correlationId === signal.correlationId;
  });

  if (matches.length === 0) {
    return { kind: "unmatched", mechanism: "signal-matched" };
  }
  if (matches.length > 1) {
    throw new CorrelationError({
      message: `Signal "${signal.name}"/"${signal.correlationId}" matched ${matches.length} outstanding waits — correlationIds must be unique per outstanding wait (architecture §4.4.2 step 2). Matches: ${matches.map((m) => `${m.runId}/${m.stepId}`).join(", ")}.`,
      detail: { kind: "multipleWaitMatches", signalName: signal.name, correlationId: signal.correlationId, matches: matches.map((m) => ({ runId: m.runId, stepId: m.stepId })) },
    });
  }

  const match = matches[0]!;
  return claimAndCompleteWait(config, {
    runId: match.runId,
    stepId: match.stepId,
    dedupeKeySuffix: `signal:${signal.name}:${signal.correlationId}`,
    mechanism: "signal-matched",
    outputs: normalizePayloadToOutputs(signal.payload),
    resolvedSecretRefs,
  });
}

/** **Direct-lookup** resume (architecture §4.4.1 mechanism 3) for a `manual` wait — `aart_resume_run` with just a `runId`+`stepId`, no signal name needed. */
export async function resumeManual(config: WaitMachineConfig, runId: string, stepId: string, payload: unknown = {}, resolvedSecretRefs: ReadonlySet<string> = new Set()): Promise<ResumeOutcome> {
  return claimAndCompleteWait(config, {
    runId,
    stepId,
    dedupeKeySuffix: "manual",
    mechanism: "direct-lookup",
    outputs: normalizePayloadToOutputs(payload),
    resolvedSecretRefs,
  });
}

/** **Direct-lookup** resume (architecture §4.4.1 mechanism 3) for an `approval` wait — both authorship paths (CLI/dashboard human decision, and PR-merge-as-approval, architecture §7.2) write directly to `ApprovalStore` then call this, never a `Signal` (architecture §4.4.1's explicit statement: "approval... direct ApprovalStore write, either authorship path"). `task.status` must already be terminal (`approved`/`rejected`/`needs_changes`/`expired`) — the caller (governance's approval-write path, S4) is responsible for that state transition; this function only handles the RUN-side resume once it's happened. */
export async function resumeApproval(config: WaitMachineConfig, runId: string, stepId: string, task: { id: string; status: string; decision?: unknown; reviewer?: string }, resolvedSecretRefs: ReadonlySet<string> = new Set()): Promise<ResumeOutcome> {
  return claimAndCompleteWait(config, {
    runId,
    stepId,
    dedupeKeySuffix: `approval:${task.id}`,
    mechanism: "direct-lookup",
    outputs: { status: task.status, decision: task.decision, reviewer: task.reviewer },
    resolvedSecretRefs,
  });
}

/** **Scheduler-tick** resume (architecture §4.4.1 mechanism 2) for a `timer` wait that `getDueWaits` reported as due. S2's ticker calls `getDueWaits(now)` on its interval, then this function for each due entry. */
export async function resumeTimerWait(config: WaitMachineConfig, runId: string, stepId: string, resolvedSecretRefs: ReadonlySet<string> = new Set()): Promise<ResumeOutcome> {
  const now = config.now();
  return claimAndCompleteWait(config, {
    runId,
    stepId,
    dedupeKeySuffix: "timer",
    mechanism: "scheduler-tick",
    outputs: { resumedAt: now.toISOString() },
    resolvedSecretRefs,
  });
}

/** **Scheduler-tick** resume (architecture §4.4.1 mechanism 2) for `external_job`'s poll sub-path — called by S2's poll mechanism (spec §21.2/architecture §6.1's `poll` trigger, shared scheduler-ticker subsystem) once its polling determines the job is complete. Labeled `scheduler-tick` per architecture §4.4.1's explicit classification of this sub-path, even though the call shape is a direct claim (there is no `Signal`/`SignalStore` involvement for poll-mode `external_job` — see `wait/wait-blocks.ts`'s doc comment and `listExternalJobWaits` below). */
export async function resumeExternalJobResult(config: WaitMachineConfig, runId: string, stepId: string, resultPayload: unknown, resolvedSecretRefs: ReadonlySet<string> = new Set()): Promise<ResumeOutcome> {
  return claimAndCompleteWait(config, {
    runId,
    stepId,
    dedupeKeySuffix: "external_job",
    mechanism: "scheduler-tick",
    outputs: normalizePayloadToOutputs(resultPayload),
    resolvedSecretRefs,
  });
}

// ---------------------------------------------------------------------------
// The scheduler-ticker seam (architecture §4.4.3/§4.7) — S1 exports this,
// S2 owns and runs the interval loop that calls it. See SEAMS.md.
// ---------------------------------------------------------------------------

/** Every `timer`-type wait whose `resumeAt` has passed, for S2's scheduler ticker to sweep on its interval and resolve via `resumeTimerWait`. A thin, documented wrapper over `WaitStore.listDue` (architecture §4.4.3) — S1's responsibility "ends at 'here is a queryable, correctly-claimable function over WaitStore.'" */
export async function getDueWaits(store: AartStore, now: Date): Promise<DueWait[]> {
  const due = await store.waits.listDue(now.toISOString());
  return due
    .filter((entry): entry is typeof entry & { wait: Extract<WaitCondition, { type: "timer" }> } => entry.wait.type === "timer")
    .map((entry) => ({ runId: entry.runId, stepId: entry.stepId, wait: entry.wait }));
}

/** Every currently-outstanding `external_job` wait — for S2's poll mechanism to sweep on its own interval (no fixed deadline to filter by, unlike `timer` — see `DueWait`'s doc comment in types.ts) and, for each, poll the named provider's job-status endpoint, calling `resumeExternalJobResult` once a poll reports completion. */
export async function listExternalJobWaits(store: AartStore): Promise<Array<{ runId: string; stepId: string; wait: Extract<WaitCondition, { type: "external_job" }> }>> {
  const all = await store.waits.list();
  return all.filter((entry): entry is typeof entry & { wait: Extract<WaitCondition, { type: "external_job" }> } => entry.wait.type === "external_job");
}
