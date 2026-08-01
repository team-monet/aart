// The 39-tool handler registry, including reuse-first local command,
// local/public Pack,
// workflow, and block discovery plus remote deploy/observation/governance —
// one real function per MCP tool
// name, shared verbatim with @aart/cli's commands (architecture's
// three-clients principle: CLI and MCP calling the same thing for the same
// thing).
import type { AartContext } from "../context.js";
import type { HandlerResult, ToolName } from "../response.js";
import { validateWorkflowHandler, registerWorkflowHandler } from "./authoring.js";
import { deployToRemoteHandler, deployWorkflowHandler, listWaitingRunsHandler, resumeRunHandler, triggerWorkflowHandler } from "./deployment.js";
import { findBlocksHandler, findWorkflowsHandler, getBlockHandler, getSchemaHandler, listBlocksHandler, proposeWorkflowHandler } from "./discovery.js";
import { createEvalFromCorrectionHandler, runEvalHandler } from "./evals.js";
import { getReportHandler, runWorkflowHandler, verifyHandler } from "./execution.js";
import { approveHandler, diffWorkflowHandler, promoteWorkflowHandler, recordCorrectionHandler, requestApprovalHandler } from "./governance.js";
import { remoteRunHandler, remoteRunsHandler, remoteStatusHandler, remoteWhyHandler } from "./remote-observability.js";
import { remoteApproveHandler } from "./remote-governance.js";
import { approvePackHandler, findPacksHandler, installPackHandler, listPacksHandler, preparePackHandler } from "./packs.js";
import { checkToolHandler, findToolsHandler, getToolRunHandler, listToolRunsHandler, registerToolHandler, runToolHandler } from "./local-tools.js";

export * from "./authoring.js";
export * from "./deployment.js";
export * from "./discovery.js";
export * from "./evals.js";
export * from "./execution.js";
export * from "./governance.js";
export * from "./remote-observability.js";
export * from "./remote-governance.js";
export * from "./packs.js";
export * from "./local-tools.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (ctx: AartContext, input: any) => Promise<HandlerResult>;

/** Every current tool, including A71's reuse-first workflow search, mapped to one real handler function. Both `tools/server.ts` (MCP dispatch) and `@aart/cli`'s commands call through THIS map, never a re-derived one. */
export const HANDLERS: Readonly<Record<ToolName, ToolHandler>> = {
  aart_find_tools: findToolsHandler,
  aart_register_tool: registerToolHandler,
  aart_check_tool: checkToolHandler,
  aart_run_tool: runToolHandler,
  aart_get_tool_run: getToolRunHandler,
  aart_list_tool_runs: listToolRunsHandler,
  aart_find_blocks: findBlocksHandler,
  aart_find_workflows: findWorkflowsHandler,
  aart_find_packs: findPacksHandler,
  aart_install_pack: installPackHandler,
  aart_list_packs: listPacksHandler,
  aart_approve_pack: approvePackHandler,
  aart_prepare_pack: preparePackHandler,
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
  aart_remote_status: remoteStatusHandler,
  aart_remote_why: remoteWhyHandler,
  aart_remote_runs: remoteRunsHandler,
  aart_remote_run: remoteRunHandler,
  aart_remote_approve: remoteApproveHandler,
};
