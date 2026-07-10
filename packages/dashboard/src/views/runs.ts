// Runs, Run detail (v1 — architecture §13.1), Artifacts (v1, derived from
// runs — no dedicated S2 HTTP route is documented, so this page aggregates
// `RunRecord.artifacts` across `listRuns()`, which IS documented), Waiting
// runs (v2 — architecture §13.2's "inspect waiting runs", surfacing wait
// AGE per architecture §4.4.1's `[DECISION]`), and the "trigger workflow"
// (v2) writable action.
import type { AartStore } from "@aart/store";
import type { RunRecord, RunStatus } from "@aart/types";
import type { WaitingRunEntry } from "../api-client.js";
import type { DashboardDeps, TriggerRunInput } from "../deps.js";
import { escapeHtml, form, page, table, textField } from "../http/html.js";

export function renderRunsListPage(runs: RunRecord[]): string {
  const rows = runs.map((r) => [
    `<a href="/runs/${escapeHtml(r.runId)}">${escapeHtml(r.runId)}</a>`,
    escapeHtml(r.workflowId),
    escapeHtml(r.workflowVersion),
    escapeHtml(r.status),
    escapeHtml(r.startedAt),
    r.flag && !r.flag.clearedAt ? `<strong>${escapeHtml(r.flag.kind)}</strong>` : "",
  ]);
  const body = `${table(["Run", "Workflow", "Version", "Status", "Started", "Flag"], rows)}
<p><a href="/runs/trigger">Trigger a workflow</a></p>`;
  return page("Runs", body);
}

export function renderRunDetailPage(run: RunRecord, reportHtml: string): string {
  return page(`Run ${run.runId}`, reportHtml);
}

export function renderArtifactsPage(runs: RunRecord[]): string {
  const rows = runs.flatMap((r) => r.artifacts.map((a) => [escapeHtml(a.id), escapeHtml(a.name), escapeHtml(a.kind), escapeHtml(a.mime), `${a.bytes}`, `<a href="/runs/${escapeHtml(r.runId)}">${escapeHtml(r.runId)}</a>`]));
  return page("Artifacts", table(["Id", "Name", "Kind", "Mime", "Bytes", "Run"], rows));
}

/** `now - createdAt`, human-scale ("Ns" / "Nm" / "Nh" / "Nd") — the staleness signal architecture §4.4.1's `[DECISION]` requires alongside every waiting run. */
export function formatAge(ms: number): string {
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function renderWaitingRunsPage(waits: WaitingRunEntry[], now: Date): string {
  const rows = waits.map((w) => {
    const age = formatAge(now.getTime() - new Date(w.createdAt).getTime());
    return [`<a href="/runs/${escapeHtml(w.runId)}">${escapeHtml(w.runId)}</a>`, escapeHtml(w.stepId), escapeHtml(w.wait.type), escapeHtml(w.createdAt), `<strong>${escapeHtml(age)}</strong>`];
  });
  return page("Waiting Runs", table(["Run", "Step", "Wait type", "Since", "Age"], rows));
}

export function renderTriggerFormPage(workflowIds: string[]): string {
  const options = workflowIds.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
  const body = `${form(
    "/runs/trigger",
    `<label>Workflow: <select name="workflowId">${options}</select></label><br>
${textField("workflowVersion", "Version")}
${textField("inputs", "Inputs (JSON)", "{}")}
${textField("environment", "Environment (optional)")}`,
    "Trigger",
  )}`;
  return page("Trigger Workflow", body);
}

export interface TriggerWorkflowParams {
  workflowId: string;
  workflowVersion: string;
  inputs: Record<string, unknown>;
  environment?: string;
}

/**
 * The "trigger workflow" (§35.2) action: resolves the target Workflow
 * (already-authored, already `store.workflows.put` by whichever authoring
 * flow created it — this action never authors a Workflow itself), then
 * calls the injected `deps.triggerRun` — the SAME bound `Engine.triggerRun`
 * a CLI `aart run`/MCP `aart_trigger_workflow` call would use.
 */
export async function triggerWorkflowAction(deps: DashboardDeps, store: AartStore, params: TriggerWorkflowParams): Promise<RunRecord> {
  const workflow = await store.workflows.get(params.workflowId, params.workflowVersion);
  if (!workflow) throw new Error(`workflow not found: ${params.workflowId}@${params.workflowVersion}`);
  const input: TriggerRunInput = {
    workflow,
    trigger: { type: "manual", id: `dashboard-${Date.now()}`, source: "dashboard", payload: {}, receivedAt: new Date().toISOString() },
    inputs: params.inputs,
    environment: params.environment,
  };
  return deps.triggerRun(input);
}

export function listRunsFilterFromQuery(query: URLSearchParams): { status?: RunStatus; workflowId?: string } {
  const status = query.get("status");
  const workflowId = query.get("workflowId");
  const filter: { status?: RunStatus; workflowId?: string } = {};
  if (status) filter.status = status as RunStatus;
  if (workflowId) filter.workflowId = workflowId;
  return filter;
}
