// The flagged-run clear action (architecture §4.1/§4.7/§6.2/§13.3, F3 fix)
// — "S2 exposes the write path that clears a RunFlag (sets clearedBy/
// clearedAt on the existing flag rather than deleting it), callable from
// dashboard/CLI only — deliberately NOT an MCP tool (architecture §13.3's
// stated exception to §13.2's three-client principle: un-flagging a
// poison/reclaim-exhausted run stays a human judgment call, not an
// agent-surfaced action)."
//
// This is a plain exported function, not wired into any MCP tool registry
// (there is none in this package — @aart/mcp is S5's). @aart/cli and
// @aart/dashboard (S5/S8) are expected to call this directly for their
// "clear flag" actions; neither should reimplement the write themselves.
import type { AartStore } from "@aart/store";
import type { RunRecord } from "@aart/types";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";

export type ClearRunFlagResult =
  | { kind: "cleared"; run: RunRecord }
  | { kind: "not_found" }
  | { kind: "no_flag" };

/**
 * Clears `runId`'s flag. Per this session's DoD: leaves `status: "failed"`
 * unchanged (clearing is not the same as re-running) and leaves the flag
 * record itself in place with `clearedBy`/`clearedAt` populated, not
 * removed — the flag's history stays part of the audit trail.
 */
export async function clearRunFlag(store: AartStore, runId: string, clearedBy: string, clock: Clock = systemClock): Promise<ClearRunFlagResult> {
  const run = await store.runs.get(runId);
  if (!run) return { kind: "not_found" };
  if (!run.flag || run.flag.clearedAt) return { kind: "no_flag" };
  const updated: RunRecord = {
    ...run,
    flag: { ...run.flag, clearedBy, clearedAt: clock.nowIso() },
  };
  await store.runs.put(updated);
  return { kind: "cleared", run: updated };
}

/** Lists every run currently carrying an unresolved flag — backs the §13.3 production-dashboard "flagged runs" view (reclaim-exhausted/poison, architecture §4.1/§4.7/§6.2). */
export async function listFlaggedRuns(store: AartStore): Promise<RunRecord[]> {
  const all = await store.runs.list({ status: "failed" });
  return all.filter((r) => r.flag && !r.flag.clearedAt);
}
