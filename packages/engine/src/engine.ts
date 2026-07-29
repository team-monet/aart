// createEngine — the public, constructor-injected composition surface
// (architecture §4.6/§7.9's DI framing applied to this whole package). This
// is what a composition root (`@aart/server`/`@aart/cli`/`@aart/mcp`, or
// this package's own tests) actually instantiates.
import type { RunRecord, Signal, Workflow } from "@aart/types";
import type { AartStore } from "@aart/store";
import {
  createTrackingSecretResolver,
  mergeOperationalRunTaint,
  redactStoredTextArtifacts,
  throwingSecretResolver,
} from "./redaction.js";
import { buildExprContext, resolveBooleanExpression } from "./expr-context.js";
import { cancelRun, executeRun, finalizeTerminal, runStepsLoop, triggerRun } from "./run-lifecycle.js";
import { resolveWorkflowForRun } from "./snapshot.js";
import {
  prepareRevokedIdempotencyConsumer,
  prepareTaintAfterControlResolution,
  resolveCompletedStepControl,
} from "./step-executor.js";
import type { DueWait, EngineConfig, ResumeOutcome, TriggerRunInput } from "./types.js";
import {
  failExpiredWait as failExpiredWaitMechanism,
  getDueWaits as getDueWaitsQuery,
  getExpiredWaits as getExpiredWaitsQuery,
  listExternalJobWaits as listExternalJobWaitsQuery,
  resumeApproval as resumeApprovalMechanism,
  resumeBySignal as resumeBySignalMechanism,
  resumeExternalJobResult as resumeExternalJobResultMechanism,
  resumeManual as resumeManualMechanism,
  resumeTimerWait as resumeTimerWaitMechanism,
  type WaitMachineConfig,
} from "./wait/wait-machine.js";

export interface Engine {
  /** Run-intake (architecture §4.3) — what S2's trigger adapters call. Throws `ConcurrencyRejectedError` for `reject_new`. */
  triggerRun(input: TriggerRunInput): Promise<import("@aart/types").RunRecord>;
  /** What a worker calls after claiming a run from `job_queue` (claim/lease: S2's scope). Reclaim-safe (architecture §4.7). */
  executeRun(runId: string): Promise<import("@aart/types").RunRecord>;
  /** spec F16 — cancels a run, recording unreached steps as `"skipped"`. */
  cancelRun(runId: string): Promise<import("@aart/types").RunRecord>;
  /** Signal-matched resume (architecture §4.4.1) — `signal`/`webhook`/`queue` waits, and `external_job`'s webhook sub-path. Continues execution past the resumed step to the next wait/terminal status. */
  resumeBySignal(signal: Signal): Promise<ResumeOutcome>;
  /** Direct-lookup resume for a `manual` wait (`aart_resume_run` with just a runId+stepId). */
  resumeManual(runId: string, stepId: string, payload?: unknown): Promise<ResumeOutcome>;
  /** Direct-lookup resume for an `approval` wait — call once the `ApprovalTask` has reached a terminal status (governance's/S4's write path). */
  resumeApproval(runId: string, stepId: string, task: { id: string; status: string; decision?: unknown; reviewer?: string }): Promise<ResumeOutcome>;
  /** Scheduler-tick resume for a `timer` wait `getDueWaits` reported as due. */
  resumeTimerWait(runId: string, stepId: string): Promise<ResumeOutcome>;
  /** Scheduler-tick resume for `external_job`'s poll sub-path, once S2's poll mechanism determines the job is complete. */
  resumeExternalJobResult(runId: string, stepId: string, resultPayload: unknown): Promise<ResumeOutcome>;
  /** The scheduler-ticker seam (architecture §4.4.3/§4.7) — S2's ticker calls this on its interval; S1 does not run the loop itself. See SEAMS.md. */
  getDueWaits(now?: Date): Promise<DueWait[]>;
  /** Every outstanding `external_job` wait, for S2's poll mechanism to sweep. */
  listExternalJobWaits(): ReturnType<typeof listExternalJobWaitsQuery>;
  /** Every outstanding wait whose declared `timeout` has elapsed (architecture §4.4.1's Expiry note) — S2's ticker should sweep this alongside `getDueWaits`. */
  getExpiredWaits(now?: Date): ReturnType<typeof getExpiredWaitsQuery>;
  /** Fails an expired wait — a step failure "routable via flow.branch like any other step failure" (architecture §4.4.1), finalizing the run as `"failed"` if nothing else resolves it first. For an `approval` wait, also sets the referenced `ApprovalTask.status = "expired"`. */
  failExpiredWait(runId: string, stepId: string): Promise<ResumeOutcome>;
}

function waitMachineConfig(config: EngineConfig): WaitMachineConfig {
  return {
    store: config.store,
    redact: config.redact,
    now: config.now ?? (() => new Date()),
    onRunTerminal: config.onRunTerminal,
    prepareRevokedIdempotencyConsumer: (
      store,
      run,
      outputTaintedLedgerKeys,
      resolvedSecretRefs,
    ) =>
      prepareRevokedIdempotencyConsumer(
        config,
        store,
        run,
        outputTaintedLedgerKeys,
        resolvedSecretRefs,
      ),
  };
}

/**
 * Continues execution past a just-resumed wait step: re-evaluates the
 * step's own `step.if` (deterministically, against the same run context —
 * safe to re-derive rather than needing to have persisted `ifResult`
 * itself) to resolve `step.next`/`step.then`/`step.else`/sequential
 * priority (architecture §4.2's last pipeline line) exactly as the normal
 * (non-wait) dispatch path would, then runs the step-loop from there.
 */
interface PreparedResume {
  workflow?: Workflow;
  operationalRun?: RunRecord;
  nextStepId?: string;
  controlError?: Error;
}

async function prepareResumedRun(
  config: EngineConfig,
  transactionStore: AartStore,
  run: RunRecord,
  stepId: string,
  resolvedSecretRefs: Set<string>,
  prepared: PreparedResume,
): Promise<RunRecord> {
  const workflow = await resolveWorkflowForRun(transactionStore, run);
  const step = workflow.execution.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new Error(`Resumed step "${stepId}" not found in workflow ${workflow.id}@${workflow.version} (run "${run.runId}").`);
  }

  let ifResult: boolean | undefined;
  let preDispatchControlError: Error | undefined;
  try {
    if (step.if !== undefined) {
      const context = buildExprContext(run);
      const secretResolver = createTrackingSecretResolver(config.resolveSecret ?? throwingSecretResolver, resolvedSecretRefs);
      ifResult = await resolveBooleanExpression(step.if, context, { secretResolver });
    }
  } catch (err) {
    preDispatchControlError =
      err instanceof Error ? err : new Error(String(err));
  }
  const controlResolution = preDispatchControlError
    ? { kind: "failed" as const, error: preDispatchControlError }
    : await resolveCompletedStepControl(
        workflow,
        step,
        run,
        ifResult,
        resolvedSecretRefs,
        config,
      );
  prepared.workflow = workflow;
  if (controlResolution.kind === "failed") {
    prepared.controlError = controlResolution.error;
  } else {
    prepared.nextStepId = controlResolution.nextStepId;
  }
  const preparedRun = prepareTaintAfterControlResolution(
    config,
    workflow,
    step,
    run,
    1,
    resolvedSecretRefs,
  );
  const operationalRun = {
    ...preparedRun,
    artifacts: await redactStoredTextArtifacts(
      transactionStore,
      config.redact,
      run.runId,
      resolvedSecretRefs,
    ),
  };
  prepared.operationalRun = operationalRun;
  return operationalRun;
}

async function resumeWithPreparation(
  config: EngineConfig,
  invoke: (
    resolvedSecretRefs: Set<string>,
    prepare: (
      run: RunRecord,
      stepId: string,
      transactionStore: AartStore,
    ) => Promise<RunRecord>,
  ) => Promise<ResumeOutcome>,
): Promise<ResumeOutcome> {
  const resolvedSecretRefs = new Set<string>();
  const prepared: PreparedResume = {};
  const outcome = await invoke(
    resolvedSecretRefs,
    (run, stepId, transactionStore) =>
      prepareResumedRun(
        config,
        transactionStore,
        run,
        stepId,
        resolvedSecretRefs,
        prepared,
      ),
  );
  if (outcome.kind !== "resumed") return outcome;
  if (!prepared.workflow) {
    throw new Error(
      `Resumed run "${outcome.run.runId}" was persisted without preparing its control-flow provenance.`,
    );
  }
  if (prepared.controlError) {
    const finalRun = await finalizeTerminal(
      config,
      outcome.run,
      prepared.workflow,
      "failed",
      resolvedSecretRefs,
      prepared.controlError.message,
    );
    return { ...outcome, run: finalRun };
  }
  const finalRun = await runStepsLoop(
    config,
    prepared.operationalRun === undefined
      ? outcome.run
      : mergeOperationalRunTaint(
          prepared.operationalRun,
          outcome.run,
        ),
    prepared.workflow,
    prepared.nextStepId,
    resolvedSecretRefs,
  );
  return { ...outcome, run: finalRun };
}

/**
 * Constructs an `Engine` from constructor-injected configuration
 * (architecture §4.6/§7.9). `config.capabilityCheck`/`config.redact` are
 * the two frozen `@aart/types` DI seams; `config.getGrantedCapabilities`/
 * `config.blocks`/etc. are this package's own composition surface. See
 * `capability.ts`'s `alwaysAllowCapabilityCheck` and `redaction.ts`'s
 * `identityRedactFn` for the trivial stubs this session's own tests (and a
 * composition root not yet wired to governance) use.
 */
export function createEngine(config: EngineConfig): Engine {
  return {
    triggerRun: (input) => triggerRun(config, input),
    executeRun: (runId) => executeRun(config, runId),
    cancelRun: (runId) => cancelRun(config, runId),

    resumeBySignal: (signal) =>
      resumeWithPreparation(config, (refs, prepare) =>
        resumeBySignalMechanism(
          waitMachineConfig(config),
          signal,
          refs,
          prepare,
        ),
      ),
    resumeManual: (runId, stepId, payload) =>
      resumeWithPreparation(config, (refs, prepare) =>
        resumeManualMechanism(
          waitMachineConfig(config),
          runId,
          stepId,
          payload,
          refs,
          prepare,
        ),
      ),
    resumeApproval: (runId, stepId, task) =>
      resumeWithPreparation(config, (refs, prepare) =>
        resumeApprovalMechanism(
          waitMachineConfig(config),
          runId,
          stepId,
          task,
          refs,
          prepare,
        ),
      ),
    resumeTimerWait: (runId, stepId) =>
      resumeWithPreparation(config, (refs, prepare) =>
        resumeTimerWaitMechanism(
          waitMachineConfig(config),
          runId,
          stepId,
          refs,
          prepare,
        ),
      ),
    resumeExternalJobResult: (runId, stepId, resultPayload) =>
      resumeWithPreparation(config, (refs, prepare) =>
        resumeExternalJobResultMechanism(
          waitMachineConfig(config),
          runId,
          stepId,
          resultPayload,
          refs,
          prepare,
        ),
      ),

    getDueWaits: (now) => getDueWaitsQuery(config.store, now ?? config.now?.() ?? new Date()),
    listExternalJobWaits: () => listExternalJobWaitsQuery(config.store),
    getExpiredWaits: (now) => getExpiredWaitsQuery(config.store, now ?? config.now?.() ?? new Date()),

    failExpiredWait: async (runId, stepId) => {
      const resolvedSecretRefs = new Set<string>();
      const operationalRunState =
        await config.store.waits.getOperationalRunState(
          runId,
          stepId,
        );
      for (const value of
        operationalRunState?.resolvedSecretValues ?? []) {
        resolvedSecretRefs.add(value);
      }
      const resumableRun =
        operationalRunState?.run ??
        (await config.store.runs.get(runId));
      const workflow =
        resumableRun === undefined
          ? undefined
          : await resolveWorkflowForRun(config.store, resumableRun);
      const outcome = await failExpiredWaitMechanism(
        waitMachineConfig(config),
        runId,
        stepId,
        resolvedSecretRefs,
      );
      if (outcome.kind !== "resumed") return outcome;
      // Unlike the resume wrappers above, a failed wait has no "next step"
      // to continue to — finalize the run as failed directly (the same
      // finalization path a normal step failure takes: snapshot-capture-
      // if-needed, terminal status, concurrency-queue release).
      if (workflow === undefined) {
        throw new Error(
          `Expired run "${runId}" was resolved without a workflow snapshot.`,
        );
      }
      const failedTrace = outcome.run.trace.find((t) => t.stepId === stepId && t.status === "failed");
      const finalRun = await finalizeTerminal(config, outcome.run, workflow, "failed", resolvedSecretRefs, failedTrace?.error ?? `Step "${stepId}" failed.`);
      return { ...outcome, run: finalRun };
    },
  };
}
