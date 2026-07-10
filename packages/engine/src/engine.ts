// createEngine — the public, constructor-injected composition surface
// (architecture §4.6/§7.9's DI framing applied to this whole package). This
// is what a composition root (`@aart/server`/`@aart/cli`/`@aart/mcp`, or
// this package's own tests) actually instantiates.
import type { Signal } from "@aart/types";
import { createTrackingSecretResolver, throwingSecretResolver } from "./redaction.js";
import { buildExprContext, resolveBooleanExpression } from "./expr-context.js";
import { cancelRun, executeRun, runStepsLoop, triggerRun } from "./run-lifecycle.js";
import { resolveWorkflowForRun } from "./snapshot.js";
import { determineNextStepId } from "./step-executor.js";
import type { DueWait, EngineConfig, ResumeOutcome, TriggerRunInput } from "./types.js";
import {
  getDueWaits as getDueWaitsQuery,
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
}

function waitMachineConfig(config: EngineConfig): WaitMachineConfig {
  return { store: config.store, redact: config.redact, now: config.now ?? (() => new Date()) };
}

/**
 * Continues execution past a just-resumed wait step: re-evaluates the
 * step's own `step.if` (deterministically, against the same run context —
 * safe to re-derive rather than needing to have persisted `ifResult`
 * itself) to resolve `step.next`/`step.then`/`step.else`/sequential
 * priority (architecture §4.2's last pipeline line) exactly as the normal
 * (non-wait) dispatch path would, then runs the step-loop from there.
 */
async function continueAfterResume(config: EngineConfig, outcome: ResumeOutcome, stepId: string): Promise<ResumeOutcome> {
  if (outcome.kind !== "resumed") return outcome;

  const workflow = await resolveWorkflowForRun(config.store, outcome.run);
  const step = workflow.execution.steps.find((s) => s.id === stepId);
  if (!step) {
    throw new Error(`Resumed step "${stepId}" not found in workflow ${workflow.id}@${workflow.version} (run "${outcome.run.runId}").`);
  }

  const resolvedSecretRefs = new Set<string>();
  let ifResult: boolean | undefined;
  if (step.if !== undefined) {
    const context = buildExprContext(outcome.run);
    const secretResolver = createTrackingSecretResolver(config.resolveSecret ?? throwingSecretResolver, resolvedSecretRefs);
    ifResult = await resolveBooleanExpression(step.if, context, { secretResolver });
  }
  const nextStepId = await determineNextStepId(workflow, step, outcome.run, ifResult, resolvedSecretRefs, config);
  const finalRun = await runStepsLoop(config, outcome.run, workflow, nextStepId, resolvedSecretRefs);
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

    resumeBySignal: async (signal) => {
      const outcome = await resumeBySignalMechanism(waitMachineConfig(config), signal);
      if (outcome.kind !== "resumed") return outcome;
      // `resumeBySignalMechanism` doesn't know the resolved `stepId` ahead
      // of the caller — but it's on the outcome's run only implicitly (the
      // just-completed trailing trace entry). Re-derive it the same way
      // `resolveContinuationStepId` would, by reading the trailing trace.
      const stepId = trailingCompletedStepId(outcome.run);
      return continueAfterResume(config, outcome, stepId);
    },
    resumeManual: async (runId, stepId, payload) => {
      const outcome = await resumeManualMechanism(waitMachineConfig(config), runId, stepId, payload);
      return continueAfterResume(config, outcome, stepId);
    },
    resumeApproval: async (runId, stepId, task) => {
      const outcome = await resumeApprovalMechanism(waitMachineConfig(config), runId, stepId, task);
      return continueAfterResume(config, outcome, stepId);
    },
    resumeTimerWait: async (runId, stepId) => {
      const outcome = await resumeTimerWaitMechanism(waitMachineConfig(config), runId, stepId);
      return continueAfterResume(config, outcome, stepId);
    },
    resumeExternalJobResult: async (runId, stepId, resultPayload) => {
      const outcome = await resumeExternalJobResultMechanism(waitMachineConfig(config), runId, stepId, resultPayload);
      return continueAfterResume(config, outcome, stepId);
    },

    getDueWaits: (now) => getDueWaitsQuery(config.store, now ?? config.now?.() ?? new Date()),
    listExternalJobWaits: () => listExternalJobWaitsQuery(config.store),
  };
}

/** The `stepId` of the most recently completed trace entry — used by `resumeBySignal`'s wrapper, which (unlike `resumeManual`/`resumeApproval`/`resumeTimerWait`/`resumeExternalJobResult`) isn't handed `stepId` directly by its caller (a signal only carries `name`/`correlationId`, matched internally by `wait/wait-machine.ts`). */
function trailingCompletedStepId(run: import("@aart/types").RunRecord): string {
  const last = run.trace[run.trace.length - 1];
  if (!last) {
    throw new Error(`Resumed run "${run.runId}" has no trace entries — cannot determine which step was just resumed.`);
  }
  return last.stepId;
}
