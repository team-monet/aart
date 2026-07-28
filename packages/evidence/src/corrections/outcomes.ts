// outcomes.ts — the SIX distinct, separately-callable correction outcomes
// (spec §23.4, architecture §9.4). "[DECISION] each implemented as an
// explicit, separately-callable action (not automatic side effects of
// recording a correction), because the spec lists them as things a
// correction *can* do, not things it *always* does." Recording a Correction
// (correction.ts) never triggers any of these automatically.
import type { AartStore } from "@aart/store";
import type { Correction, EvalExample, ImprovementBrief, RunRecord, StepTrace, Workflow } from "@aart/types";
import {
  materializeWorkflowOutputs,
  resolveWorkflowForRun,
  validateWorkflowOutputs,
} from "@aart/engine/workflow-output-contract";
import { generateImprovementBrief } from "../improvement-brief.js";
import { correctionKey } from "./correction.js";

/** Sets a dot-path (e.g. "outputs.nmi") on a plain object, creating intermediate objects as needed. */
function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const next = cursor[key];
    if (typeof next !== "object" || next === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/**
 * Outcome 1/6 — "update current run output" (spec §23.4). Writes
 * `correction.corrected` into the target StepTrace at `correction.fieldPath`
 * (a dot-path relative to the StepTrace itself, e.g. "outputs.nmi" per spec
 * §23.3's own example) and flags that trace `postHocCorrected: true`
 * (architecture §5.3 `step_traces.post_hoc_corrected`, F5 fix).
 */
export async function updateRunOutput(store: AartStore, correction: Correction): Promise<RunRecord> {
  const run = await store.runs.get(correction.runId);
  if (!run) throw new Error(`updateRunOutput: no such run "${correction.runId}"`);
  // A step may have more than one trace after a loop/back-edge or reclaim.
  // Expression projection uses the latest matching trace, so corrections
  // without an explicit sequence target that same observable occurrence.
  const traceIndex = run.trace.findLastIndex((t) => t.stepId === correction.stepId);
  if (traceIndex === -1) throw new Error(`updateRunOutput: run "${correction.runId}" has no step "${correction.stepId}"`);

  const original = run.trace[traceIndex]!;
  const updatedTrace: StepTrace = { ...original, postHocCorrected: true };
  setByPath(updatedTrace as unknown as Record<string, unknown>, correction.fieldPath, correction.corrected);

  const trace = run.trace.map((t, i) => (i === traceIndex ? updatedTrace : t));
  let outputs = run.outputs;
  // Failed/cancelled runs are intentionally partial evidence: correcting a
  // trace must remain possible even when required output sources never ran.
  // Only a completed run promises a fully materialized public contract.
  if (run.status === "completed") {
    const workflow = await resolveWorkflowForRun(store, run);
    const correctedProjection = { ...run, trace };
    if (workflow.execution.outputMapping) {
      outputs = await materializeWorkflowOutputs(workflow, correctedProjection);
      validateWorkflowOutputs(workflow, outputs);
    }
  }

  const updatedRun: RunRecord = {
    ...run,
    trace,
    outputs,
    updatedAt: new Date().toISOString(),
  };
  await store.runs.put(updatedRun);
  return updatedRun;
}

export interface CreateEvalExampleOptions {
  id?: string;
  tags?: string[];
  scorerConfig?: unknown;
}

/**
 * Outcome 2/6 — "create eval example" (spec §23.4). `createdFromCorrection`
 * is set to `correctionKey(correction)` (Correction has no `id` of its own
 * — see correction.ts) and lives on EvalExample, not on Correction
 * (architecture §9.7's predicate-direction note). Field-level regression
 * shape: `input` captures what the step actually (wrongly) produced,
 * `expected` is the human's fix.
 */
export async function createEvalExampleFromCorrection(
  store: AartStore,
  correction: Correction,
  suiteId: string,
  options: CreateEvalExampleOptions = {},
): Promise<EvalExample> {
  const example: EvalExample = {
    id: options.id ?? `ex_${correctionKey(correction).replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`,
    suiteId,
    sourceRunId: correction.runId,
    input: { stepId: correction.stepId, fieldPath: correction.fieldPath, observed: correction.observed },
    expected: correction.corrected,
    scorerConfig: options.scorerConfig,
    tags: options.tags ?? ["correction"],
    createdFromCorrection: correctionKey(correction),
  };
  await store.evals.putExample(example);
  return example;
}

/**
 * Outcome 3/6 — "create issue for agent" (spec §23.4). Architecture §9.4:
 * "out of scope for a specific tracker integration in v1... emits a
 * structured ImprovementBrief-shaped notification an agent can pick up via
 * MCP, rather than assuming a specific issue tracker" — scoped to just THIS
 * ONE correction (contrast with outcome 4, which aggregates across the
 * whole workflow version).
 */
export async function createIssueForAgent(store: AartStore, correction: Correction): Promise<ImprovementBrief> {
  const run = await store.runs.get(correction.runId);
  if (!run) throw new Error(`createIssueForAgent: no such run "${correction.runId}"`);
  return {
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    problemSummary: `Correction recorded on step "${correction.stepId}": ${correction.reason}`,
    failedEvalIds: [],
    corrections: [{ summary: correction.reason, sourceRunId: correction.runId, fieldPath: correction.fieldPath }],
    constraints: [],
  };
}

/**
 * Outcome 4/6 — "trigger workflow improvement proposal" (spec §23.4).
 * Assembles the FULL ImprovementBrief (spec §25.2 / architecture §9.7) —
 * every failed eval example plus every not-yet-referenced correction for
 * this workflow VERSION, not just one correction (contrast with outcome 3).
 */
export async function triggerImprovementProposal(
  store: AartStore,
  workflowId: string,
  workflowVersion: string,
  options: { constraints?: string[] } = {},
): Promise<ImprovementBrief> {
  return generateImprovementBrief(store, workflowId, workflowVersion, options);
}

async function setPromotionBlocked(store: AartStore, workflowId: string, workflowVersion: string, blocked: boolean): Promise<Workflow> {
  const workflow = await store.workflows.get(workflowId, workflowVersion);
  if (!workflow) throw new Error(`setPromotionBlocked: no such workflow "${workflowId}@${workflowVersion}"`);
  const updated: Workflow = { ...workflow, promotionBlocked: blocked };
  await store.workflows.put(updated);
  return updated;
}

/**
 * Outcome 5/6 — "block promotion" (spec §23.4, architecture §9.4/§7.1
 * enforcement-gap closure). Durably sets `workflows.promotion_blocked`
 * (architecture §5.3) on the target workflow version. @aart/governance's
 * `computePromotionState` (S4) is the OTHER half of this contract — it
 * refuses to promote while this flag is true, regardless of gate state;
 * @aart/evidence owns only the write, tested here.
 */
export async function blockPromotion(store: AartStore, workflowId: string, workflowVersion: string): Promise<Workflow> {
  return setPromotionBlocked(store, workflowId, workflowVersion, true);
}

/** Natural complement to blockPromotion — NOT one of the spec's 6 named correction outcomes, but the only way to reverse one (mirrors architecture's own clearedBy/clearedAt pattern for RunFlag, §4.1). */
export async function unblockPromotion(store: AartStore, workflowId: string, workflowVersion: string): Promise<Workflow> {
  return setPromotionBlocked(store, workflowId, workflowVersion, false);
}

async function setNeedsReview(store: AartStore, workflowId: string, workflowVersion: string, needsReview: boolean): Promise<Workflow> {
  const workflow = await store.workflows.get(workflowId, workflowVersion);
  if (!workflow) throw new Error(`setNeedsReview: no such workflow "${workflowId}@${workflowVersion}"`);
  const updated: Workflow = { ...workflow, needsReview };
  await store.workflows.put(updated);
  return updated;
}

/**
 * Outcome 6/6 — "mark workflow version as needs review" (spec §23.4).
 * Writes `workflows.needs_review` (architecture §5.3, F5 fix). Distinct
 * axis from ApprovalTask.status — see spec §23.4's own vocabulary note.
 */
export async function markNeedsReview(store: AartStore, workflowId: string, workflowVersion: string): Promise<Workflow> {
  return setNeedsReview(store, workflowId, workflowVersion, true);
}

/** Natural complement to markNeedsReview — not one of the spec's 6 named outcomes. */
export async function clearNeedsReview(store: AartStore, workflowId: string, workflowVersion: string): Promise<Workflow> {
  return setNeedsReview(store, workflowId, workflowVersion, false);
}
