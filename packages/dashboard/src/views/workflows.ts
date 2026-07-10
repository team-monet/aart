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
import type { SemanticRiskDiff } from "@aart/governance";
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

/**
 * Renders @aart/governance's real `SemanticRiskDiff` (S9 integration,
 * reconciliation ledger item 13 — replaces the former `computeSimpleStepDiff`/
 * `StepDiff`, a structural added/removed-block-id approximation whose own
 * doc comment called itself "a deliberately SIMPLIFIED stand-in... until the
 * real capability-closure-based diff can be wired in"; see deps.ts's
 * `SemanticRiskDiffFn` doc comment for the real wiring). Surfaces every
 * field spec §17.4/architecture's real risk diff defines: added/removed/
 * modified steps, whether the capability set changed at all, the newly
 * introduced capabilities/secrets/domains, and the risk-tier transition.
 */
export function renderRiskDiffPage(workflowId: string, fromVersion: string, toVersion: string, diff: SemanticRiskDiff): string {
  const body = `<p>${escapeHtml(workflowId)}: ${escapeHtml(fromVersion)} → ${escapeHtml(toVersion)}</p>
<p>Risk: <strong>${escapeHtml(diff.riskFrom)} → ${escapeHtml(diff.riskTo)}</strong>${diff.riskIncreased ? " (increased)" : ""}${diff.capabilityChanged ? " — capability set changed" : ""}</p>
<h2>Added steps</h2>
<ul>${diff.added.map((s) => `<li>${escapeHtml(s.stepId)} (${escapeHtml(s.uses)})</li>`).join("")}</ul>
<h2>Removed steps</h2>
<ul>${diff.removed.map((s) => `<li>${escapeHtml(s.stepId)} (${escapeHtml(s.uses)})</li>`).join("")}</ul>
<h2>Modified steps</h2>
<ul>${diff.modified.map((s) => `<li>${escapeHtml(s.stepId)}${s.details.length > 0 ? `: ${s.details.map(escapeHtml).join("; ")}` : ""}</li>`).join("")}</ul>
<h2>New capabilities</h2>
<ul>${diff.newCapabilities.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
<h2>New secrets</h2>
<ul>${diff.newSecrets.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
<h2>New domains</h2>
<ul>${diff.newDomains.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`;
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
