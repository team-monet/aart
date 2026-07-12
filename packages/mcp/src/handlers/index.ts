// The 22-tool handler registry (21 + D1's aart_deploy, AMENDMENTS.md A56) —
// one real function per MCP tool name, shared verbatim with @aart/cli's
// commands (architecture's three-clients principle: CLI and MCP calling the
// same thing for the same thing).
import type { AartContext } from "../context.js";
import type { HandlerResult, ToolName } from "../response.js";
import { validateWorkflowHandler, registerWorkflowHandler } from "./authoring.js";
import { deployToRemoteHandler, deployWorkflowHandler, listWaitingRunsHandler, resumeRunHandler, triggerWorkflowHandler } from "./deployment.js";
import { findBlocksHandler, getBlockHandler, getSchemaHandler, listBlocksHandler, proposeWorkflowHandler } from "./discovery.js";
import { createEvalFromCorrectionHandler, runEvalHandler } from "./evals.js";
import { getReportHandler, runWorkflowHandler, verifyHandler } from "./execution.js";
import { approveHandler, diffWorkflowHandler, promoteWorkflowHandler, recordCorrectionHandler, requestApprovalHandler } from "./governance.js";

export * from "./authoring.js";
export * from "./deployment.js";
export * from "./discovery.js";
export * from "./evals.js";
export * from "./execution.js";
export * from "./governance.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (ctx: AartContext, input: any) => Promise<HandlerResult>;

/** Every one of architecture §10.1's 21 tools plus D1's aart_deploy (AMENDMENTS.md A56), mapped to its real handler function. Both `tools/server.ts` (MCP dispatch) and `@aart/cli`'s commands call through THIS map, never a re-derived one. */
export const HANDLERS: Readonly<Record<ToolName, ToolHandler>> = {
  aart_find_blocks: findBlocksHandler,
  aart_get_block: getBlockHandler,
  aart_validate: validateWorkflowHandler,
  aart_register_block: registerWorkflowHandler,
  aart_run_workflow: runWorkflowHandler,
  aart_get_report: getReportHandler,
  aart_verify: verifyHandler,
  aart_approve: approveHandler,
  aart_request_approval: requestApprovalHandler,
  aart_record_correction: recordCorrectionHandler,
  aart_list_blocks: listBlocksHandler,
  aart_get_schema: getSchemaHandler,
  aart_propose_workflow: proposeWorkflowHandler,
  aart_diff_workflow: diffWorkflowHandler,
  aart_create_eval_from_correction: createEvalFromCorrectionHandler,
  aart_run_eval: runEvalHandler,
  aart_promote_workflow: promoteWorkflowHandler,
  aart_deploy_workflow: deployWorkflowHandler,
  aart_deploy: deployToRemoteHandler,
  aart_trigger_workflow: triggerWorkflowHandler,
  aart_list_waiting_runs: listWaitingRunsHandler,
  aart_resume_run: resumeRunHandler,
};
