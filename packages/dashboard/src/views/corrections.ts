// Correction queue (v3) + record correction + the 6 correction outcomes +
// 2 complements (v2/v3 writable actions — S6 seam E4, architecture §13.2).
// Every action here is a one-line delegate to its injected `deps` function
// — see deps.ts's E4 citation block for the exact SEAMS.md-sourced
// signatures each one matches.
import type { AartStore } from "@aart/store";
import type { Correction, EvalExample, ImprovementBrief, RunRecord, Workflow } from "@aart/types";
import type { DashboardDeps, RecordCorrectionInput } from "../deps.js";
import { escapeHtml, form, page, table, textField } from "../http/html.js";

export function renderCorrectionQueuePage(corrections: Correction[]): string {
  const rows = corrections.map((c) => [
    `<a href="/runs/${escapeHtml(c.runId)}">${escapeHtml(c.runId)}</a>`,
    escapeHtml(c.stepId),
    escapeHtml(c.fieldPath),
    escapeHtml(JSON.stringify(c.observed)),
    escapeHtml(JSON.stringify(c.corrected)),
    escapeHtml(c.reason),
    escapeHtml(c.reviewer),
    outcomeButtons(c),
  ]);
  return page("Correction Queue", table(["Run", "Step", "Field", "Observed", "Corrected", "Reason", "Reviewer", "Outcomes"], rows));
}

function outcomeButtons(c: Correction): string {
  const key = encodeURIComponent(`${c.runId}:${c.stepId}:${c.fieldPath}:${c.createdAt}`);
  return `
<form method="post" action="/corrections/${key}/update-run-output"><button type="submit">Update run output</button></form>
<form method="post" action="/corrections/${key}/create-eval-example"><input type="text" name="suiteId" placeholder="suiteId"><button type="submit">Create eval example</button></form>
<form method="post" action="/corrections/${key}/create-issue"><button type="submit">Create issue for agent</button></form>`;
}

export function renderRecordCorrectionFormPage(runId = "", stepId = ""): string {
  const body = form(
    "/corrections",
    `${textField("runId", "Run Id", runId)}
${textField("stepId", "Step Id", stepId)}
${textField("fieldPath", "Field path (e.g. outputs.total)")}
${textField("observed", "Observed (JSON)")}
${textField("corrected", "Corrected (JSON)")}
${textField("reason", "Reason")}
${textField("reviewer", "Reviewer")}`,
    "Record correction",
  );
  return page("Record Correction", body);
}

export async function recordCorrectionAction(deps: DashboardDeps, store: AartStore, input: RecordCorrectionInput): Promise<Correction> {
  return deps.recordCorrection(store, input);
}

export async function updateRunOutputAction(deps: DashboardDeps, store: AartStore, correction: Correction): Promise<RunRecord> {
  return deps.updateRunOutput(store, correction);
}

export async function createEvalExampleFromCorrectionAction(deps: DashboardDeps, store: AartStore, correction: Correction, suiteId: string): Promise<EvalExample> {
  return deps.createEvalExampleFromCorrection(store, correction, suiteId);
}

export async function createIssueForAgentAction(deps: DashboardDeps, store: AartStore, correction: Correction): Promise<ImprovementBrief> {
  return deps.createIssueForAgent(store, correction);
}

export async function triggerImprovementProposalAction(deps: DashboardDeps, store: AartStore, workflowId: string, workflowVersion: string): Promise<ImprovementBrief> {
  return deps.triggerImprovementProposal(store, workflowId, workflowVersion);
}

export async function blockPromotionAction(deps: DashboardDeps, store: AartStore, workflowId: string, workflowVersion: string): Promise<Workflow> {
  return deps.blockPromotion(store, workflowId, workflowVersion);
}

export async function unblockPromotionAction(deps: DashboardDeps, store: AartStore, workflowId: string, workflowVersion: string): Promise<Workflow> {
  return deps.unblockPromotion(store, workflowId, workflowVersion);
}

export async function markNeedsReviewAction(deps: DashboardDeps, store: AartStore, workflowId: string, workflowVersion: string): Promise<Workflow> {
  return deps.markNeedsReview(store, workflowId, workflowVersion);
}

export async function clearNeedsReviewAction(deps: DashboardDeps, store: AartStore, workflowId: string, workflowVersion: string): Promise<Workflow> {
  return deps.clearNeedsReview(store, workflowId, workflowVersion);
}
