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
// every tool's success/failure strings, with the single worked
// example ("Draft registered. Next: `aart_validate`.", architecture §10.2 /
// §32.2c) that aart_register_block's own success entry reproduces exactly.
// Every other entry follows the same "name the next authoring-loop tool by
// its real MCP name" pattern, ordered along the loop spec §32.2d/§34
// describes: discover -> draft/register -> validate -> run/verify -> report
// -> approve/promote -> deploy/trigger -> wait/resume, with corrections/evals
// branching off wherever a run fails.

export const TOOL_NAMES = [
  "aart_find_tools",
  "aart_register_tool",
  "aart_check_tool",
  "aart_run_tool",
  "aart_get_tool_run",
  "aart_list_tool_runs",
  "aart_find_blocks",
  "aart_find_workflows",
  "aart_find_packs",
  "aart_install_pack",
  "aart_list_packs",
  "aart_approve_pack",
  "aart_prepare_pack",
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
  // D2b "remote reads" (AMENDMENTS.md A62) — the READ half of letting an
  // authoring agent SEE a deployed server (D1's "remotes + push,"
  // AMENDMENTS.md A56, shipped the WRITE half). The write-against-remote
  // half (aart_remote_approve) was deferred to Wave 2 there — it follows
  // directly below, now built.
  "aart_remote_status",
  "aart_remote_why",
  "aart_remote_runs",
  "aart_remote_run",
  // Wave 2C (AMENDMENTS.md A65, John-ratified 2026-07-12/13) — the
  // WRITE-against-remote tool D2b (A62) explicitly deferred: approve a
  // paused run / workflow-version gate on a REMOTE aart server, the same
  // decision aart_approve records locally.
  "aart_remote_approve",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
export type ToolTier = "core" | "extended";

// architecture §10.1's verbatim core/extended split (spec Fix C).
export const TOOL_TIERS: Readonly<Record<ToolName, ToolTier>> = {
  aart_find_tools: "core",
  aart_register_tool: "core",
  aart_check_tool: "core",
  aart_run_tool: "core",
  aart_get_tool_run: "core",
  aart_list_tool_runs: "core",
  aart_find_blocks: "core",
  aart_find_workflows: "core",
  aart_find_packs: "core",
  aart_install_pack: "core",
  aart_list_packs: "extended",
  aart_approve_pack: "core",
  aart_prepare_pack: "extended",
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
  // Wave 2C (AMENDMENTS.md A65) — extended, same tier as every other
  // remote/deploy-adjacent tool; gated on BOTH aart_approve's own trust-mode
  // precondition AND REMOTE_GATED_TOOLS' "≥1 configured remote" precondition
  // (tools/server.ts's isToolRegistered — the first tool needing both).
  aart_remote_approve: "extended",
};

export type ToolOutcome = "success" | "failure";

const NEXT_TABLE: Readonly<Record<ToolName, Readonly<Record<ToolOutcome, string>>>> = {
  aart_find_tools: {
    success: "Choose the closest registered local tool. Call `aart_check_tool` with concrete inputs, show its exact hashes and authority summary to the user, then call `aart_run_tool` only after explicit approval.",
    failure: "No reusable local tool matched — check `aart_find_workflows`, then Blocks and public Packs before authoring new logic.",
  },
  aart_register_tool: {
    success: "Local tool registered as a sealed, versioned asset. Call `aart_find_tools` with the task wording to verify it is discoverable in a fresh session.",
    failure: "Registration failed — fix the manifest, executable provenance, or immutable-version conflict, then register again.",
  },
  aart_check_tool: {
    success: "Show the exact command, authority, effects, asset hash, executable hash, argv hash, cwd hash, and prerequisite hashes to the user. After explicit approval, pass those same seals to `aart_run_tool`.",
    failure: "The tool is not ready — fix the reported executable, version, platform, authentication, or input prerequisite and check again.",
  },
  aart_run_tool: {
    success: "Tool completed and its evidence was stored. Call `aart_get_tool_run` with the returned runId to prove the record survives a fresh session.",
    failure: "The tool did not run or did not complete successfully — inspect `ran`, `kind`, prerequisite details, and evidence before retrying.",
  },
  aart_get_tool_run: {
    success: "Use this durable, redacted record as the source of truth for the executable, argv, terminal status, structured output, and mapped evidence.",
    failure: "No durable local-tool run matched that runId — use the runId returned by an execution where `ran` was true.",
  },
  aart_list_tool_runs: {
    success: "Inspect running records after a caller disconnect/restart, and call `aart_get_tool_run` for the exact runId you need.",
    failure: "Could not list durable local-tool runs — check the configured AART root and evidence files.",
  },
  aart_find_blocks: {
    success: "Review the matching blocks, then check `aart_find_workflows` once more before drafting new workflow logic.",
    failure: "No matching blocks found — broaden the query, call `aart_list_blocks`, and check `aart_find_workflows` before building from scratch.",
  },
  aart_find_workflows: {
    success: "Reuse or adapt the closest workflow. Call `aart_get_schema` only for the parts you must change, then register a new version rather than rebuilding unrelated steps.",
    failure: "No reusable workflow matched — call `aart_find_blocks` and `aart_propose_workflow`, then compose the smallest new reusable workflow.",
  },
  aart_find_packs: {
    success: "Choose the closest pack and call `aart_install_pack`; installation is inert and unapproved until a human reviews it.",
    failure: "No public pack matched — broaden the query or author the smallest new pack, then add it to the static public index.",
  },
  aart_install_pack: {
    success: "Pack installed unapproved. Call `aart_list_packs`, show its capabilities/assets to the user, and only then call `aart_approve_pack` after explicit approval.",
    failure: "Pack installation failed — verify the pack name/version or linked source path, then retry. Never bypass the unapproved state.",
  },
  aart_list_packs: {
    success: "Review the installed pack's provenance, assets, and exact content hash; after explicit human approval, pass that same hash to `aart_approve_pack`.",
    failure: "Could not list installed packs — check the configured AART root.",
  },
  aart_approve_pack: {
    success: "Pack approved. Restart/reload AART so approved blocks enter the runtime catalog; imported workflows are registered as drafts and still need normal validation/promotion.",
    failure: "Pack approval failed — inspect the content seal or module/workflow validation error; do not load or execute it.",
  },
  aart_prepare_pack: {
    success: "Pack validated and its static-index entry generated. Publish the npm package with standard npm tooling, then merge this entry into the configured public index.",
    failure: "Pack preparation failed — fix the package name/version, block module shape, workflow definition, or declared asset list before publishing.",
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
  aart_remote_approve: {
    success: "Decision recorded on the remote. Call `aart_remote_why` to confirm the remote's gate/approval state now reflects it, or `aart_remote_status` for the full local-vs-remote picture.",
    failure: "Decision could not be recorded on the remote — check the `taskId`, that the remote is configured (`aart remote list`), and that your token is valid.",
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
  const outcome = result.ok && result.matched !== false ? "success" : "failure";
  const next =
    tool === "aart_find_packs" && outcome === "success" && result.indexMode === "preview"
      ? "These are preview catalog fixtures, not published packages. Prepare and publish a real Pack before offering installation."
      : tool === "aart_find_tools" && outcome === "success" && result.indexMode === "preview"
        ? "These remote tool matches come from preview catalog fixtures, not published packages. Prepare and publish the containing Pack before offering installation."
      : tool === "aart_find_tools" &&
          outcome === "success" &&
          Array.isArray(result.tools) &&
          result.tools.length > 0 &&
          result.tools.every(
            (candidate) =>
              candidate !== null &&
              typeof candidate === "object" &&
              (candidate as Record<string, unknown>).source === "public",
          )
        ? "Install the selected result with its exact `installation.name`, `installation.version`, and `installation.contentHash`; review and approve that inert Pack before calling `aart_check_tool` on the installed tool."
      : computeNext(tool, outcome);
  return { ...result, next };
}
