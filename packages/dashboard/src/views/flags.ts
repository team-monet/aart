// Flagged runs (v3 — architecture §13.3, F3 fix).
//
// LOAD-BEARING: this is the one dashboard action with a stated MCP
// exclusion (architecture §13.3's stated exception to §13.2's three-client
// principle — clearing a poison/reclaim-exhausted flag stays a human
// judgment call, dashboard + CLI only, never an MCP tool). This module
// exposes no MCP-facing anything — it's wired only into this package's own
// HTTP router (server.ts) — which IS the enforcement of that exclusion:
// there is simply no code path here an MCP tool registry could call into.
//
// AMENDMENTS.md A47: the clear-flag WRITE (`clearFlagAction`, formerly
// here) is deleted — `server.ts`'s `POST /flagged-runs/:runId/clear` route
// now calls `api.clearRunFlag` directly, a thin proxy to `@aart/server`'s
// own already-real `POST /runs/:runId/flag/clear` (`packages/server/src/flags.ts`'s
// `clearRunFlag`) — this action was ALREADY real server-side before this
// session; only the dashboard's own store-direct call site needed fixing.
import type { RunRecord } from "@aart/types";
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
