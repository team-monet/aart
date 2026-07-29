// StubEngine — mirrors @aart/engine's real, documented `Engine` interface
// (S1 SEAMS.md Seam 3 `triggerRun`, Seam 4 `createEngine(config): Engine`
// with `executeRun`/`resumeManual`/`resumeBySignal`/`resumeApproval`) plus
// Seam 2's engine-owned 7-id wait-block vocabulary. Real @aart/engine is
// still an S0 `export {}` stub in THIS worktree (S1 builds it in the
// concurrent, unmerged /Users/johnlee/code/aart-s1) — this is a documented
// placeholder, not a real step-execution engine: genuine step dispatch
// (if/then/else, forEach, retry/timeout, capability enforcement) is S1's
// exclusive scope (architecture §4.2) and is intentionally NOT reimplemented
// here.
//
// What IS real: every RunRecord/WaitCondition this stub produces is a real,
// schema-valid record persisted through the real (frozen, S0) @aart/store —
// so aart_run_workflow -> aart_get_report -> aart_list_waiting_runs ->
// aart_resume_run exercise a coherent, storable run lifecycle end to end,
// just without genuine block execution.
//
// Simulated step semantics (documented, not a faithful engine port):
//   - the 7 wait-triggering block ids S1's SEAMS Seam 2 names verbatim
//     (wait.for_signal | wait.until | wait.for_webhook | wait.for_external_job
//     | wait.for_queue | wait.manual | human.approval) transition the run to
//     "waiting" with a matching WaitCondition — this is the documented
//     CONTRACT the real engine implements, not a guess.
//   - `flow.fail` marks the run "failed".
//   - every other step "completes" immediately with empty outputs (`{}`).
import type { AartStore } from "@aart/store";
import type { RunRecord, StepTrace, Trigger, TrustMode, WaitCondition, Workflow, WorkflowStep } from "@aart/types";
import type { EnginePort, ResumeOutcome } from "../types.js";

const WAIT_BLOCK_IDS = new Set([
  "wait.for_signal",
  "wait.until",
  "wait.for_webhook",
  "wait.for_external_job",
  "wait.for_queue",
  "wait.manual",
  "human.approval",
]);

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

function buildWaitCondition(step: WorkflowStep, now: string): WaitCondition {
  const w = (step.with ?? {}) as Record<string, unknown>;
  switch (step.uses) {
    case "wait.for_signal":
      return {
        type: "signal",
        name: typeof w.name === "string" ? w.name : step.id,
        correlationId: typeof w.correlationId === "string" ? w.correlationId : "default",
        timeout: typeof w.timeout === "string" ? w.timeout : undefined,
        schemaVersion: 1,
      };
    case "wait.until":
      return {
        type: "timer",
        resumeAt: typeof w.until === "string" ? w.until : now,
        schemaVersion: 1,
      };
    case "wait.for_webhook":
      return {
        type: "webhook",
        event: typeof w.event === "string" ? w.event : step.id,
        correlationId: typeof w.correlationId === "string" ? w.correlationId : "default",
        timeout: typeof w.timeout === "string" ? w.timeout : undefined,
        schemaVersion: 1,
      };
    case "wait.for_external_job":
      return {
        type: "external_job",
        provider: typeof w.provider === "string" ? w.provider : "unknown",
        jobId: typeof w.jobId === "string" ? w.jobId : step.id,
        timeout: typeof w.timeout === "string" ? w.timeout : undefined,
        schemaVersion: 1,
      };
    case "wait.for_queue":
      return {
        type: "queue",
        queue: typeof w.queue === "string" ? w.queue : step.id,
        correlationId: typeof w.correlationId === "string" ? w.correlationId : "default",
        timeout: typeof w.timeout === "string" ? w.timeout : undefined,
        schemaVersion: 1,
      };
    case "wait.manual":
      return { type: "manual", timeout: typeof w.timeout === "string" ? w.timeout : undefined, schemaVersion: 1 };
    case "human.approval":
      return { type: "approval", taskId: newId("task"), timeout: typeof w.timeout === "string" ? w.timeout : undefined, schemaVersion: 1 };
    default:
      throw new Error(`buildWaitCondition: "${step.uses}" is not a wait-triggering block id`);
  }
}

export function createStubEngine(store: AartStore, now: () => Date = () => new Date()): EnginePort {
  async function advance(run: RunRecord): Promise<RunRecord> {
    const workflow = await store.workflows.get(run.workflowId, run.workflowVersion);
    if (!workflow) {
      throw new Error(`StubEngine.advance: workflow ${run.workflowId}@${run.workflowVersion} not found in store`);
    }
    const steps = workflow.execution.steps;
    const nowIso = now().toISOString();
    let startIndex = run.trace.length;
    // If we're resuming, the last trace entry is the "waiting" one — mark it
    // completed and continue from the NEXT step.
    if (startIndex > 0 && run.trace[startIndex - 1]?.status === "waiting") {
      const last = run.trace[startIndex - 1]!;
      last.status = "completed";
      last.endedAt = nowIso;
    } else {
      startIndex = run.trace.length;
    }

    run.status = "running";
    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i]!;
      if (WAIT_BLOCK_IDS.has(step.uses)) {
        const wait = buildWaitCondition(step, nowIso);
        run.waits = [wait];
        run.status = "waiting";
        const trace: StepTrace = {
          seq: i,
          stepId: step.id,
          block: step.uses,
          status: "waiting",
          inputs: step.with ?? {},
          startedAt: nowIso,
        };
        run.trace.push(trace);
        await store.waits.put(run.runId, step.id, wait, nowIso);
        run.updatedAt = nowIso;
        await store.runs.put(run);
        return run;
      }
      if (step.uses === "flow.fail") {
        const trace: StepTrace = {
          seq: i,
          stepId: step.id,
          block: step.uses,
          status: "failed",
          inputs: step.with ?? {},
          outputs: {},
          startedAt: nowIso,
          endedAt: nowIso,
          durationMs: 0,
          error: `Step "${step.id}" (flow.fail): intentional failure`,
        };
        run.trace.push(trace);
        run.status = "failed";
        run.error = trace.error;
        run.endedAt = nowIso;
        run.updatedAt = nowIso;
        await store.runs.put(run);
        return run;
      }
      const trace: StepTrace = {
        seq: i,
        stepId: step.id,
        block: step.uses,
        status: "completed",
        inputs: step.with ?? {},
        outputs: {},
        startedAt: nowIso,
        endedAt: nowIso,
        durationMs: 0,
      };
      run.trace.push(trace);
      run.waits = [];
    }
    run.status = "completed";
    run.outputs = run.outputs ?? {};
    run.endedAt = nowIso;
    run.updatedAt = nowIso;
    await store.runs.put(run);
    return run;
  }

  return {
    async triggerRun(input): Promise<RunRecord> {
      const nowIso = now().toISOString();
      const run: RunRecord = {
        runId: newId("run"),
        workflowId: input.workflow.id,
        workflowVersion: input.workflow.version,
        status: "pending",
        approved: input.approved ?? true,
        approvalMode: input.approvalMode ?? ("dev" as TrustMode),
        trigger: input.trigger,
        inputs: input.inputs,
        params: input.params,
        trace: [],
        waits: [],
        artifacts: [],
        snapshot: {
          definitions: input.workflow,
          resolvedVersions: {},
          packHashes: {},
          capturedAt: nowIso,
        },
        startedAt: nowIso,
        updatedAt: nowIso,
        schemaVersion: 1,
      };
      await store.runs.put(run);
      return run;
    },

    async executeRun(runId: string): Promise<RunRecord> {
      const run = await store.runs.get(runId);
      if (!run) throw new Error(`StubEngine.executeRun: run "${runId}" not found`);
      return advance(run);
    },

    async resumeManual(runId: string, stepId: string, payload?: unknown): Promise<ResumeOutcome> {
      const run = await store.runs.get(runId);
      const wait = await store.waits.get(runId, stepId);
      if (!run || !wait || run.status !== "waiting") return { kind: "unmatched" };
      const last = run.trace[run.trace.length - 1];
      if (last && last.stepId === stepId) {
        last.outputs = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      }
      await store.waits.delete(runId, stepId);
      const resumed = await advance(run);
      return { kind: "resumed", run: resumed };
    },

    async resumeBySignal(signal: { name: string; correlationId: string; payload?: unknown }): Promise<ResumeOutcome> {
      const matches = await store.waits.findSignalMatches(
        signal.name,
        signal.correlationId,
      );
      const match = matches[0];
      if (!match) return { kind: "unmatched" };
      return this.resumeManual(match.runId, match.stepId, signal.payload);
    },

    async resumeApproval(
      runId: string,
      stepId: string,
      task: { id: string; status: string; decision?: unknown; reviewer?: string },
    ): Promise<ResumeOutcome> {
      const run = await store.runs.get(runId);
      const wait = await store.waits.get(runId, stepId);
      if (!run || !wait || run.status !== "waiting") return { kind: "unmatched" };
      if (task.status === "rejected" || task.status === "needs_changes") {
        const nowIso = now().toISOString();
        const last = run.trace[run.trace.length - 1];
        if (last && last.stepId === stepId) {
          last.status = "failed";
          last.endedAt = nowIso;
          last.error = `Approval task ${task.id}: ${task.status}`;
        }
        run.status = "failed";
        run.error = `Approval task ${task.id}: ${task.status}`;
        run.endedAt = nowIso;
        run.updatedAt = nowIso;
        await store.waits.delete(runId, stepId);
        await store.runs.put(run);
        return { kind: "resumed", run };
      }
      return this.resumeManual(runId, stepId, task.decision);
    },
  };
}

export type { Trigger, Workflow };
