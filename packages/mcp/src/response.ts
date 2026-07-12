// The shared response-affordance envelope — architecture §10.2 (§32.2c).
// `[DECISION]` (architecture §10.2): implemented as a shared response-
// envelope wrapper every tool handler returns through — `{
// ...toolSpecificResult, next: string }` — computed by a small state-lookup
// (given the tool that just ran and whether it succeeded/failed, what's the
// canonical next tool in the authoring loop) rather than each handler
// hand-writing its own `next` string, so the affordance chain stays
// consistent as tools are added.
//
// NEXT_TABLE below is this session's own design fill for the *exact* prose
// of each (tool, outcome) pair — neither spec nor architecture enumerates
// all 42 (21 tools x success/failure) strings, only the single worked
// example ("Draft registered. Next: `aart_validate`.", architecture §10.2 /
// §32.2c) that aart_register_block's own success entry reproduces exactly.
// Every other entry follows the same "name the next authoring-loop tool by
// its real MCP name" pattern, ordered along the loop spec §32.2d/§34
// describes: discover -> draft/register -> validate -> run/verify -> report
// -> approve/promote -> deploy/trigger -> wait/resume, with corrections/evals
// branching off wherever a run fails.

export const TOOL_NAMES = [
  "aart_find_blocks",
  "aart_get_block",
  "aart_validate",
  "aart_register_block",
  "aart_run_workflow",
  "aart_get_report",
  "aart_verify",
  "aart_approve",
  "aart_request_approval",
  "aart_record_correction",
  "aart_list_blocks",
  "aart_get_schema",
  "aart_propose_workflow",
  "aart_diff_workflow",
  "aart_create_eval_from_correction",
  "aart_run_eval",
  "aart_promote_workflow",
  "aart_deploy_workflow",
  "aart_deploy",
  "aart_trigger_workflow",
  "aart_list_waiting_runs",
  "aart_resume_run",
  // D2b "remote reads" (AMENDMENTS.md, this session) — the READ half of
  // letting an authoring agent SEE a deployed server (D1's "remotes +
  // push," AMENDMENTS.md A56, shipped the WRITE half). The write-against-
  // remote half (aart_remote_approve) is deferred to Wave 2, not built here.
  "aart_remote_status",
  "aart_remote_why",
  "aart_remote_runs",
  "aart_remote_run",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
export type ToolTier = "core" | "extended";

// architecture §10.1's verbatim core/extended split (spec Fix C).
export const TOOL_TIERS: Readonly<Record<ToolName, ToolTier>> = {
  aart_find_blocks: "core",
  aart_get_block: "core",
  aart_validate: "core",
  aart_register_block: "core",
  aart_run_workflow: "core",
  aart_get_report: "core",
  aart_verify: "core",
  aart_approve: "core",
  aart_request_approval: "core",
  aart_record_correction: "core",
  aart_list_blocks: "extended",
  aart_get_schema: "extended",
  aart_propose_workflow: "extended",
  aart_diff_workflow: "extended",
  aart_create_eval_from_correction: "extended",
  aart_run_eval: "extended",
  aart_promote_workflow: "extended",
  aart_deploy_workflow: "extended",
  // D1 "remotes + push" (AMENDMENTS.md A56) — registers unconditionally in
  // every trust mode, same as the other 6 non-data-gated extended tools
  // (tools/server.ts's own doc comment: "no data-existence precondition
  // named anywhere in either source document"). Deliberately NOT added to
  // ENVIRONMENT_GATED_TOOLS (tools/server.ts) — a real Environment existing
  // LOCALLY has no bearing on whether a REMOTE push is possible; server-side
  // enforcement (the remote's own AART_DEPLOY_TOKEN gate, deploy-token.ts)
  // is the actual chokepoint, per this session's own ratified design.
  aart_deploy: "extended",
  aart_trigger_workflow: "extended",
  aart_list_waiting_runs: "extended",
  aart_resume_run: "extended",
  // D2b "remote reads" (AMENDMENTS.md, this session) — extended, same tier
  // as every other remote/deploy-adjacent tool (aart_deploy included);
  // gated on >=1 configured remote existing (REMOTE_GATED_TOOLS,
  // tools/server.ts), the same progressive-disclosure SHAPE
  // ENVIRONMENT_GATED_TOOLS/EVAL_SUITE_GATED_TOOLS already use, not a hard
  // mode gate like aart_approve's.
  aart_remote_status: "extended",
  aart_remote_why: "extended",
  aart_remote_runs: "extended",
  aart_remote_run: "extended",
};

export type ToolOutcome = "success" | "failure";

const NEXT_TABLE: Readonly<Record<ToolName, Readonly<Record<ToolOutcome, string>>>> = {
  aart_find_blocks: {
    success: "Review the matching blocks, then draft a workflow using them and call `aart_register_block`.",
    failure: "No matching blocks found — broaden the query, or call `aart_list_blocks` to see the full catalog.",
  },
  aart_get_block: {
    success: "Use this block's inputSchema/outputSchema to wire it into a step, then call `aart_register_block`.",
    failure: "Unknown block id — call `aart_find_blocks` or `aart_list_blocks` to find the correct id.",
  },
  aart_validate: {
    success: "Workflow is valid. Call `aart_run_workflow` to execute it, or `aart_verify` for a quick one-shot check.",
    failure: "Fix the reported findings (see `correctedSnippet`/`didYouMean` where present) and call `aart_validate` again.",
  },
  aart_register_block: {
    success: "Draft registered. Next: `aart_validate`.",
    failure: "Registration failed — fix the reported error and call `aart_register_block` again.",
  },
  aart_run_workflow: {
    success: "Call `aart_get_report` for the full evidence report, or `aart_list_waiting_runs` if the run is waiting.",
    failure: "Run did not complete successfully — inspect the trace/error, call `aart_validate` to confirm the workflow is valid, then try again.",
  },
  aart_get_report: {
    success: "Report retrieved. If the run failed, call `aart_record_correction` for any fixable output; if it passed, consider `aart_promote_workflow`.",
    failure: "Run not found — check the `runId`, or call `aart_list_waiting_runs` to see active runs.",
  },
  aart_verify: {
    success: "Verification passed. If this should become a repeatable check, call `aart_register_block` to save it as a workflow.",
    failure: "Verification failed — inspect the report's `failures`, fix the underlying issue, and call `aart_verify` again.",
  },
  aart_approve: {
    success: "Decision recorded. Call `aart_run_workflow` or `aart_promote_workflow` to proceed.",
    failure: "Approval could not be recorded — check the `taskId`, or call `aart_request_approval` first if none exists.",
  },
  aart_request_approval: {
    success: "Approval requested. Ask the user to confirm in chat, then call `aart_approve` where it's registered — in `strict`/`production` mode, direct them to the CLI or dashboard instead.",
    failure: "Could not create the approval request — check the `workflowId`/`workflowVersion` and try again.",
  },
  aart_record_correction: {
    success: "Correction recorded. Call `aart_create_eval_from_correction` to turn it into a regression check.",
    failure: "Could not record the correction — check the `runId`/`stepId` and try again.",
  },
  aart_list_blocks: {
    success: "Pick a block and call `aart_get_block` for its exact input/output schema.",
    failure: "Could not list blocks — this should not normally fail; check the catalog wiring.",
  },
  aart_get_schema: {
    success: "Use this schema to shape your draft, then call `aart_register_block`.",
    failure: "Unknown schema target — call `aart_list_blocks` or `aart_find_blocks` to find a valid id.",
  },
  aart_propose_workflow: {
    success: "Instantiate the returned skeleton with your specific values, then call `aart_register_block`.",
    failure: "No matching recipe — call `aart_find_blocks` and compose a workflow from scratch.",
  },
  aart_diff_workflow: {
    success: "Review the risk diff — if risk increased, call `aart_request_approval` before promoting.",
    failure: "Could not diff — check that both workflow versions exist.",
  },
  aart_create_eval_from_correction: {
    success: "Eval example created. Call `aart_run_eval` to check it against the current workflow version.",
    failure: "Could not create the eval example — check that the correction (`runId`/`stepId`) exists.",
  },
  aart_run_eval: {
    success: "Eval run recorded. If it passed, call `aart_promote_workflow`; if it regressed, revise the workflow and re-run.",
    failure: "Eval run failed to execute — check the `suiteId` and `workflowId`/`workflowVersion`.",
  },
  aart_promote_workflow: {
    success: "Promoted. Call `aart_deploy_workflow` to ship it to an environment.",
    failure: "Not promoted — required gates are unmet. Check which gates are pending/failed and satisfy them first.",
  },
  aart_deploy_workflow: {
    success: "Deployed. Call `aart_trigger_workflow` to run it, or use the CLI's `aart trigger add` to wire a real trigger.",
    failure: "Deployment refused — check promotion/gate status for this environment (`aart_diff_workflow` / `aart_promote_workflow`).",
  },
  aart_deploy: {
    success: "Pushed. If this was a --plan preview, review it and call `aart_deploy` again without `plan` to actually ingest; otherwise call `aart_trigger_workflow` once the remote promotes it live.",
    failure: "Push refused — check the remote is configured (`aart remote list`) and reachable, and that the remote's own error names what to fix.",
  },
  aart_trigger_workflow: {
    success: "Triggered. Call `aart_get_report` or `aart_list_waiting_runs` to follow the run.",
    failure: "Trigger failed — check the `workflowId` is deployed, or the signal `name`/`correlationId` if resuming.",
  },
  aart_list_waiting_runs: {
    success: "Pick a waiting run and call `aart_resume_run` (or `aart_approve` for a `human.approval` wait).",
    failure: "Could not list waiting runs — this should not normally fail.",
  },
  aart_resume_run: {
    success: "Resumed. Call `aart_get_report` to see how the run continued.",
    failure: "No matching wait found — call `aart_list_waiting_runs` to see what's actually pending.",
  },
  aart_remote_status: {
    success: "Review the local-vs-remote diff. If versions or gates differ, that's real drift — `aart push`/`aart_deploy` an updated version, or call `aart_remote_why` on a specific remote for the full story on what's actually live and why.",
    failure: "Could not check status — register the workflow locally first (`aart_register_block`, then `aart_validate`) if it doesn't exist yet.",
  },
  aart_remote_why: {
    success: "If nothing is live yet, push it (`aart_deploy`/`aart push`) and promote it on the remote. If it IS live, call `aart_remote_runs` to see recent runs of it.",
    failure: "Could not explain what's live — check the remote is configured (`aart remote list`) and reachable.",
  },
  aart_remote_runs: {
    success: "Pick a run and call `aart_remote_run` for its full evidence report.",
    failure: "Could not list runs — check the remote is configured (`aart remote list`) and reachable.",
  },
  aart_remote_run: {
    success: "Report retrieved. If the run failed, fix the workflow locally, `aart_validate`/`aart_run_workflow` to confirm the fix, then push a corrected version.",
    failure: "Run not found on that remote — call `aart_remote_runs` to see what's actually there.",
  },
};

export function computeNext(tool: ToolName, outcome: ToolOutcome): string {
  return NEXT_TABLE[tool][outcome];
}

/** Every handler returns this shape; `ok` is what `wrapResult` reads to pick success/failure from NEXT_TABLE. */
export type HandlerResult = { ok: boolean } & Record<string, unknown>;

/**
 * The shared envelope wrapper (architecture §10.2's `[DECISION]`):
 * `{ ...toolSpecificResult, next: string }`. Every MCP tool call and every
 * CLI command that exposes a `next` hint (§32.2c is an MCP/model-facing
 * concern primarily, but nothing about the table above is MCP-specific, so
 * the CLI's JSON output mode reuses it too — see packages/cli's commands).
 */
export function wrapResult<T extends HandlerResult>(tool: ToolName, result: T): T & { next: string } {
  return { ...result, next: computeNext(tool, result.ok ? "success" : "failure") };
}
