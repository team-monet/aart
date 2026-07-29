// Run lifecycle state machine (architecture §4.1) + the step-loop that
// drives `step-executor.ts` across a workflow's steps until the run reaches
// a terminal status or enters a wait. `triggerRun` is the run-intake
// function S2's trigger adapters call (architecture §4.3); `executeRun` is
// what a worker calls after claiming a run from `job_queue` (job_queue
// claim/lease/reclaim itself is explicitly S2/`@aart/server`'s scope,
// architecture §4.7 — this package never touches claim/lease/release).
import type { RunRecord, StepTrace, Workflow, WorkflowStep } from "@aart/types";
import { ConcurrencyRejectedError } from "@aart/types";
import { buildExprContext, resolveBooleanExpression } from "./expr-context.js";
import { decideConcurrency, fingerprintConcurrencyKey, releaseQueuedRuns, resolveConcurrencyKey } from "./concurrency.js";
import { applyRedaction, applyRunRedaction, createTrackingSecretResolver, redactStoredTextArtifacts, repairGlobalAuditsForNewSecrets, throwingSecretResolver } from "./redaction.js";
import { assertSchemaVersionCompatible, CURRENT_ENGINE_SCHEMA_VERSION } from "./schema-version.js";
import { captureExecutionSnapshot, isSnapshotCaptured, resolveWorkflowForRun, uncapturedSnapshot } from "./snapshot.js";
import { validateWorkflowOutputs, WorkflowOutputValidationError } from "./output-validation.js";
import {
  authoredStepIdForTrace,
  executeStep,
  prepareRevokedIdempotencyConsumer,
  prepareTaintAfterControlResolution,
  refreshTaintAfterControlResolution,
  resolveCompletedStepControl,
  type StepOutcome,
} from "./step-executor.js";
import { revokeSecretTaintedIdempotency } from "./idempotency.js";
import type { EngineConfig, TriggerRunInput } from "./types.js";
import { isWaitBlockId } from "./wait/wait-blocks.js";
import { materializeWorkflowOutputs } from "./workflow-outputs.js";

// ---------------------------------------------------------------------------
// Run intake (architecture §4.3) — S2's trigger adapters call this.
// ---------------------------------------------------------------------------

function withoutConcurrencyBookkeeping(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const callerParams = { ...params };
  delete callerParams.concurrencyKey;
  delete callerParams.concurrencyKeyFormat;
  delete callerParams.waitingOnConcurrency;
  return callerParams;
}

/**
 * The engine's trigger-intake function (implementation plan S2's consumed-
 * interfaces note: "trigger adapters call into the engine's run-intake
 * function"). Resolves the workflow's declared `concurrency` policy (if
 * any — AMENDMENTS.md A16) BEFORE writing a new `RunRecord`, per
 * architecture §4.3's four policies:
 *
 * - `allow` (default, no `concurrency` declared, or no conflicting
 *   non-terminal run exists) — creates and enqueues normally.
 * - `queue` — creates the `RunRecord` as `pending` but does NOT enqueue it
 *   to `job_queue` yet (`params.waitingOnConcurrency: true`);
 *   `releaseQueuedRuns` (concurrency.ts), called by this module whenever a
 *   run reaches a terminal status, enqueues the next queued run in line.
 * - `cancel_existing` — the existing non-terminal run is cancelled
 *   (`cancelRun`, spec F16 skip-recording) before the new run is created.
 * - `reject_new` — throws `ConcurrencyRejectedError` (architecture §4.3) —
 *   no `RunRecord` is ever created; the caller (S2) is expected to turn
 *   this into whatever rejected-trigger response/record its own DoD
 *   requires (architecture §6.2 — that persistence is S2's scope).
 */
export async function triggerRun(config: EngineConfig, input: TriggerRunInput): Promise<RunRecord> {
  const now = config.now?.() ?? new Date();
  const schemaVersion = config.schemaVersion ?? CURRENT_ENGINE_SCHEMA_VERSION;
  // Keep the persisted slot backward-readable while older intake instances
  // can share this store during a rolling upgrade. Current readers normalize
  // both this raw representation and the short-lived fingerprinted format;
  // the rejection diagnostic uses only a non-reversible fingerprint.
  const resolvedKey = await resolveConcurrencyKey(input.workflow, input.inputs);
  const decision = await decideConcurrency(config.store, input.workflow, resolvedKey);

  if (decision.action === "reject") {
    throw new ConcurrencyRejectedError({
      message: `Trigger for workflow "${input.workflow.id}" rejected — an existing non-terminal run already holds the same concurrency key under policy "reject_new" (architecture §4.3).`,
      detail: { kind: "concurrencyRejected", workflowId: input.workflow.id, key: fingerprintConcurrencyKey(resolvedKey) },
    });
  }
  if (decision.action === "cancel_existing") {
    await cancelRun(config, decision.existingRun.runId);
  }

  const waitingOnConcurrency = decision.action === "queue";
  const run: RunRecord = {
    runId: crypto.randomUUID(),
    workflowId: input.workflow.id,
    workflowVersion: input.workflow.version,
    status: "pending",
    approved: input.approved ?? true,
    approvalMode: input.approvalMode ?? "dev",
    trigger: input.trigger,
    inputs: input.inputs,
    // `[DECISION]` `concurrencyKey`/`environment`/`waitingOnConcurrency` are
    // this package's own internal bookkeeping stashed in the existing
    // free-form `params` bag (spec §19.1: "operational tuning... params
    // never affect approval or gates") rather than new `RunRecord` schema
    // fields — see EngineConfig's `GetGrantedCapabilities` doc comment
    // (types.ts) for the `environment` rationale, and architecture micro-
    // decision #12 for the `waitingOnConcurrency` precedent ("Internal...
    // bookkeeping flag... not a spec-visible WaitCondition member").
    params: {
      ...withoutConcurrencyBookkeeping(input.params),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(resolvedKey !== undefined ? { concurrencyKey: resolvedKey } : {}),
      ...(waitingOnConcurrency ? { waitingOnConcurrency: true } : {}),
    },
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: uncapturedSnapshot(),
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    schemaVersion,
  };

  const resolvedSecretRefs = new Set<string>();
  const redacted = applyRunRedaction(config.redact, run, resolvedSecretRefs);
  await config.store.runs.put(redacted);
  if (!waitingOnConcurrency) {
    await config.store.jobQueue.enqueue(redacted.runId);
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Run lifecycle transitions (architecture §4.1)
// ---------------------------------------------------------------------------

function environmentOf(run: RunRecord): string | undefined {
  return typeof run.params?.environment === "string" ? run.params.environment : undefined;
}

/**
 * Exported (beyond this module's own internal use) so `engine.ts`'s
 * `failExpiredWait` wrapper can finalize a run whose wait just expired
 * (architecture §4.4.1's Expiry note) — the SAME finalization path a
 * normal step failure takes (snapshot-capture-if-needed, terminal status,
 * concurrency-queue release), just triggered from `wait/wait-machine.ts`'s
 * `failExpiredWait` claim instead of `executeStep`'s own failure path.
 */
export async function finalizeTerminal(
  config: EngineConfig,
  run: RunRecord,
  workflow: Workflow,
  status: "completed" | "failed" | "cancelled",
  resolvedSecretRefs: Set<string>,
  errorMessage?: string,
): Promise<RunRecord> {
  const now = config.now?.() ?? new Date();
  let updated = run;
  let terminalStatus = status;
  let terminalError = errorMessage;
  let outputs = updated.outputs;
  // Queue bookkeeping is operational state, not a report surface. Preserve
  // the exact key before whole-record redaction so a secret value that also
  // occurs in the key cannot prevent the next queued run from being released.
  const concurrencyKey = updated.params?.concurrencyKey;
  const concurrencyKeyFormat = updated.params?.concurrencyKeyFormat;

  // A workflow's declared outputMapping is its public result contract. Step
  // traces are execution evidence; callers should not have to reverse-engineer
  // the last step (or know the workflow's internal graph) to obtain the actual
  // result. Resolve the mapping only on successful completion, against the
  // same expression context and tracked secret resolver used by step inputs.
  if (status === "completed") {
    try {
      const secretResolver = createTrackingSecretResolver(config.resolveSecret ?? throwingSecretResolver, resolvedSecretRefs);
      outputs = await materializeWorkflowOutputs(workflow, updated, { secretResolver });
      // Validate what callers will actually observe after the persistence
      // redaction boundary. A raw number that becomes a string marker, or an
      // enum/pattern value changed by redaction, is not a valid completed
      // public result.
      const observableOutputs = applyRedaction(config.redact, outputs, resolvedSecretRefs);
      validateWorkflowOutputs(workflow, observableOutputs);
    } catch (err) {
      // A declared result that cannot be produced is a failed workflow, even
      // when every individual block completed. Persist a terminal failure
      // instead of leaving the run stuck in "running" or reporting success
      // with an absent result.
      terminalStatus = "failed";
      terminalError =
        err instanceof WorkflowOutputValidationError
          ? err.message
          : `Workflow output mapping failed: ${err instanceof Error ? err.message : String(err)}`;
      outputs = undefined;
    }
  }

  // ExecutionSnapshot capture (architecture §4.5) — "once per run, at the
  // earlier of (a) the run's first wait, or (b) run completion if it never
  // waits." A run that entered at least one wait already has one (captured
  // in the step-loop below, right before dispatching a wait-type step); a
  // run that never waited captures it here, at its first terminal status.
  if (!isSnapshotCaptured(updated.snapshot)) {
    updated = { ...updated, snapshot: await captureExecutionSnapshot(workflow, config.blocks, now, config.computePackHashes) };
  }
  await repairGlobalAuditsForNewSecrets(
    config.store,
    config.redact,
    resolvedSecretRefs,
  );
  updated = {
    ...updated,
    artifacts: await redactStoredTextArtifacts(
      config.store,
      config.redact,
      updated.runId,
      resolvedSecretRefs,
    ),
  };
  updated = { ...updated, status: terminalStatus, outputs, error: terminalError, endedAt: now.toISOString(), updatedAt: now.toISOString() };
  const redacted = await config.store.transact(async (tx) => {
    const repaired = await revokeSecretTaintedIdempotency(
      tx,
      config.redact,
      updated,
      resolvedSecretRefs,
      (
        store,
        consumerRun,
        outputTaintedLedgerKeys,
        secretRefs,
        repairOptions,
      ) =>
        prepareRevokedIdempotencyConsumer(
          config,
          store,
          consumerRun,
          outputTaintedLedgerKeys,
          secretRefs,
          consumerRun.runId === updated.runId ? workflow : undefined,
          repairOptions?.includeUnattributedSignalAudits,
        ),
    );
    const persistenceSafeRun = applyRunRedaction(
      config.redact,
      repaired,
      resolvedSecretRefs,
    );
    await tx.runs.put(persistenceSafeRun);
    return persistenceSafeRun;
  });

  if (typeof concurrencyKey === "string") {
    await releaseQueuedRuns(config.store, redacted.workflowId, concurrencyKey, concurrencyKeyFormat);
  }
  await runOnRunTerminal(config, redacted.runId);
  return redacted;
}

/** Best-effort per-run resource cleanup (S9 reconciliation ledger item 10, SEAMS.md S3-E1) — never lets a cleanup-hook failure fail the run's own (already-persisted) terminal transition. */
async function runOnRunTerminal(config: EngineConfig, runId: string): Promise<void> {
  if (!config.onRunTerminal) return;
  try {
    await config.onRunTerminal(runId);
  } catch {
    // Best-effort: the run's terminal status is already durably persisted;
    // a resource-cleanup hook failing (e.g. a browser context that was
    // already closed, or a transient error closing it) must never
    // retroactively fail an already-completed/failed/cancelled run.
  }
}

async function recordThrownFailureAndFinalize(
  config: EngineConfig,
  run: RunRecord,
  workflow: Workflow,
  step: WorkflowStep,
  err: unknown,
  resolvedSecretRefs: Set<string>,
): Promise<RunRecord> {
  const now = (config.now?.() ?? new Date()).toISOString();
  const message = err instanceof Error ? err.message : String(err);
  // Covers the "engine refusal" throws that occur BEFORE a block's own
  // execute() is ever called (CapabilityDeniedError, IterationLimitExceededError,
  // a missing block registration) — these bypass dispatchOnce's own
  // try/catch (which only wraps block-execution failures, so retry
  // classification stays scoped to genuine block failures), so this loop-
  // level catch is what makes them "diagnosable in the trace" too
  // (implementation plan S1 DoD wording), via the same StepTrace shape a
  // normal dispatch failure gets.
  const trace: StepTrace = { seq: run.trace.length, stepId: step.id, block: step.uses, status: "failed", inputs: {}, error: message, startedAt: now, endedAt: now, durationMs: 0 };
  const withTrace: RunRecord = { ...run, trace: [...run.trace, trace] };
  const prepared = prepareTaintAfterControlResolution(
    config,
    workflow,
    step,
    withTrace,
    1,
    resolvedSecretRefs,
  );
  return finalizeTerminal(config, prepared, workflow, "failed", resolvedSecretRefs, message);
}

/**
 * Where a run with EXISTING trace history should continue from — used both
 * for a worker reclaiming a run that crashed mid-step (architecture §4.7:
 * "resume logic is reclaim-safe, not just restart-safe") and, trivially,
 * for a run that hasn't executed anything yet. `[DECISION]` (see this
 * session's report): a trailing trace entry that is itself `"failed"`, or a
 * forEach ITERATION sub-entry (a `stepId[n]`-suffixed id, meaning the owning
 * forEach step never reached its own aggregate completion), means that
 * owning step never genuinely finished — re-run it from scratch rather than
 * advancing past it. This is the SAME at-least-once guarantee already
 * documented for step execution generally (architecture §4.2): a crash
 * mid-forEach can re-attempt already-completed iterations, exactly as a
 * crash mid-single-step can re-attempt it — `idempotencyKey` is what turns
 * either into an exactly-once EFFECT, same as always.
 */
async function resolveContinuation(
  config: EngineConfig,
  run: RunRecord,
  workflow: Workflow,
  resolvedSecretRefs: Set<string>,
): Promise<{
  run: RunRecord;
  nextStepId: string | undefined;
  controlError?: Error;
}> {
  if (run.trace.length === 0) {
    return { run, nextStepId: workflow.execution.steps[0]?.id };
  }
  const lastTrace = run.trace[run.trace.length - 1]!;
  const ownerStepId = authoredStepIdForTrace(workflow, lastTrace);
  const ownerStep = workflow.execution.steps.find(
    (step) => step.id === ownerStepId,
  );
  const isForEachSubEntry =
    ownerStep?.forEach !== undefined &&
    (lastTrace.iterationIndex !== undefined ||
      lastTrace.stepId !== ownerStepId);

  if (lastTrace.status === "failed" || isForEachSubEntry) {
    return { run, nextStepId: ownerStepId };
  }

  const lastStep = ownerStep;
  if (!lastStep) {
    throw new Error(`Cannot resolve continuation point for run "${run.runId}": step "${ownerStepId}" (from trailing trace entry "${lastTrace.stepId}") not found in workflow ${workflow.id}@${workflow.version}.`);
  }

  // A persisted skipped trace is already the authoritative result of
  // `if: false`. Fresh execution never evaluates `until` on that path and
  // chooses `next`, then `else`, then array order. Reclaim must reproduce
  // that exact transition rather than feeding the skipped step through the
  // completed-step control resolver.
  if (lastTrace.status === "skipped") {
    const stepIndex = workflow.execution.steps.findIndex(
      (step) => step.id === lastStep.id,
    );
    const refreshedRun = await refreshTaintAfterControlResolution(
      config,
      workflow,
      lastStep,
      run,
      1,
      resolvedSecretRefs,
      resolvedSecretRefs.size,
    );
    return {
      run: refreshedRun,
      nextStepId:
        lastStep.next ??
        lastStep.else ??
        workflow.execution.steps[stepIndex + 1]?.id,
    };
  }

  let ifResult: boolean | undefined;
  let preDispatchControlError: Error | undefined;
  const secretCountBeforeControlResolution = resolvedSecretRefs.size;
  try {
    if (lastStep.if !== undefined) {
      const context = buildExprContext(run);
      const secretResolver = createTrackingSecretResolver(config.resolveSecret ?? throwingSecretResolver, resolvedSecretRefs);
      ifResult = await resolveBooleanExpression(lastStep.if, context, { secretResolver });
    }
  } catch (err) {
    preDispatchControlError =
      err instanceof Error ? err : new Error(String(err));
  }
  const controlResolution = preDispatchControlError
    ? { kind: "failed" as const, error: preDispatchControlError }
    : await resolveCompletedStepControl(
        workflow,
        lastStep,
        run,
        ifResult,
        resolvedSecretRefs,
        config,
      );
  let currentTraceCount = 1;
  if (lastStep.forEach !== undefined) {
    const declaredStepIds = new Set(
      workflow.execution.steps.map((step) => step.id),
    );
    const escapedOwnerStepId = ownerStepId.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const iterationTracePattern = new RegExp(
      `^${escapedOwnerStepId}\\[\\d+\\]$`,
    );
    for (let index = run.trace.length - 2; index >= 0; index -= 1) {
      const candidate = run.trace[index]!;
      const candidateStepId = candidate.stepId;
      if (
        declaredStepIds.has(candidateStepId) ||
        !(
          (candidate.authoredStepId === ownerStepId &&
            candidate.iterationIndex !== undefined) ||
          iterationTracePattern.test(candidateStepId)
        )
      ) {
        break;
      }
      currentTraceCount += 1;
    }
  }
  const refreshedRun = await refreshTaintAfterControlResolution(
    config,
    workflow,
    lastStep,
    run,
    currentTraceCount,
    resolvedSecretRefs,
    secretCountBeforeControlResolution,
  );
  return {
    run: refreshedRun,
    nextStepId:
      controlResolution.kind === "resolved"
        ? controlResolution.nextStepId
        : undefined,
    ...(controlResolution.kind === "failed"
      ? { controlError: controlResolution.error }
      : {}),
  };
}

/**
 * The core step-loop: dispatches steps starting at `startStepId` until the
 * run enters a wait or reaches a terminal status. Shared by `executeRun`
 * (fresh/reclaimed execution) and every `engine.ts` resume wrapper
 * (continuing past a just-resumed wait step).
 */
export async function runStepsLoop(config: EngineConfig, initialRun: RunRecord, workflow: Workflow, startStepId: string | undefined, resolvedSecretRefs: Set<string>): Promise<RunRecord> {
  let run = initialRun;
  let currentStepId = startStepId;
  const environment = environmentOf(run);

  while (currentStepId !== undefined) {
    const step = workflow.execution.steps.find((s) => s.id === currentStepId);
    if (!step) {
      throw new Error(`Step "${currentStepId}" referenced but not found in workflow ${workflow.id}@${workflow.version} (run "${run.runId}").`);
    }

    if (!isSnapshotCaptured(run.snapshot) && isWaitBlockId(step.uses)) {
      const now = config.now?.() ?? new Date();
      const withSnapshot: RunRecord = { ...run, snapshot: await captureExecutionSnapshot(workflow, config.blocks, now, config.computePackHashes) };
      run = applyRunRedaction(config.redact, withSnapshot, resolvedSecretRefs);
      await config.store.runs.put(run);
    }

    let outcome: StepOutcome;
    try {
      outcome = await executeStep(config, run, workflow, step, resolvedSecretRefs, environment);
    } catch (err) {
      return recordThrownFailureAndFinalize(config, run, workflow, step, err, resolvedSecretRefs);
    }

    run = outcome.run;
    if (outcome.kind === "waiting") {
      return run;
    }
    if (outcome.kind === "failed") {
      return finalizeTerminal(config, run, workflow, "failed", resolvedSecretRefs, outcome.error.message);
    }
    currentStepId = outcome.nextStepId;
  }

  return finalizeTerminal(config, run, workflow, "completed", resolvedSecretRefs);
}

/**
 * What a worker calls after claiming a run from `job_queue` (claim/lease
 * itself: S2's scope, architecture §4.7). Loads the `RunRecord` fresh from
 * the store — no in-memory state is assumed to carry over, which is what
 * makes this correct for BOTH a clean same-worker restart AND a genuinely
 * different worker resuming a run the original claimant never released
 * cleanly (architecture §4.7's reclaim-safety requirement, implementation
 * plan S1 DoD). Transitions `pending` → `running` (architecture §4.1); a
 * run already `running` (the reclaim case — a prior attempt crashed
 * mid-step without reaching a wait or terminal status) resumes from
 * `resolveContinuation`'s computed continuation point instead of
 * restarting at step 0.
 */
export async function executeRun(config: EngineConfig, runId: string): Promise<RunRecord> {
  const loaded = await config.store.runs.get(runId);
  if (!loaded) {
    throw new Error(`executeRun: no RunRecord found for runId "${runId}".`);
  }
  assertSchemaVersionCompatible(loaded.schemaVersion, { runId, recordKind: "RunRecord" });

  const workflow = await resolveWorkflowForRun(config.store, loaded);
  const resolvedSecretRefs = new Set<string>();

  let run = loaded;
  if (run.status === "pending") {
    const now = (config.now?.() ?? new Date()).toISOString();
    run = applyRunRedaction(config.redact, { ...run, status: "running", updatedAt: now }, resolvedSecretRefs);
    await config.store.runs.put(run);
  } else if (run.status !== "running") {
    // Already `waiting`/`completed`/`failed`/`cancelled` — idempotent no-op
    // for a caller that races executeRun against another resume mechanism.
    return run;
  }

  const continuation = await resolveContinuation(
    config,
    run,
    workflow,
    resolvedSecretRefs,
  );
  if (continuation.controlError) {
    return finalizeTerminal(
      config,
      continuation.run,
      workflow,
      "failed",
      resolvedSecretRefs,
      continuation.controlError.message,
    );
  }
  return runStepsLoop(
    config,
    continuation.run,
    workflow,
    continuation.nextStepId,
    resolvedSecretRefs,
  );
}

// ---------------------------------------------------------------------------
// Cancellation (architecture §4.1, spec F16)
// ---------------------------------------------------------------------------

/**
 * Cancels a run — sets `status: "cancelled"` and records every step not yet
 * reached as `"skipped"` in its own `StepTrace` (spec F16, tested explicitly
 * per this session's DoD). Idempotent: cancelling an already-terminal run
 * is a no-op returning the run unchanged. Used both as a direct operation
 * and by `triggerRun`'s `cancel_existing` concurrency policy.
 */
export async function cancelRun(config: EngineConfig, runId: string): Promise<RunRecord> {
  const run = await config.store.runs.get(runId);
  if (!run) {
    throw new Error(`cancelRun: no RunRecord found for runId "${runId}".`);
  }
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return run;
  }

  const workflow = await resolveWorkflowForRun(config.store, run);
  const reachedStepIds = new Set(run.trace.map((t) => t.stepId.replace(/\[\d+\]$/, "")));
  const now = (config.now?.() ?? new Date()).toISOString();
  const skippedTraces: StepTrace[] = workflow.execution.steps
    .filter((s) => !reachedStepIds.has(s.id))
    .map((s, i): StepTrace => ({ seq: run.trace.length + i, stepId: s.id, block: s.uses, status: "skipped", inputs: {}, startedAt: now, endedAt: now, durationMs: 0 }));

  const resolvedSecretRefs = new Set<string>();
  const nowDate = config.now?.() ?? new Date();
  const concurrencyKey = run.params?.concurrencyKey;
  const concurrencyKeyFormat = run.params?.concurrencyKeyFormat;
  const updated: RunRecord = {
    ...run,
    status: "cancelled",
    trace: [...run.trace, ...skippedTraces],
    endedAt: now,
    updatedAt: now,
    snapshot: isSnapshotCaptured(run.snapshot) ? run.snapshot : await captureExecutionSnapshot(workflow, config.blocks, nowDate, config.computePackHashes),
  };
  const redacted = applyRunRedaction(config.redact, updated, resolvedSecretRefs);
  await config.store.runs.put(redacted);

  if (typeof concurrencyKey === "string") {
    await releaseQueuedRuns(config.store, redacted.workflowId, concurrencyKey, concurrencyKeyFormat);
  }
  await runOnRunTerminal(config, redacted.runId);
  return redacted;
}
