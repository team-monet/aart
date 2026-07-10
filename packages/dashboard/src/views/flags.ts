// Flagged runs (v3 — architecture §13.3, F3 fix) + the clear action.
//
// LOAD-BEARING: this is the one dashboard action with a stated MCP
// exclusion (architecture §13.3's stated exception to §13.2's three-client
// principle — clearing a poison/reclaim-exhausted flag stays a human
// judgment call, dashboard + CLI only, never an MCP tool). This module
// exposes no MCP-facing anything — it's wired only into this package's own
// HTTP router (server.ts) — which IS the enforcement of that exclusion:
// there is simply no code path here an MCP tool registry could call into.
import type { AartStore } from "@aart/store";
import type { RunRecord } from "@aart/types";
import type { ClearRunFlagResult, DashboardDeps } from "../deps.js";
import { escapeHtml, form, hiddenField, page, table } from "../http/html.js";

export function renderFlaggedRunsPage(runs: RunRecord[]): string {
  const rows = runs.map((r) => [
    `<a href="/runs/${escapeHtml(r.runId)}">${escapeHtml(r.runId)}</a>`,
    escapeHtml(r.workflowId),
    escapeHtml(r.flag?.kind ?? ""),
    escapeHtml(r.flag?.flaggedAt ?? ""),
    form(`/flagged-runs/${escapeHtml(r.runId)}/clear`, `${hiddenField("clearedBy", "dashboard-operator")}`, "Clear flag"),
  ]);
  return page("Flagged Runs", table(["Run", "Workflow", "Flag", "Flagged At", "Action"], rows));
}

/**
 * The clear-flag action: a THIN call to the injected `clearRunFlag` —
 * nothing else. This is deliberately a one-line delegate (not "any function
 * that produces the same effect") so a test can assert the exact reference
 * passed in gets called, and so the S9 merge only needs to change what
 * `deps.clearRunFlag` is bound to, never this function's body.
 */
export async function clearFlagAction(deps: DashboardDeps, store: AartStore, runId: string, clearedBy: string): Promise<ClearRunFlagResult> {
  return deps.clearRunFlag(store, runId, clearedBy);
}
