// Workflows (v1 — list), approve/deprecate + promote + view risk diff (v2
// writable/read actions — architecture §13.2).
//
// S2's documented `GET /workflows` returns bare `{ workflowIds: string[] }`
// (SEAMS.md) — no per-workflow name/version/approval/gates. The list page
// (v1, "reads via S2's API") uses that for its primary enumeration; the
// detail page reads the full Workflow record directly via
// `store.workflows.getLatest` since S2 hasn't published a richer HTTP shape
// for it yet — flagged in this package's SEAMS.md as a possible future
// enrichment for S2's own route, not silently worked around.
import type { AartStore } from "@aart/store";
import type { TrustMode, Workflow } from "@aart/types";
import type { DashboardDeps, GateName, PromoteResult } from "../deps.js";
import { escapeHtml, form, hiddenField, page, table, textField } from "../http/html.js";

export function renderWorkflowsListPage(workflowIds: string[]): string {
  const rows = workflowIds.map((id) => [`<a href="/workflows/${escapeHtml(id)}">${escapeHtml(id)}</a>`]);
  return page("Workflows", table(["Workflow Id"], rows));
}

export function renderWorkflowDetailPage(workflow: Workflow): string {
  const gateRows = Object.entries(workflow.gates).map(([k, v]) => [escapeHtml(k), escapeHtml(v)]);
  const body = `<p>Version: ${escapeHtml(workflow.version)} — Approval: <strong>${escapeHtml(workflow.approval)}</strong>${workflow.promotionBlocked ? " (promotion blocked)" : ""}${workflow.needsReview ? " (needs review)" : ""}</p>
${table(["Gate", "Status"], gateRows)}

<h2>Approve / Deprecate</h2>
${form(
  `/workflows/${escapeHtml(workflow.id)}/approve`,
  `${hiddenField("version", workflow.version)}
<label>Action:
  <select name="action"><option value="approve">Approve (recompute from gates)</option><option value="deprecate">Deprecate</option></select>
</label><br>
<label>Trust mode: <select name="trustMode"><option value="dev">dev</option><option value="governed" selected>governed</option><option value="strict">strict</option><option value="production">production</option></select></label><br>`,
  "Submit",
)}

<h2>Promote</h2>
${form(
  `/workflows/${escapeHtml(workflow.id)}/promote`,
  `${hiddenField("version", workflow.version)}
${textField("environmentId", "Environment Id")}`,
  "Promote",
)}

<h2>Risk Diff</h2>
${form(
  `/workflows/${escapeHtml(workflow.id)}/risk-diff`,
  `${textField("fromVersion", "From version")}
${textField("toVersion", "To version", workflow.version)}`,
  "View diff",
)}`;
  return page(`Workflow ${workflow.id}`, body);
}

export interface StepDiff {
  added: string[];
  removed: string[];
}

/**
 * A structural step-list diff between two Workflow versions — added/removed
 * block ids (`WorkflowStep.uses`). This is a deliberately SIMPLIFIED stand-in
 * for architecture §17.4's real semantic risk diff (which needs block-manifest
 * capability closures — S3/S4/S7 real packages, none landed in this
 * worktree). Flagged in SEAMS.md/report: not the real risk diff, a
 * structural approximation "what steps changed" until the real capability-
 * closure-based diff can be wired in.
 */
export function computeSimpleStepDiff(a: Workflow, b: Workflow): StepDiff {
  const aUses = new Set(a.execution.steps.map((s) => s.uses));
  const bUses = new Set(b.execution.steps.map((s) => s.uses));
  return {
    added: [...bUses].filter((u) => !aUses.has(u)),
    removed: [...aUses].filter((u) => !bUses.has(u)),
  };
}

export function renderRiskDiffPage(workflowId: string, fromVersion: string, toVersion: string, diff: StepDiff): string {
  const body = `<p>${escapeHtml(workflowId)}: ${escapeHtml(fromVersion)} → ${escapeHtml(toVersion)}</p>
<h2>Added steps (block ids)</h2>
<ul>${diff.added.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul>
<h2>Removed steps (block ids)</h2>
<ul>${diff.removed.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul>`;
  return page("Risk Diff", body);
}

/** Thin delegate to the injected `computeApprovalState`/`approveOrDeprecateWorkflow` — see deps.ts. */
export async function approveOrDeprecateAction(deps: DashboardDeps, store: AartStore, workflowId: string, version: string, action: "approve" | "deprecate", trustMode: TrustMode): Promise<Workflow> {
  const requiredGates: readonly GateName[] = deps.requiredGatesByTrustMode[trustMode];
  return deps.approveOrDeprecateWorkflow(store, workflowId, version, action, requiredGates);
}

/** Thin delegate to the injected `promoteWorkflowVersionToEnvironment` (internally calls S4's real `evaluatePromotionForEnvironment`) — see deps.ts. */
export async function promoteAction(deps: DashboardDeps, store: AartStore, workflowId: string, version: string, environmentId: string, triggerConfig?: Record<string, unknown>): Promise<PromoteResult> {
  return deps.promoteWorkflowVersionToEnvironment(store, { workflowId, workflowVersion: version, environmentId, triggerConfig });
}
