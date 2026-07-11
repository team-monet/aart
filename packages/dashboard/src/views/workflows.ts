// Workflows (v1 — list), workflow detail + view risk diff (v1/v2 read
// pages — architecture §13.2).
//
// S2's `GET /workflows` returns bare `{ workflowIds: string[] }` — the list
// page (v1, "reads via S2's API") uses that for its primary enumeration.
// The detail page USED TO read the full Workflow record directly via
// `store.workflows.getLatest`, bypassing the API boundary entirely — SEAMS.md
// flagged this as a possible future enrichment, then a later pass
// re-verified it as "not a gap needing S9 to close." A real founder test
// drive proved that call wrong: the dashboard process's own directly-
// constructed `AartStore` handle silently pointed at the wrong `.aart`
// directory (a copy-pasted, never-substituted placeholder path in
// TEST-DRIVE.md's example launch script) while the list page, reading
// through the real running `aart server`'s HTTP API, showed correct data —
// workflow detail 404'd on a workflow that demonstrably existed (root
// AMENDMENTS.md A43). S2's route is now enriched (`GET /workflows/:id`,
// `packages/server/src/http/server.ts`) and this page reads through
// `ApiClient` like every other v1 page — the dashboard no longer needs a
// second, independently-configured store handle to render this page at
// all, closing off that whole failure mode rather than patching around it.
//
// AMENDMENTS.md A47: the approve/deprecate + promote WRITES
// (`approveOrDeprecateAction`/`promoteAction`, formerly here) are deleted —
// `server.ts`'s `POST /workflows/:id/approve`/`/promote` routes now call
// `api.approveOrDeprecateWorkflow`/`api.promoteWorkflow` directly, thin
// proxies to `packages/server/src/workflow-actions.ts`/`promotion.ts`'s
// real implementations.
import type { SemanticRiskDiff } from "@aart/governance";
import type { RunRecord, Workflow } from "@aart/types";
import { escapeHtml, form, hiddenField, page, table, textField } from "../http/html.js";

/** Recent-runs section is capped, not paginated (no "runs page 2" feature requested) — matches this page's existing "small, honest, not over-built" scope. */
const RECENT_RUNS_LIMIT = 20;

export function renderWorkflowsListPage(workflowIds: string[]): string {
  const rows = workflowIds.map((id) => [`<a href="/workflows/${escapeHtml(id)}">${escapeHtml(id)}</a>`]);
  return page("Workflows", table(["Workflow Id"], rows));
}

/**
 * `versions` is whatever `store.workflows.listVersions`/`GET /workflows/:id`
 * returns — ascending, real-semver-aware order (`compareVersions`, both
 * store adapters) — reversed here for "most recent first" display; each
 * links back to this same page with `?version=` so every version is
 * viewable, not just latest. `recentRuns` is unfiltered by version
 * (the workflow's full run history, across every version) and is sorted/
 * capped here rather than by the caller, matching `renderBlocksPage`'s own
 * "the view does its own presentation sort" precedent.
 */
export function renderWorkflowDetailPage(workflow: Workflow, versions: readonly string[], recentRuns: readonly RunRecord[]): string {
  const gateRows = Object.entries(workflow.gates).map(([k, v]) => [escapeHtml(k), escapeHtml(v)]);

  const versionRows = [...versions].reverse().map((v) => [
    v === workflow.version
      ? `<strong>${escapeHtml(v)}</strong> (viewing)`
      : `<a href="/workflows/${escapeHtml(workflow.id)}?version=${escapeHtml(v)}">${escapeHtml(v)}</a>`,
  ]);

  const recentRunRows = [...recentRuns]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .slice(0, RECENT_RUNS_LIMIT)
    .map((r) => [`<a href="/runs/${escapeHtml(r.runId)}">${escapeHtml(r.runId)}</a>`, escapeHtml(r.workflowVersion), escapeHtml(r.status), escapeHtml(r.startedAt)]);

  const body = `<p>Version: ${escapeHtml(workflow.version)} — Approval: <strong>${escapeHtml(workflow.approval)}</strong>${workflow.promotionBlocked ? " (promotion blocked)" : ""}${workflow.needsReview ? " (needs review)" : ""}</p>
${table(["Gate", "Status"], gateRows)}

<h2>Versions</h2>
${table(["Version"], versionRows)}

<h2>Recent Runs</h2>
${recentRunRows.length > 0 ? table(["Run", "Version", "Status", "Started"], recentRunRows) : "<p>No runs yet.</p>"}

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

