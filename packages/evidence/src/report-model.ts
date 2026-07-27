// report-model.ts — the shared intermediate "report model" (architecture
// §9.3): "Report UX ordering (§19.4, 9 elements...) is implemented once as
// a shared 'report model' ... so the ordering discipline (errors before
// trace detail, etc.) is enforced by the shared model, not re-implemented
// per renderer."
//
// Built ONLY from a RunRecord (architecture §9.1: "Every renderer reads
// only RunRecord plus its embedded trace/artifacts/snapshot — no renderer
// queries the store directly for anything not already on the RunRecord").
// Callers MUST pass an already-redacted RunRecord — see redact.ts; this
// module does no redaction itself, keeping it a pure, redaction-agnostic
// structuring step reusable by every renderer.
import type { Artifact, RunRecord, StepStatus, StepTrace, TrustMode } from "@aart/types";

export interface ReportModelFailure {
  stepId: string;
  block: string;
  error: string;
}

export interface ReportModelStepSummary {
  stepId: string;
  block: string;
  status: StepStatus;
  durationMs?: number;
}

/**
 * "Eval/correction links" (spec §19.4 element 8) — deliberately a POINTER,
 * not embedded eval/correction data. RunRecord carries no eval-run or
 * correction references of its own (those live in separate @aart/store
 * collections keyed by runId — Correction/EvalRun/EvalExample are not
 * fields on RunRecord), and architecture §9.1 requires every renderer to
 * read *only* RunRecord. A renderer/consumer that wants the actual
 * eval/correction records uses this runId to query @aart/store's
 * evals/corrections members itself (e.g. @aart/dashboard, architecture
 * §13.2's "third client" of evidence's own functions).
 */
export interface ReportModelLinks {
  runId: string;
}

/**
 * The shared intermediate structure every text-producing renderer builds
 * from (architecture §9.3). Field declaration order below IS the §19.4
 * ordering discipline (1. headline, 2. approval/trust status, 3.
 * trigger/source, 4. steps summary, then A74's workflow-level public
 * outputs before 5. errors/failures, 6. artifacts, 7. screenshots, 8.
 * eval/correction links, and 9. full trace expandable). Renderers that emit
 * sections in this object's field order get the ordering guarantee
 * structurally, not by convention.
 */
export interface ReportModel {
  headline: { status: RunRecord["status"]; label: string };
  approval: { approved: boolean; mode: TrustMode };
  trigger: { type: string; source: string; receivedAt: string; correlationId?: string };
  stepsSummary: ReportModelStepSummary[];
  outputs: Record<string, unknown>;
  failures: ReportModelFailure[];
  artifacts: Artifact[];
  screenshots: Artifact[];
  links: ReportModelLinks;
  fullTrace: StepTrace[];
  workflowId: string;
  workflowVersion: string;
  runId: string;
}

const HEADLINE_LABELS: Record<RunRecord["status"], string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  completed: "Passed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Builds the shared report model from an (already-redacted) RunRecord. */
export function buildReportModel(run: RunRecord): ReportModel {
  const failures: ReportModelFailure[] = run.trace
    .filter((t) => t.status === "failed")
    .map((t) => ({ stepId: t.stepId, block: t.block, error: t.error ?? "Step failed with no recorded error message." }));
  if (run.status === "failed" && run.error && failures.length === 0) {
    failures.push({
      stepId: "$workflow",
      block: run.error.startsWith("Workflow output mapping failed:") ? "workflow.outputMapping" : "workflow",
      error: run.error,
    });
  }

  return {
    headline: { status: run.status, label: HEADLINE_LABELS[run.status] },
    approval: { approved: run.approved, mode: run.approvalMode },
    trigger: {
      type: run.trigger.type,
      source: run.trigger.source,
      receivedAt: run.trigger.receivedAt,
      correlationId: run.trigger.correlationId,
    },
    stepsSummary: run.trace.map((t) => ({ stepId: t.stepId, block: t.block, status: t.status, durationMs: t.durationMs })),
    outputs: run.outputs ?? {},
    failures,
    artifacts: run.artifacts,
    screenshots: run.artifacts.filter((a) => a.kind === "screenshot"),
    links: { runId: run.runId },
    fullTrace: run.trace,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    runId: run.runId,
  };
}
